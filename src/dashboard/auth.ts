import { timingSafeEqual } from "hono/utils/buffer";

/** The one session cookie: a signed payload, so the daemon needs no server-side session store. */
export const SESSION_COOKIE = "reviewzy_session";

/**
 * The signed payload. A session carries no data, only proof the password was entered: the signing
 * key is derived from the password itself, so rotating the password invalidates every outstanding
 * session, and the payload is fixed because there is nothing else to carry.
 */
const SESSION_PAYLOAD = "reviewzy-session-v1";

/** The payload's base64url spelling, which is what the cookie actually carries. */
const ENCODED_PAYLOAD = Buffer.from(SESSION_PAYLOAD, "utf8").toString("base64url");

/**
 * The cookie's pinned attributes: HttpOnly, SameSite=Strict, and browser-session (no Max-Age on the
 * set). No Secure: the daemon serves plain loopback http only (the docs/design.md posture), where a
 * Secure cookie would never be sent at all.
 */
const SET_COOKIE_ATTRS = "HttpOnly; SameSite=Strict; Path=/";

/** The dashboard's session auth: sign and verify a cookie, and check the login password. */
export type SessionAuth = {
  readonly enabled: boolean;
  /** The cookie value for a fresh session: the payload and its HMAC, base64url halves joined by a dot. */
  sign(): Promise<string>;
  /** Whether the Cookie header holds a valid signed session. A forged or malformed cookie is absent, never an error. */
  accept(cookieHeader: string | undefined): Promise<boolean>;
  /** The timing-safe password check behind POST /login. */
  acceptPassword(presented: string): Promise<boolean>;
  /** The Set-Cookie header that establishes the session. */
  setCookieHeader(value: string): string;
  /** The Set-Cookie header that ends the session. */
  clearCookieHeader(): string;
};

/**
 * The dashboard's session auth. Disabled means no password was set: the dashboard stays open and
 * mounts no auth surface at all, so the unset mode is byte-identical to today.
 */
export function createSessionAuth(password: string | undefined): SessionAuth {
  const enabled = password !== undefined;
  const secret = password;

  // The key is sha256(password), derived once and memoized. No boot salt: sessions must survive a
  // daemon restart and the shim's upgrade drain, and the password itself is the only secret.
  let keyPromise: Promise<CryptoKey> | undefined;
  const key = (): Promise<CryptoKey> => {
    keyPromise ??= (async () => {
      // Unreachable: `accept` refuses before `key` when disabled, and `sign` only runs after a
      // password check passed. Fail loudly if a future caller breaks that order.
      if (secret === undefined) throw new Error("reviewzy: session key derived while auth is disabled");
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
      return crypto.subtle.importKey("raw", digest, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    })();
    return keyPromise;
  };

  const sign = async (): Promise<string> => {
    const signature = await crypto.subtle.sign("HMAC", await key(), new TextEncoder().encode(SESSION_PAYLOAD));
    return `${ENCODED_PAYLOAD}.${Buffer.from(signature).toString("base64url")}`;
  };

  const accept = async (cookieHeader: string | undefined): Promise<boolean> => {
    if (!enabled) return false;
    const value = cookieValue(cookieHeader, SESSION_COOKIE);
    if (value === undefined) return false;
    const dot = value.indexOf(".");
    if (dot === -1) return false;
    if (value.slice(0, dot) !== ENCODED_PAYLOAD) return false;
    const presented = value.slice(dot + 1);
    if (presented === "") return false;
    const signature = await crypto.subtle.sign("HMAC", await key(), new TextEncoder().encode(SESSION_PAYLOAD));
    return timingSafeEqual(Buffer.from(signature).toString("base64url"), presented);
  };

  const acceptPassword = async (presented: string): Promise<boolean> => {
    if (secret === undefined || presented === "") return false;
    return timingSafeEqual(secret, presented);
  };

  return {
    enabled,
    sign,
    accept,
    acceptPassword,
    setCookieHeader: (value: string) => `${SESSION_COOKIE}=${value}; ${SET_COOKIE_ATTRS}`,
    clearCookieHeader: () => `${SESSION_COOKIE}=; ${SET_COOKIE_ATTRS}; Max-Age=0`,
  };
}

/** The named cookie's value from a Cookie header, or undefined. First match wins; surrounding quotes are stripped. */
function cookieValue(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
    return value;
  }
  return undefined;
}

/**
 * A login's `next` destination: only a local path is honored (starts with `/`, not `//`, no control
 * characters, no backslash, bounded length), so a crafted value can never redirect the browser off
 * the dashboard or split the Location header. The backslash is rejected because the URL parser
 * rewrites it to a slash, which would turn `/\evil.example` into the off-dashboard authority
 * `evil.example`; the check runs on the decoded value, so every encoding arrives as the same
 * backslash and is rejected the same way. Anything else means the list.
 */
export function safeNext(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  if (raw.length > 2048) return undefined;
  if (!raw.startsWith("/") || raw.startsWith("//")) return undefined;
  if (raw.includes("\\")) return undefined;
  if (/[\x00-\x1f\x7f]/.test(raw)) return undefined;
  return raw;
}
