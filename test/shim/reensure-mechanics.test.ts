import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { forwardLine } from "../../src/shim/main.ts";

/**
 * The re-ensure mechanics forwardLine owns, driven through its own parameters: which fetch failures
 * may trigger a re-ensure (connect-class only), the one-attempt-one-retry bound, and single-flight —
 * the closure shape runShim builds, replicated here because the property lives in runShim and a
 * runShim-level drive is the acceptance file's domain. Every daemon-answered rung (202, empty body,
 * sse with no data, non-json) sits outside the trigger and stays there.
 */

const REPLY = '{"jsonrpc":"2.0","id":7,"result":{"via":"retried"}}';

type FrameServer = { port: number; posts: () => number; lastBody: () => string | undefined; stop: () => void };

/** A daemon stand-in that answers every POST with one fixed JSON-RPC frame, counting its posts. */
function frameServer(reply: string): FrameServer {
  let count = 0;
  let body: string | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      count += 1;
      body = await request.text();
      return new Response(reply);
    },
  });
  return { port: server.port!, posts: () => count, lastBody: () => body, stop: () => void server.stop(true) };
}

/**
 * A port that had a listener and no longer does: reachable-looking, guaranteed dead. Replicated
 * from bridge.test.ts because importing a test file would run its module side effects (its daemons).
 */
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

const request = (id: string) => JSON.stringify({ jsonrpc: "2.0", id, method: "server/discover", params: {} });

describe("forwardLine re-ensure mechanics", () => {
  test("a daemon-answered rung (empty 200 body) never calls reensure; the transport error still returns", async () => {
    const empty = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(null, { status: 200 }),
    });
    try {
      let reensureCalls = 0;
      const reensure = async (): Promise<number> => {
        reensureCalls += 1;
        return empty.port!;
      };
      const reply = await forwardLine(request("mech-empty-1"), empty.port!, undefined, reensure);
      expect(reensureCalls).toBe(0);
      expect(reply).toBe(
        '{"jsonrpc":"2.0","id":"mech-empty-1","error":{"code":-32603,"message":"daemon replied http 200 with an empty body"}}',
      );
    } finally {
      void empty.stop(true);
    }
  });

  test("a connect failure calls reensure exactly once and retries once against the port it returns", async () => {
    const dead = await abandonedPort();
    const stub = frameServer(REPLY);
    try {
      let reensureCalls = 0;
      const reensure = async (): Promise<number> => {
        reensureCalls += 1;
        return stub.port;
      };
      const frame = request("mech-retry-1");
      const reply = await forwardLine(frame, dead, undefined, reensure);
      expect(reensureCalls).toBe(1);
      expect(stub.posts()).toBe(1);
      expect(stub.lastBody()).toBe(frame);
      expect(reply).toBe(REPLY);
    } finally {
      stub.stop();
    }
  });

  test("two concurrent failing lines share one reensure call through runShim's closure shape", async () => {
    const dead = await abandonedPort();
    const stub = frameServer(REPLY);
    try {
      let entries = 0;
      let reensureCalls = 0;
      let reensuring: Promise<number> | undefined;
      let release: () => void = () => {};
      // The gate resolves on the second entry into the closure, so both lines are provably inside
      // before the attempt can settle: the test never depends on fetch-failure timing.
      const gate = new Promise<number>((resolve) => {
        release = () => resolve(stub.port);
      });
      // runShim's closure shape, replicated: guard, one in-flight attempt, cleared on settle. The
      // entry counter only releases the gate; the assertion still counts creations alone.
      const reensure = (): Promise<number> => {
        entries += 1;
        if (entries === 2) release();
        if (reensuring !== undefined) return reensuring;
        reensureCalls += 1;
        const attempt = gate.finally(() => {
          reensuring = undefined;
        });
        reensuring = attempt;
        return attempt;
      };

      const [replyA, replyB] = await Promise.all([
        forwardLine(request("mech-single-1"), dead, undefined, reensure),
        forwardLine(request("mech-single-2"), dead, undefined, reensure),
      ]);
      expect(reensureCalls).toBe(1);
      expect(stub.posts()).toBe(2);
      // Each line retried once and relayed the retry's answer verbatim; matching the answer to the
      // request id is the daemon's job, not the shim's.
      expect(replyA).toBe(REPLY);
      expect(replyB).toBe(REPLY);
    } finally {
      stub.stop();
    }
  });

  test("a fetch rejection that is not connect-class re-ensures zero times", async () => {
    const dead = await abandonedPort();
    let reensureCalls = 0;
    const reensure = async (): Promise<number> => {
      reensureCalls += 1;
      return dead;
    };
    const frame = JSON.stringify({ jsonrpc: "2.0", id: "mech-nonconnect-1", method: "a\r\nb" });
    const reply = await forwardLine(frame, dead, undefined, reensure);
    expect(reensureCalls).toBe(0);
    expect(reply).toBe(
      `{"jsonrpc":"2.0","id":"mech-nonconnect-1","error":{"code":-32603,"message":"daemon unreachable on port ${dead}: Header 'mcp-method' has invalid value: 'a\\r\\nb'"}}`,
    );
  });
});
