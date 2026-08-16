import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, HOST, loadConfig } from "../../src/config.ts";
import { createApp, type HealthBody } from "../../src/daemon/app.ts";
import { openStore } from "../../src/db/store.ts";
import type { Store } from "../../src/db/store.ts";

// Read independently of `src/mcp/server.ts`, so an assertion cannot pass by importing its answer.
const manifest = (await Bun.file(new URL("../../package.json", import.meta.url)).json()) as {
  name: string;
  version: string;
};

const REVISION = "2026-07-28";
const TOKEN = "a-token-nobody-guesses";

const META = {
  "io.modelcontextprotocol/protocolVersion": REVISION,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "reviewzy-probe", version: "0" },
};

const stores: Store[] = [];
const tempDirs: string[] = [];

/** One disposable store per served app, each on its own temp file: `createApp` takes the daemon's store, so every probe app gets one that outlives the suite. */
function tempStore(env: Record<string, string> = {}): { config: Config; store: Store } {
  const dir = mkdtempSync(join(tmpdir(), "reviewzy-endpoint-test-"));
  tempDirs.push(dir);
  const config = loadConfig({ ...env, REVIEWZY_DB: join(dir, "reviewzy.db") });
  const store = openStore(config);
  stores.push(store);
  return { config, store };
}

// Port 0 lets the kernel pick, so the suite never collides with a daemon already running here.
// `loadConfig` floors the port at 1, so this config is deliberately desynchronized from the bind
// rather than a state a real boot reaches: the desync is what makes `configuredOrigin` never match,
// forcing the loopback branch of the allow-list to be what answers.
const serve = (env: Record<string, string>) => {
  const { config, store } = tempStore(env);
  const probeConfig: Config = {
    ...config,
    REVIEWZY_PORT: 0,
    baseUrl: env.REVIEWZY_BASE_URL ?? `http://${HOST}:0`,
  };
  return Bun.serve({ hostname: HOST, port: 0, fetch: createApp(probeConfig, store).fetch });
};

const open = serve({});
const guarded = serve({ REVIEWZY_TOKEN: TOKEN });
const proxied = serve({ REVIEWZY_BASE_URL: "https://reviewzy.example" });

// The arrangement every real deployment runs in: `REVIEWZY_BASE_URL` unset, so `baseUrl` carries
// the port the daemon bound. Bound first and reloaded, because the kernel picks the port and
// `loadConfig` will not accept 0 to ask for one.
const native = serve({});
const nativeStore = tempStore();
native.reload({
  fetch: createApp(
    {
      ...nativeStore.config,
      REVIEWZY_PORT: boundPort(native),
      baseUrl: `http://${HOST}:${boundPort(native)}`,
    },
    nativeStore.store,
  ).fetch,
});

afterAll(() => {
  void open.stop(true);
  void guarded.stop(true);
  void proxied.stop(true);
  void native.stop(true);
  for (const store of stores) store.close();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

/** `port` is optional in the type (a unix-socket server has none), and every server here is a tcp bind. */
function boundPort(server: ReturnType<typeof serve>): number {
  const { port } = server;
  if (port === undefined) throw new Error("the probe server bound no tcp port");
  return port;
}

type Probe = {
  server?: ReturnType<typeof serve>;
  method?: string;
  path?: string;
  rpc?: string;
  id?: number | string;
  meta?: unknown;
  headers?: Record<string, string>;
  /** Overrides the `Mcp-Method` header the probe would otherwise derive from `rpc`. */
  mcpMethod?: string | null;
  /** Extra `params` keys alongside `_meta`. */
  params?: Record<string, unknown>;
  /** Sent verbatim in place of a well-formed JSON-RPC envelope. */
  rawBody?: string;
};

type Body = {
  jsonrpc: string;
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
};

const BODYLESS = new Set(["GET", "HEAD", "DELETE"]);

/** The OAuth challenge body the 401 rung borrows from `bearerAuthChallengeResponse`. */
type ChallengeBody = { error: string; error_description: string; jsonrpc?: never };

/** Every probe goes over real HTTP against a really-bound server. */
async function probe(
  options: Probe = {},
): Promise<{ status: number; headers: Headers; body: Body | undefined }> {
  const server = options.server ?? open;
  const method = options.method ?? "POST";
  const rpc = options.rpc ?? "tools/list";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(options.mcpMethod === null ? {} : { "mcp-method": options.mcpMethod ?? rpc }),
    ...options.headers,
  };

  const body =
    options.rawBody ??
    JSON.stringify({
      jsonrpc: "2.0",
      id: options.id ?? 1,
      method: rpc,
      params: { ...options.params, _meta: "meta" in options ? options.meta : META },
    });

  const response = await fetch(`http://${HOST}:${boundPort(server)}${options.path ?? "/mcp"}`, {
    method,
    headers,
    ...(BODYLESS.has(method) ? {} : { body }),
  });

  // A HEAD, a 202, or any body-less refusal has nothing to parse, and throwing here would read as a
  // harness crash rather than as the assertion it replaced.
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? (JSON.parse(text) as Body) : undefined,
  };
}

