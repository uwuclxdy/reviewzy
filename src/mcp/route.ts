import {
  bearerAuthChallengeResponse,
  createMcpHandler,
  OAuthError,
  OAuthErrorCode,
} from "@modelcontextprotocol/server";
import type { MiddlewareHandler } from "hono";
import type { Hono } from "hono";
import { timingSafeEqual } from "hono/utils/buffer";
import type { Config } from "../config.ts";
import { createMcpServer } from "./server.ts";

/** One endpoint, POST only. `docs/mcp-contract.md` freezes the surface. */
const MCP_PATH = "/mcp";

/**
 * A refusal made before the SDK sees the request. `-32000` matches the SDK's own 403 and 405 down
 * to the message string, which is why those two rungs use it.
 */
function refuse(status: 403 | 405, message: string, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * Answers "was this request issued by a page the daemon serves", the DNS-rebinding defence the
 * design makes unconditional. An absent `Origin` passes: the shim, curl, and stdio clients send
 * none, and only a browser sends one at all.
 *
 * The loopback set is matched against the port THIS request was addressed to. That equals
 * `config.REVIEWZY_PORT` in every configuration `loadConfig` accepts, since the schema floors the
 * port at 1 and the daemon binds it verbatim; reading it from the request keeps the gate off a
 * config field rather than buying a safety property. A browser cannot forge that port either way,
 * since reaching the daemon means addressing the port it bound.
 */
function originAllowed(origin: string, requestUrl: URL, configuredOrigin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false; // Unparseable, the literal `null` of an opaque browser context included.
  }
  if (parsed.origin === configuredOrigin) return true;
  // The scheme is compared too, or a default-port `https://127.0.0.1` matches a default-port http
  // daemon: both sides normalise to an empty `port`.
  return (
    parsed.protocol === requestUrl.protocol &&
    (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]") &&
    parsed.port === requestUrl.port
  );
}

/**
 * The DNS-rebinding gate, unconditional for every route the app serves: `/health` hands out a
 * version and a pid, which is exactly the disclosure the check exists for, and the dashboard will
 * sit behind it too. The mcp rungs below only re-check what is theirs to check.
 */
export function originGate(config: Config): MiddlewareHandler {
  const configuredOrigin = new URL(config.baseUrl).origin;
  return async (c, next) => {
    const origin = c.req.header("Origin");
    if (origin !== undefined && !originAllowed(origin, new URL(c.req.url), configuredOrigin)) {
      // Echoed so a developer wiring a browser client sees what was refused, truncated because the
      // value is attacker-controlled and unbounded by nature.
      return refuse(403, `Invalid Origin: ${origin.slice(0, 100)}`);
    }
    return next();
  };
}

/**
 * `hono/bearer-auth` answers a malformed `Authorization` header with 400, which collides with the
 * `-32020` header-mismatch rung below this one; every credential failure here is one 401 instead.
 */
async function tokenAccepted(header: string | undefined, token: string): Promise<boolean> {
  // RFC 7235 makes the scheme case-insensitive.
  const presented = /^bearer +(.+)$/i.exec(header ?? "")?.[1];
  if (presented === undefined) return false;
  return timingSafeEqual(token, presented);
}

/**
 * The reference implementation's own 401: an OAuth challenge body plus `WWW-Authenticate`, the
 * shape `bearerAuthChallengeResponse` emits. Built from its own exports so the two cannot drift.
 */
function authRequired(description: string): Response {
  return bearerAuthChallengeResponse(new OAuthError(OAuthErrorCode.InvalidToken, description));
}

/**
 * Mounts the stateless MCP endpoint. The checks run in a pinned order, and the order is the
 * contract: a request refused by a lower rung must never reveal that a higher one would have
 * passed. Everything past the gate is the SDK's: `_meta` validation, header-versus-body agreement,
 * revision negotiation, and the method registry.
 */
export function mountMcp(app: Hono, config: Config): void {
  // `legacy: 'reject'` is the whole of the revision guard, so the endpoint serves only the one
  // revision `docs/mcp-contract.md` freezes. `supportedProtocolVersions` on the server cannot do
  // it and is deliberately unset: the SDK's `installDiscoverHandler` unions its served modern
  // revisions back into that array regardless of what was passed, and on a legacy leg
  // (`Server._oninitialize`) the list only picks WHICH 2025-era revision to answer with —
  // `legacyVersions[0] ?? LATEST_PROTOCOL_VERSION`, and `LATEST_PROTOCOL_VERSION` is
  // `"2025-11-25"`. A modern-only list empties `legacyVersions`, which is exactly what reaches
  // that hardcoded fallback, so narrowing it is what would serve one.
  const handler = createMcpHandler(() => createMcpServer(), { legacy: "reject" });

  // The `Origin` rung is `originGate`, mounted app-wide in `createApp`; it runs before this
  // handler, so the pinned order (origin, then method, then credential) holds without a repeat of
  // the check here.
  app.all(MCP_PATH, async (c) => {
    if (c.req.method !== "POST") {
      return refuse(405, "Method not allowed.", { allow: "POST" });
    }

    const token = config.REVIEWZY_TOKEN;
    if (token !== undefined && !(await tokenAccepted(c.req.header("Authorization"), token))) {
      return authRequired("REVIEWZY_TOKEN is set; a bearer token is required");
    }

    return handler.fetch(c.req.raw);
  });
}
