import {
  bearerAuthChallengeResponse,
  createMcpHandler,
  OAuthError,
  OAuthErrorCode,
} from "@modelcontextprotocol/server";
import type { Hono } from "hono";
import { timingSafeEqual } from "hono/utils/buffer";
import type { Config } from "../config.ts";
import type { Store } from "../db/store.ts";
import { Notifier } from "../notify.ts";
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
// The default notifier serves direct mounts (tests): built over the same config `createApp` uses,
// so a mount with no transports armed stays silent exactly like the daemon's.
export function mountMcp(
  app: Hono,
  config: Config,
  store: Store,
  notifier: Notifier = new Notifier({ config, baseUrl: config.baseUrl }),
): void {
  // The native surface is the one revision `docs/mcp-contract.md` freezes, but `legacy: 'reject'`
  // locked out the claude harness fleet, whose mcp client negotiates `2025-11-25` (measured
  // 2026-08-21: 2.1.238 sends a legacy initialize and reads the refusal as a dead server).
  // `legacy: 'stateless'` is the SDK default and answers 2025-era traffic from the same factory
  // per request, so both legs stay stateless and no session is minted on either one.
  // The store is the daemon's own open handle (`startDaemon` opens it before the port binds), so
  // every tool call writes through the one connection the daemon will close on shutdown.
  const handler = createMcpHandler(() => createMcpServer(config, store, notifier), { legacy: "stateless" });

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