describe("protocol conformance", () => {
  test("server/discover names the daemon, its instructions, and its capabilities", async () => {
    const { status, body } = await probe({ rpc: "server/discover" });
    expect(status).toBe(200);

    const result = body?.result;
    expect(result).toBeDefined();
    expect(result?.resultType).toBe("complete");
    expect(result?.supportedVersions).toEqual([REVISION]);
    // `capabilities: {}` would still answer a forced `tools/list`: registering a tool installs the
    // handler regardless of the key. The key still must be present — a dropped key is merged back
    // with `listChanged: true`, advertising a subscription v1 has no stream to carry — which is
    // also why the flag is asserted by value, not by presence. `resources` joined the surface with
    // the style-guide resource (queue task 7).
    expect(result?.capabilities).toEqual({
      tools: { listChanged: false },
      resources: { listChanged: false },
    });
    expect(result?.instructions).toBeString();
    expect(result?.instructions as string).toContain("reviewzy");

    const meta = result?._meta as Record<string, { name: string; version: string }>;
    expect(meta["io.modelcontextprotocol/serverInfo"]).toEqual({
      name: manifest.name,
      version: manifest.version,
    });
  });

  // Task 6 registered `list_entries`, so the pin is "exactly the registered set" rather than the
  // empty list it was. Tasks 8, 9, and 10 added `fetch_approved`, `mark_applied`, and
  // `await_approved` the same way. `test/mcp/file-entries.test.ts`, `test/mcp/list-entries.test.ts`,
  // and `test/mcp/fetch-approved.test.ts` own the tools' own behavior.
  test("tools/list answers exactly the registered tools, file_entries, list_entries, fetch_approved, mark_applied, and await_approved", async () => {
    const { status, body } = await probe({ rpc: "tools/list" });
    expect(status).toBe(200);
    const tools = (body?.result?.tools ?? []) as { name: string }[];
    expect(tools.map((tool) => tool.name)).toEqual([
      "file_entries",
      "list_entries",
      "fetch_approved",
      "mark_applied",
      "await_approved",
    ]);
    expect(body?.result?.resultType).toBe("complete");
  });

  test("both cacheable results carry a usable ttlMs and cacheScope", async () => {
    for (const rpc of ["server/discover", "tools/list"]) {
      const { body } = await probe({ rpc });
      // A `ttlMs` of 0 is spec-legal and means "immediately stale", which is not a cache hint.
      expect(body?.result?.ttlMs).toBeGreaterThan(0);
      expect(body?.result?.cacheScope).toBe("private");
    }
  });

  test("Mcp-Session-Id and Last-Event-ID are ignored, and no session id comes back", async () => {
    const response = await fetch(`http://${HOST}:${boundPort(open)}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-method": "server/discover",
        "mcp-session-id": "a-session-that-does-not-exist",
        "last-event-id": "17",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "server/discover",
        params: { _meta: META },
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeNull();
  });
});

describe("the validation ladder", () => {
  test("a foreign Origin is 403", async () => {
    const { status, body } = await probe({ headers: { origin: "https://evil.example" } });
    expect(status).toBe(403);
    expect(body?.error?.code).toBe(-32000);
    expect(body?.error?.message).toContain("Origin");
  });

  test("a refused Origin is echoed back truncated, never whole", async () => {
    const huge = `https://${"a".repeat(400)}.example`;
    const { status, body } = await probe({ headers: { origin: huge } });
    expect(status).toBe(403);
    expect(body?.error?.message.length).toBeLessThan(150);
  });

  test("a loopback origin on the daemon's own port but another scheme is 403", async () => {
    const { status } = await probe({
      headers: { origin: `https://127.0.0.1:${boundPort(open)}` },
    });
    expect(status).toBe(403);
  });

  test("an unparseable Origin is 403", async () => {
    const { status } = await probe({ headers: { origin: "null" } });
    expect(status).toBe(403);
  });

  test("an absent Origin is allowed, since curl and stdio clients send none", async () => {
    const { status } = await probe({ rpc: "server/discover" });
    expect(status).toBe(200);
  });

  test("the daemon's own loopback origin is allowed", async () => {
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
      const { status } = await probe({
        rpc: "server/discover",
        headers: { origin: `http://${host}:${boundPort(open)}` },
      });
      expect(status).toBe(200);
    }
  });

  test("a loopback origin on another port is 403", async () => {
    const { status } = await probe({
      headers: { origin: `http://127.0.0.1:${boundPort(open) + 1}` },
    });
    expect(status).toBe(403);
  });

  // The other fixtures desynchronize the config port from the bind, which is what makes their
  // loopback branch load-bearing. Here they agree, as they do in every real deployment, and the two
  // branches of the allow-list overlap completely: this pins the observable rather than a branch.
  // The `configuredOrigin` branch alone is pinned by the reverse-proxy probe below.
  test("the default configuration allows the daemon's own dashboard origin", async () => {
    const { status } = await probe({
      server: native,
      rpc: "server/discover",
      headers: { origin: `http://${HOST}:${boundPort(native)}` },
    });
    expect(status).toBe(200);
  });

  test("the configured base url is an allowed origin", async () => {
    const { status } = await probe({
      server: proxied,
      rpc: "server/discover",
      headers: { origin: "https://reviewzy.example" },
    });
    expect(status).toBe(200);
  });

  test("the configured base url does not widen the allow-list for other servers", async () => {
    const { status } = await probe({ headers: { origin: "https://reviewzy.example" } });
    expect(status).toBe(403);
  });

  // The SDK answers GET and DELETE with a 405 of its own, so status alone cannot tell the gate's
  // refusal from the fall-through. `Allow` is the gate's, and RFC 9110 requires it on a 405 anyway.
  test("GET on the endpoint is 405 and names the one method it takes", async () => {
    const { status, headers, body } = await probe({ method: "GET" });
    expect(status).toBe(405);
    expect(headers.get("allow")).toBe("POST");
    expect(body?.error?.code).toBe(-32000);
    expect(body?.error?.message).toContain("Method not allowed");
  });

  test("DELETE on the endpoint is 405 and names the one method it takes", async () => {
    const { status, headers } = await probe({ method: "DELETE" });
    expect(status).toBe(405);
    expect(headers.get("allow")).toBe("POST");
  });

  // The SDK answers GET and DELETE with a 405 of its own but nothing else, so a verb it never
  // handles is what proves the gate refuses everything but POST rather than a listed pair.
  test("PUT on the endpoint is 405 too", async () => {
    const { status, headers, body } = await probe({ method: "PUT" });
    expect(status).toBe(405);
    expect(headers.get("allow")).toBe("POST");
    expect(body?.error?.code).toBe(-32000);
  });

  test("a foreign Origin outranks a GET", async () => {
    const { status } = await probe({ method: "GET", headers: { origin: "https://evil.example" } });
    expect(status).toBe(403);
  });

  test("a request whose _meta is missing is -32602 at 400", async () => {
    // The header carries the revision claim the body no longer does. Without one, the request has
    // claimed no era at all and is refused a rung earlier, by the legacy probe below.
    const { status, body } = await probe({
      meta: undefined,
      headers: { "mcp-protocol-version": REVISION },
    });
    expect(status).toBe(400);
    expect(body?.error?.code).toBe(-32602);
  });

  test("a request whose _meta omits clientCapabilities is -32602 at 400", async () => {
    const { status, body } = await probe({
      meta: { "io.modelcontextprotocol/protocolVersion": REVISION },
    });
    expect(status).toBe(400);
    expect(body?.error?.code).toBe(-32602);
  });

  // The two halves of shape 3: an `_meta` object with no revision claim. Which rung catches it
  // depends on where the era claim comes from — nowhere (headerless) means the revision rung fires
  // with the same message as a missing `_meta`; the header carrying it moves the refusal to the
  // envelope rung. The pair documents which surface supplies the claim.
  test("an _meta with no revision and no header is -32022, indistinguishable from no _meta", async () => {
    const { status, body } = await probe({
      meta: { "io.modelcontextprotocol/clientCapabilities": {} },
    });
    expect(status).toBe(400);
    expect(body?.error?.code).toBe(-32022);
    expect((body?.error?.data as { supported: string[] }).supported).toEqual([REVISION]);
  });

  test("an _meta with no revision but a version header is -32602 naming the missing key", async () => {
    const { status, body } = await probe({
      meta: { "io.modelcontextprotocol/clientCapabilities": {} },
      headers: { "mcp-protocol-version": REVISION },
    });
    expect(status).toBe(400);
    expect(body?.error?.code).toBe(-32602);
    expect(body?.error?.message).toContain("io.modelcontextprotocol/protocolVersion");
  });

  test("a request claiming no revision at all is refused as legacy", async () => {
    const { status, body } = await probe({ meta: undefined });
    expect(status).toBe(400);
    expect(body?.error?.code).toBe(-32022);
  });

  test("an Mcp-Method header disagreeing with the body is -32020 at 400", async () => {
    const { status, body } = await probe({ rpc: "tools/list", mcpMethod: "server/discover" });
    expect(status).toBe(400);
    expect(body?.error?.code).toBe(-32020);
  });

  test("a missing Mcp-Method header is -32020 at 400", async () => {
    const { status, body } = await probe({ mcpMethod: null });
    expect(status).toBe(400);
    expect(body?.error?.code).toBe(-32020);
  });

  test("an MCP-Protocol-Version header disagreeing with the body is -32020 at 400", async () => {
    const { status, body } = await probe({ headers: { "mcp-protocol-version": "2025-11-25" } });
    expect(status).toBe(400);
    expect(body?.error?.code).toBe(-32020);
  });

  test("an unsupported protocol revision is -32022 and names what is supported", async () => {
    const { status, body } = await probe({
      meta: { ...META, "io.modelcontextprotocol/protocolVersion": "1900-01-01" },
    });
    expect(status).toBe(400);
    expect(body?.error?.code).toBe(-32022);
    expect((body?.error?.data as { supported: string[] }).supported).toEqual([REVISION]);
  });

  test("a legacy initialize handshake is refused with the revisions this daemon speaks", async () => {
    const response = await fetch(`http://${HOST}:${boundPort(open)}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-method": "initialize" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "x", version: "0" } },
      }),
    });
    const body = (await response.json()) as Body;
    expect(body?.error?.code).toBe(-32022);
    expect((body?.error?.data as { supported: string[] }).supported).toEqual([REVISION]);
  });

  test("an unknown rpc method is -32601 at 404", async () => {
    const { status, body } = await probe({ rpc: "reviewzy/nothing" });
    expect(status).toBe(404);
    expect(body?.error?.code).toBe(-32601);
  });

  test("a string request id round-trips onto the error", async () => {
    const { body } = await probe({ rpc: "reviewzy/nothing", id: "abc-1" });
    expect(body?.id).toBe("abc-1");
  });

  // Characterization, not a preference: `docs/mcp-contract.md` files malformed `_meta` under
  // -32602, and the SDK's own validation ladder runs its jsonrpc-shape rung ahead of its envelope
  // rung, so a non-object `_meta` is refused before anything looks at the envelope. Pinned so an
  // SDK bump that reorders the ladder reddens here instead of drifting silently.
  test("a non-object _meta is -32600 at 400, ahead of the envelope rung", async () => {
    for (const malformed of ['"nope"', "[]", "null", "42"]) {
      const { status, body } = await probe({
        rawBody: `{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":${malformed}}}`,
      });
      expect(status).toBe(400);
      expect(body?.error?.code).toBe(-32600);
    }
  });

  test("a missing Mcp-Name header on a named call is -32020 at 400", async () => {
    const { status, body } = await probe({
      rpc: "tools/call",
      params: { name: "file_entries", arguments: {} },
    });
    expect(status).toBe(400);
    expect(body?.error?.code).toBe(-32020);
  });

  test("an Mcp-Name header disagreeing with params.name is -32020 at 400", async () => {
    const { status, body } = await probe({
      rpc: "tools/call",
      params: { name: "file_entries", arguments: {} },
      headers: { "mcp-name": "list_entries" },
    });
    expect(status).toBe(400);
    expect(body?.error?.code).toBe(-32020);
  });

  // A malformed body must never escape as a 500 with a stack trace.
  test("a body that is not JSON is -32700 at 400", async () => {
    for (const rawBody of ["{not json", ""]) {
      const { status, body } = await probe({ rawBody });
      expect(status).toBe(400);
      expect(body?.error?.code).toBe(-32700);
    }
  });

  test("a non-JSON content type is 415", async () => {
    const { status, body } = await probe({ headers: { "content-type": "text/plain" } });
    expect(status).toBe(415);
    expect(body?.error?.code).toBe(-32000);
  });

  test("a JSON-RPC batch is refused, since the revision dropped them", async () => {
    const { status, body } = await probe({
      rawBody: `[{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":${JSON.stringify(META)}}}]`,
    });
    expect(status).toBe(400);
    expect(body?.error?.code).toBe(-32600);
  });
});

