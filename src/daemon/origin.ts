import type { MiddlewareHandler } from "hono";
import type { Config } from "../config.ts";

/**
 * A refusal made before the SDK sees the request, in the same shape `src/mcp/route.ts` uses: the
 * daemon family answers with one JSON-RPC error style, so a client special-casing a refusal sees
 * the shape it already handles.
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
 * version and a pid, which is exactly the disclosure the check exists for, and the dashboard sits
 * behind it too. The mcp rungs only re-check what is theirs to check.
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
