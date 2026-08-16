import {
  bearerAuthChallengeResponse,
  OAuthError,
  OAuthErrorCode,
} from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { timingSafeEqual } from "hono/utils/buffer";
import type { Config } from "../config.ts";
import type { Store } from "../db/store.ts";
import { mountDashboard } from "../dashboard/mount.ts";
import { mountMcp } from "../mcp/route.ts";
import { originGate } from "./origin.ts";
import { NAME, VERSION } from "../version.ts";

export type HealthBody = {
  name: string;
  version: string;
  pid: number;
  /** One random value per boot; the shim records it in the lockfile and adoption requires it to match, so a port spoofed by a process that cannot read the lockfile can never be adopted. */
  nonce: string;
  startedAt: string;
};

/** The drain response must reach the caller before the server stops serving; the shim that asked waits out this beat and then polls pid liveness, so the exact value is not load-bearing. */
const DRAIN_FLUSH_MS = 25;

/**
 * A refusal made before the SDK sees the request, in the same shape `src/mcp/route.ts` uses: the
 * daemon family answers with one JSON-RPC error style, so a client special-casing a refusal sees
 * the shape it already handles.
 */
function refuse(status: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * The same credential rule `/mcp` applies (`docs/mcp-contract.md` auth row), duplicated here rather
 * than exported from `src/mcp/route.ts` because that file owns the mcp surface alone. A malformed
 * `Authorization` header is one 401, never a 400, so a missing token reads differently from a
 * broken one.
 */
async function tokenAccepted(header: string | undefined, token: string): Promise<boolean> {
  const presented = /^bearer +(.+)$/i.exec(header ?? "")?.[1];
  if (presented === undefined) return false;
  return timingSafeEqual(token, presented);
}

/**
 * Serves the daemon's routes. `onDrain` is the shutdown the drain route hands off to (stop
 * in-flight, close the store, exit); tests omit it to observe the route without ending their own
 * process, which is also why the route never exits on its own.
 */
export function createApp(
  config: Config,
  store: Store,
  startedAt: Date = new Date(),
  onDrain?: () => void | Promise<void>,
): Hono {
  const app = new Hono();
  let draining = false;
  const nonce = crypto.randomUUID();

  // App-wide because `docs/design.md` makes Origin validation unconditional rather than per-route:
  // `/health` hands out a pid and a version, and the dashboard serves a browser. An absent `Origin`
  // passes, so the shim's liveness probe is unaffected; only a browser sends one at all.
  app.use(originGate(config));

  // Mounted ahead of the mcp endpoint so a refusal here never reaches the SDK: once draining has
  // begun, the daemon is going away, and the honest answer to a new request is "try again once a
  // new daemon answers /health".
  app.use(async (c, next) => {
    if (draining && c.req.method === "POST" && c.req.path === "/mcp") {
      // A notification has no id, and JSON-RPC 2.0 forbids answering one: it gets a bare empty 503,
      // which the shim's empty-body rung turns into silence (a transport error is dropped for
      // notifications). The clone keeps the body intact for the SDK rungs below (not reached here).
      let bodyText = "";
      try {
        bodyText = await c.req.raw.clone().text();
      } catch {
        // Unreadable: treated as a request whose id could not be determined.
      }
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        // Not JSON: `null` is the right answer for a request whose id could not be determined.
      }
      if (parsed !== null && typeof parsed === "object" && !("id" in parsed)) {
        return new Response(null, { status: 503, headers: { "retry-after": "1" } });
      }

      // Echo the request's own id rather than `null`: the frame this answers is well-formed and its
      // id is in the body, so the client must be able to correlate the refusal.
      const id = parsed !== null && typeof parsed === "object" ? (parsed as { id?: unknown }).id : null;
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "daemon is draining; retry once a new daemon answers /health" }, id }),
        {
          status: 503,
          headers: { "content-type": "application/json", "retry-after": "1" },
        },
      );
    }
    return next();
  });

  app.get("/health", (c) =>
    c.json<HealthBody>({
      name: NAME,
      version: VERSION,
      pid: process.pid,
      nonce,
      startedAt: startedAt.toISOString(),
    }),
  );

  // POST /drain: loopback-only by construction (the daemon binds 127.0.0.1 unconditionally), and
  // behind the same optional bearer token as `/mcp`. Idempotent: a second drain while draining gets
  // the same answer rather than a second shutdown. The hook runs after a short beat so this
  // response flushes before the server stops accepting.
  app.all("/drain", async (c) => {
    if (c.req.method !== "POST") {
      return refuse(405, "Method not allowed.", { allow: "POST" });
    }

    const token = config.REVIEWZY_TOKEN;
    if (token !== undefined && !(await tokenAccepted(c.req.header("Authorization"), token))) {
      return bearerAuthChallengeResponse(
        new OAuthError(OAuthErrorCode.InvalidToken, "REVIEWZY_TOKEN is set; a bearer token is required"),
      );
    }

    if (!draining) {
      draining = true;
      // Long-poll responses must flush while the server still serves: an in-flight `await_approved`
      // would otherwise hold this response open past `stop(false)`'s patience and get killed with
      // nothing to show the caller, which then waits out its whole timeout against a dead daemon.
      store.resolveInFlightWaiters();
      if (onDrain !== undefined) {
        setTimeout(() => {
          void Promise.resolve(onDrain()).catch((error: unknown) => {
            console.error(`reviewzy: drain failed: ${(error as Error).message}`);
            process.exit(1);
          });
        }, DRAIN_FLUSH_MS);
      }
    }
    return c.json({ status: "draining" });
  });

  mountMcp(app, config, store);
  mountDashboard(app, config, store);

  return app;
}