describe("the optional bearer token", () => {
  const bearer = (value: string) => ({ authorization: value });

  test("no token is required when REVIEWZY_TOKEN is unset", async () => {
    const { status } = await probe({ rpc: "server/discover" });
    expect(status).toBe(200);
  });

  // The 401 mirrors the reference implementation for this exact condition: the OAuth challenge
  // body `bearerAuthChallengeResponse` emits, not a JSON-RPC envelope. Built from the SDK's own
  // exports in production, so pinning the observable here is what would catch a drift.
  test("a missing bearer token is a 401 OAuth challenge, not a JSON-RPC error", async () => {
    const { status, headers, body } = await probe({ server: guarded, rpc: "server/discover" });
    expect(status).toBe(401);
    const challenge = body as unknown as ChallengeBody;
    expect(challenge.error).toBe("invalid_token");
    expect(challenge.error_description).toBeString();
    expect(challenge.jsonrpc).toBeUndefined();
    expect(headers.get("www-authenticate")?.startsWith('Bearer error="invalid_token"')).toBe(true);
  });

  test("a wrong bearer token carries the same challenge", async () => {
    const { status, headers } = await probe({
      server: guarded,
      rpc: "server/discover",
      headers: bearer("Bearer not-the-token"),
    });
    expect(status).toBe(401);
    expect(headers.get("www-authenticate")?.startsWith('Bearer error="invalid_token"')).toBe(true);
  });

  test("a prefix of the token is 401", async () => {
    const { status } = await probe({
      server: guarded,
      rpc: "server/discover",
      headers: bearer(`Bearer ${TOKEN.slice(0, -1)}`),
    });
    expect(status).toBe(401);
  });

  test("a malformed Authorization header is 401, never the 400 of a header mismatch", async () => {
    const { status } = await probe({
      server: guarded,
      rpc: "server/discover",
      headers: bearer(TOKEN),
    });
    expect(status).toBe(401);
  });

  test("the right bearer token is served", async () => {
    const { status, body } = await probe({
      server: guarded,
      rpc: "server/discover",
      headers: bearer(`Bearer ${TOKEN}`),
    });
    expect(status).toBe(200);
    expect(body?.result?.resultType).toBe("complete");
  });

  test("the bearer scheme is matched case-insensitively, per RFC 7235", async () => {
    const { status } = await probe({
      server: guarded,
      rpc: "server/discover",
      headers: bearer(`bearer ${TOKEN}`),
    });
    expect(status).toBe(200);
  });

  test("a GET outranks a missing bearer token", async () => {
    const { status } = await probe({ server: guarded, method: "GET" });
    expect(status).toBe(405);
  });

  test("a bad Origin outranks a valid bearer token", async () => {
    const { status } = await probe({
      server: guarded,
      headers: { ...bearer(`Bearer ${TOKEN}`), origin: "https://evil.example" },
    });
    expect(status).toBe(403);
  });

  test("a missing bearer token outranks a malformed body", async () => {
    const { status } = await probe({ server: guarded, meta: undefined });
    expect(status).toBe(401);
  });
});

// `/health` tests live here rather than `test/daemon.test.ts`: that file is another lane's, and the
// `serve`/`probe` harness already speaks origin headers.
describe("the origin gate covers /health", () => {
  test("the shim's probe carries no Origin and is served", async () => {
    const { status, body } = await probe({ path: "/health", method: "GET" });
    expect(status).toBe(200);
    expect((body as unknown as HealthBody).name).toBe(manifest.name);
    expect((body as unknown as HealthBody).pid).toBe(process.pid);
  });

  test("a rebound page reading /health is 403", async () => {
    const { status } = await probe({
      path: "/health",
      method: "GET",
      headers: { origin: "https://evil.example" },
    });
    expect(status).toBe(403);
  });

  test("the daemon's own loopback origin is served on /health", async () => {
    const { status } = await probe({
      path: "/health",
      method: "GET",
      headers: { origin: `http://127.0.0.1:${boundPort(open)}` },
    });
    expect(status).toBe(200);
  });
});
