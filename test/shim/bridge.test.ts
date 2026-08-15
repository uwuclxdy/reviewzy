import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.ts";
import { startDaemon } from "../../src/daemon/main.ts";
import { forwardLine } from "../../src/shim/main.ts";

const REVISION = "2026-07-28";
const TOKEN = "a-token-nobody-guesses";

const meta = {
  "io.modelcontextprotocol/protocolVersion": REVISION,
  "io.modelcontextprotocol/clientCapabilities": {},
};

const discover = (id: number | string) =>
  JSON.stringify({ jsonrpc: "2.0", id, method: "server/discover", params: { _meta: meta } });

const dbDir = mkdtempSync(join(tmpdir(), "reviewzy-bridge-test-"));
const open = startDaemon({ ...loadConfig({}), REVIEWZY_PORT: 0, REVIEWZY_DB: join(dbDir, "open.db") });
const guarded = startDaemon({
  ...loadConfig({ REVIEWZY_TOKEN: TOKEN }),
  REVIEWZY_PORT: 0,
  REVIEWZY_DB: join(dbDir, "guarded.db"),
});
afterAll(() => {
  void open.server.stop(true);
  void guarded.server.stop(true);
  open.store.close();
  guarded.store.close();
  rmSync(dbDir, { recursive: true, force: true });
});

/** A port that had a listener and no longer does: reachable-looking, guaranteed dead. */
async function abandonedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });
}

type Frame = { jsonrpc?: string; id?: number | string | null; result?: unknown; error?: { code: number; message?: string } };

describe("forwardLine", () => {
  test("carries a request to the daemon and returns its response frame verbatim", async () => {
    const line = await forwardLine(discover("probe-1"), open.server.port!);
    expect(line).not.toBeNull();

    const frame = JSON.parse(line!) as Frame;
    expect(frame.jsonrpc).toBe("2.0");
    expect(frame.id).toBe("probe-1");
    expect((frame.result as { resultType: string }).resultType).toBe("complete");
  });

  test("answers pipelined requests independently, matching ids, not order", async () => {
    const [first, second] = await Promise.all([
      forwardLine(discover(1), open.server.port!),
      forwardLine(discover(2), open.server.port!),
    ]);
    expect((JSON.parse(first!) as Frame).id).toBe(1);
    expect((JSON.parse(second!) as Frame).id).toBe(2);
  });

  test("a non-ascii tool name is encoded with the spec sentinel, so the refusal is not -32020", async () => {
    const call = JSON.stringify({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "caf\u00e9_tool", arguments: {}, _meta: meta },
    });
    const line = await forwardLine(call, open.server.port!);
    const frame = JSON.parse(line!) as Frame;
    expect(frame.id).toBe(5);
    // A wrong sentinel (or a literal non-ascii header) makes the daemon's header-vs-body rung
    // refuse with -32020; reaching any other answer proves the decode agreed with params.name.
    expect(frame.error?.code).not.toBe(-32020);
  });

  test("derives the Mcp-Name header a named call requires, so the refusal is not -32020", async () => {
    const call = JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "no_such_tool", arguments: {}, _meta: meta },
    });
    const line = await forwardLine(call, open.server.port!);
    const frame = JSON.parse(line!) as Frame;
    expect(frame.id).toBe(3);
    // A missing or wrong Mcp-Name is -32020; reaching the SDK past the header rung proves the
    // bridge derived it from params.name.
    expect(frame.error?.code).not.toBe(-32020);
  });

  test("a notification returns null: no response frame is ever written for it", async () => {
    const notification = JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 1 },
    });
    expect(await forwardLine(notification, open.server.port!)).toBeNull();
  });

  test("a line that is not JSON comes back as the daemon's own JSON-RPC error frame", async () => {
    const line = await forwardLine("{not json", open.server.port!);
    const frame = JSON.parse(line!) as Frame;
    expect(frame.jsonrpc).toBe("2.0");
    expect(frame.error?.code).toBeDefined();
  });

  test("a 200 with an empty body for a request is a transport error frame, not silence", async () => {
    const empty = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(null, { status: 200 }),
    });
    try {
      const line = await forwardLine(discover("empty-1"), empty.port!);
      const frame = JSON.parse(line!) as Frame;
      expect(frame.id).toBe("empty-1");
      expect(frame.error?.code).toBe(-32603);
      // The empty-body rung is the one that fired, not the generic non-json fallback.
      expect(frame.error?.message).toContain("empty");
    } finally {
      void empty.stop(true);
    }
  });

  test("an unreachable daemon surfaces as a JSON-RPC error carrying the request id", async () => {
    const port = await abandonedPort();
    const line = await forwardLine(discover("shim-9"), port);
    const frame = JSON.parse(line!) as Frame;
    expect(frame.jsonrpc).toBe("2.0");
    expect(frame.id).toBe("shim-9");
    expect(frame.error?.code).toBe(-32603);
    expect(frame.error?.message).toContain("unreachable");
  });

  test("an unreachable daemon answers a notification with silence, not an error frame", async () => {
    const port = await abandonedPort();
    const notification = JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 1 },
    });
    expect(await forwardLine(notification, port)).toBeNull();
  });
});

describe("forwardLine against a bearer-guarded daemon", () => {
  test("without the token the OAuth challenge is converted into a JSON-RPC error frame", async () => {
    const line = await forwardLine(discover(7), guarded.server.port!);
    const frame = JSON.parse(line!) as Frame;
    expect(frame.jsonrpc).toBe("2.0");
    expect(frame.id).toBe(7);
    expect(frame.error).toBeDefined();
    // The daemon's 401 body is an OAuth challenge, not a JSON-RPC frame; stdout must never see it.
    expect(frame.error?.message).toContain("401");
  });

  test("with the token the request is served normally", async () => {
    const line = await forwardLine(discover(8), guarded.server.port!, TOKEN);
    const frame = JSON.parse(line!) as Frame;
    expect(frame.id).toBe(8);
    expect((frame.result as { resultType: string }).resultType).toBe("complete");
  });
});
