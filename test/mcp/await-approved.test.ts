import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { loadConfig } from "../../src/config.ts";
import { createApp } from "../../src/daemon/app.ts";
import { openStore } from "../../src/db/store.ts";
import type { Store } from "../../src/db/store.ts";
import { originGate } from "../../src/daemon/origin.ts";
import { mountMcp } from "../../src/mcp/route.ts";
import { AWAIT_TIMEOUT_MAX_MS, clampTimeoutMs } from "../../src/mcp/await-approved.ts";

const REVISION = "2026-07-28";

const META = {
  "io.modelcontextprotocol/protocolVersion": REVISION,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "reviewzy-probe", version: "0" },
};

/** The advertised port; the actual bind is port 0, see `serveApp`. */
const PORT = 3202;

/** The wait's own cadence, mirrored from src/mcp/await-approved.ts: the poll backstop fires at 500ms, so a resolve well under it can only have come from the event bus. */
const POLL_MS = 500;

/** The poll-again hint `docs/mcp-contract.md` pins for a timeout or a drain. */
const POLL_AGAIN_MS = 5_000;

type WireEntry = {
  id: string;
  repo: string;
  file: string;
  anchor_text: string;
  anchor_before: string;
  anchor_after: string;
  anchor_hash: string;
  file_hash: string;
  text: string | null;
  constraints: Record<string, unknown>;
};
type AwaitResult = {
  resolved: boolean;
  statuses: Record<string, string>;
  entries?: WireEntry[];
  poll_again_after_ms?: number;
};
type MarkResult = { id: string; status: string };
type FiledResult = { results: { id: string }[] };

type WireResult = {
  resultType?: string;
  isError?: boolean;
  structuredContent?: AwaitResult | MarkResult | FiledResult;
  content?: { type: string; text: string }[];
};

const tempDirs: string[] = [];

/**
 * One app per suite-leg, not per test: the app holds the one store the daemon would hold, and a
 * wait leg needs the rows a seeding leg wrote, so tests inside a describe share state by name.
 */
function serveApp() {
  const dir = mkdtempSync(join(tmpdir(), "reviewzy-await-approved-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "reviewzy.db");
  const config = loadConfig({ REVIEWZY_DB: dbPath, REVIEWZY_PORT: String(PORT) });
  const store = openStore(config);

  const app = new Hono();
  app.use(originGate(config));
  mountMcp(app, config, store);

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  return { store, call, close: () => { void server.stop(true); store.close(); } };

  async function call(method: string, params: Record<string, unknown>, name?: string) {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-method": method,
    };
    if (name !== undefined) headers["mcp-name"] = name;

    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: META } }),
    });
    const body = (await response.json()) as {
      jsonrpc: string;
      id: number;
      result?: WireResult & {
        tools?: { name: string; description?: string; inputSchema?: unknown; outputSchema?: unknown }[];
      };
      error?: { code: number; message: string };
    };
    return { status: response.status, body };
  }
}

/**
 * The drain leg: `createApp` mounts the `/drain` route over the same store the mcp handler holds,
 * which is exactly the daemon arrangement the drain test needs. No onDrain hook: the waiter
 * resolution happens in the route itself, and the test must not end its own process.
 */
function serveDrainApp() {
  const dir = mkdtempSync(join(tmpdir(), "reviewzy-await-drain-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "reviewzy.db");
  const config = loadConfig({ REVIEWZY_DB: dbPath, REVIEWZY_PORT: String(PORT) });
  const store = openStore(config);

  const app = createApp(config, store);

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  return {
    store,
    call,
    drain: () => fetch(`${baseUrl}/drain`, { method: "POST" }),
    close: () => { void server.stop(true); store.close(); },
  };

  async function call(method: string, params: Record<string, unknown>, name?: string) {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-method": method,
    };
    if (name !== undefined) headers["mcp-name"] = name;

    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: META } }),
    });
    const body = (await response.json()) as {
      jsonrpc: string;
      id: number;
      result?: WireResult;
      error?: { code: number; message: string };
    };
    return { status: response.status, body };
  }
}

const first = serveApp();

afterAll(() => {
  void first.close();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

/** One well-formed entry; every leg overrides only the field it is about. */
const entry = (overrides: Record<string, unknown> = {}) => ({
  repo: "https://example.com/repo.git",
  file: "src/app.ts",
  anchor_text: "Click here to continue",
  anchor_before: "const label = t(`home.hero`)",
  anchor_after: "</button>",
  agent_draft: "Continue",
  file_content: "line one\nClick here to continue\nline three\n",
  context: { where: "hero button", surrounding: "<button>{{label}}</button>" },
  constraints: { max_len: 24, placeholders: ["{name}"], tone: "plain", notes: "no exclamation marks" },
  ...overrides,
});

const fileEntries = (args: Record<string, unknown>) =>
  first.call("tools/call", { name: "file_entries", arguments: args }, "file_entries");

const awaitApproved = (args: Record<string, unknown>) =>
  first.call("tools/call", { name: "await_approved", arguments: args }, "await_approved");

const markApplied = (args: Record<string, unknown>) =>
  first.call("tools/call", { name: "mark_applied", arguments: args }, "mark_applied");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Files one entry through the wire and returns its id. */
async function seed(project: string, anchor: string): Promise<string> {
  const filed = (await fileEntries({ project, entries: [entry({ anchor_text: anchor })] })).body.result
    ?.structuredContent as FiledResult;
  return filed.results[0]!.id;
}

/**
 * Flips a row the way the dashboard save will (queue task 13 owns the real path): status to
 * approved, the prose into human_text.
 */
function approve(store: Store, id: string, text = "signed off"): void {
  store.db.run("UPDATE entries SET status = 'approved', human_text = ? WHERE id = ?", [text, id]);
}

/** The dashboard's other transition (queue task 13): rejected is terminal. */
function reject(store: Store, id: string): void {
  store.db.run("UPDATE entries SET status = 'rejected' WHERE id = ?", [id]);
}

describe("the tool surface", () => {
  test("await_approved is advertised last, with the wait schemas and the boundary rules in the description", async () => {
    const { body } = await first.call("tools/list", {});
    const tools = body.result?.tools ?? [];
    expect(tools.map((t) => t.name)).toEqual([
      "file_entries",
      "list_entries",
      "fetch_approved",
      "mark_applied",
      "await_approved",
    ]);

    const tool = tools[4]!;
    const input = tool.inputSchema as {
      type?: string;
      properties?: Record<string, Record<string, unknown>>;
    };
    expect(input.type).toBe("object");
    expect(Object.keys(input.properties ?? {})).toEqual(["ids", "timeout_ms"]);

    const output = tool.outputSchema as { properties?: Record<string, unknown> };
    expect(Object.keys(output.properties ?? {})).toEqual([
      "resolved",
      "statuses",
      "entries",
      "poll_again_after_ms",
    ]);

    const description = tool.description ?? "";
    expect(description).toContain("approved");
    expect(description).toContain("600000");
  });
});

describe("the wait", () => {
  test("an in-flight wait resolves from the event on a status change made by another connection, well before its timeout", async () => {
    // Seed one entry and sign it off, the way the dashboard will.
    const id = await seed("event-resolve", "Click here to continue");
    approve(first.store, id);

    // Connection B: the loop-close mark on the approved entry. Applied is neither approved nor
    // rejected, so a wait on this entry is genuinely in flight.
    const applied = await markApplied({ id, result: "applied" });
    expect(applied.body.error).toBeUndefined();
    expect(applied.body.result?.isError).toBeUndefined();

    // Connection A: the long-poll. The call is issued without awaiting; the response stays open
    // until the wait resolves.
    const startedAt = Date.now();
    const waiting = awaitApproved({ ids: [id], timeout_ms: 5000 });

    // Let the waiter register before the wake-up lands: the point is the event, not the poll or
    // the initial re-check.
    await sleep(150);

    // Connection B again, while A's response is still open: the stale report returns the entry to
    // approved, the store dispatches the status-change event, and A's waiter re-checks and
    // resolves. The call completing is also the proof that the server kept serving other requests
    // while A's long-poll held its response.
    const stale = await markApplied({ id, result: "anchor_stale", found_text: "Go on" });
    expect(stale.body.error).toBeUndefined();
    expect(stale.body.result?.isError).toBeUndefined();

    const { body } = await waiting;
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeLessThan(POLL_MS);
    expect(body.error).toBeUndefined();
    expect(body.result?.isError).toBeUndefined();
    expect(body.result?.resultType).toBe("complete");

    const result = body.result?.structuredContent as AwaitResult;
    expect(result.resolved).toBe(true);
    expect(result.statuses).toEqual({ [id]: "approved" });
    expect("poll_again_after_ms" in result).toBe(false);

    // The entries are exactly fetch_approved's row shape, and the resolve carries the approved rows.
    const wire = result.entries?.[0];
    expect(wire?.id).toBe(id);
    expect(wire?.text).toBe("signed off");
    expect(wire?.anchor_text).toBe("Click here to continue");
    expect(wire?.anchor_before).toBe("const label = t(`home.hero`)");
    expect(wire?.anchor_after).toBe("</button>");
    expect(wire?.repo).toBe("https://example.com/repo.git");
    expect(wire?.file).toBe("src/app.ts");
    expect(wire?.constraints).toEqual({
      max_len: 24,
      placeholders: ["{name}"],
      tone: "plain",
      notes: "no exclamation marks",
    });
    expect(Object.keys(wire!).sort()).toEqual([
      "anchor_after",
      "anchor_before",
      "anchor_hash",
      "anchor_text",
      "constraints",
      "file",
      "file_hash",
      "id",
      "repo",
      "text",
    ]);

    // The settle tore the waiter down: nothing may survive the resolve.
    expect(first.store.waiterCount()).toBe(0);
  });

  test("a wait that never resolves times out with the poll-again shape, as a normal result", async () => {
    const a = await seed("timeout", "first anchor");
    const b = await seed("timeout", "second anchor");

    const startedAt = Date.now();
    const { body } = await awaitApproved({ ids: [a, b], timeout_ms: 1000 });
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(900);

    expect(body.error).toBeUndefined();
    expect(body.result?.isError).toBeUndefined();
    expect(body.result?.resultType).toBe("complete");
    const result = body.result?.structuredContent as AwaitResult;
    expect(result.resolved).toBe(false);
    expect(result.statuses).toEqual({ [a]: "draft", [b]: "draft" });
    expect(result.poll_again_after_ms).toBe(POLL_AGAIN_MS);
    expect("entries" in result).toBe(false);
    expect(first.store.waiterCount()).toBe(0);
  });

  test("a wait over some resolved and some pending ids stays open until the timeout", async () => {
    const approvedId = await seed("partial", "already approved");
    const pendingId = await seed("partial", "still a draft");
    approve(first.store, approvedId);

    const startedAt = Date.now();
    const { body } = await awaitApproved({ ids: [approvedId, pendingId], timeout_ms: 1000 });
    // `.every` semantics: one pending id keeps the wait open. An instant resolve here means the
    // wait settled on `.some`, and the mixed map is what a timeout must carry.
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(900);

    expect(body.error).toBeUndefined();
    expect(body.result?.isError).toBeUndefined();
    expect(body.result?.resultType).toBe("complete");
    const result = body.result?.structuredContent as AwaitResult;
    expect(result.resolved).toBe(false);
    expect(result.statuses).toEqual({ [approvedId]: "approved", [pendingId]: "draft" });
    expect(result.poll_again_after_ms).toBe(POLL_AGAIN_MS);
    expect("entries" in result).toBe(false);
    expect(first.store.waiterCount()).toBe(0);
  });

  test("a wait over a row that vanished mid-wait stays open until the timeout", async () => {
    const survivingId = await seed("vanish", "survives");
    const vanishedId = await seed("vanish", "vanished row");
    const startedAt = Date.now();
    const waiting = awaitApproved({ ids: [survivingId, vanishedId], timeout_ms: 1000 });
    await sleep(150);

    // The planned retention sweep will move rows to the archive mid-wait; the store has no such
    // path yet, so this is the direct write. Approving the survivor makes the query's rows all
    // approved — without the length guard, the wait would resolve "true" with the vanished id
    // missing from the statuses map, whose contract is one key per named id.
    approve(first.store, survivingId);
    first.store.db.run("DELETE FROM entries WHERE id = ?", [vanishedId]);

    const { body } = await waiting;
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
    expect(body.error).toBeUndefined();
    expect(body.result?.isError).toBeUndefined();
    expect(body.result?.resultType).toBe("complete");
    const result = body.result?.structuredContent as AwaitResult;
    expect(result.resolved).toBe(false);
    expect(result.statuses).toEqual({ [survivingId]: "approved" });
    expect(result.poll_again_after_ms).toBe(POLL_AGAIN_MS);
    expect("entries" in result).toBe(false);
    expect(first.store.waiterCount()).toBe(0);
  });

  test("a wait over an approved and a rejected id resolves immediately: rejected appears in statuses only, never in entries", async () => {
    const approvedId = await seed("mixed", "approved anchor");
    const rejectedId = await seed("mixed", "rejected anchor");
    approve(first.store, approvedId);
    reject(first.store, rejectedId);

    const { body } = await awaitApproved({ ids: [approvedId, rejectedId], timeout_ms: 5000 });
    const result = body.result?.structuredContent as AwaitResult;
    expect(result.resolved).toBe(true);
    expect(result.statuses).toEqual({ [approvedId]: "approved", [rejectedId]: "rejected" });
    expect(result.entries?.map((e) => e.id).sort()).toEqual([approvedId]);
  });

  test("duplicate ids are deduped silently: one status key, one entry, and a duplicated unknown id is named once", async () => {
    const id = await seed("dedup", "anchor");
    approve(first.store, id);

    const { body } = await awaitApproved({ ids: [id, id], timeout_ms: 1000 });
    const result = body.result?.structuredContent as AwaitResult;
    expect(result.resolved).toBe(true);
    expect(Object.keys(result.statuses)).toEqual([id]);
    expect(result.entries).toHaveLength(1);

    const refused = await awaitApproved({ ids: ["ghost-dedup", "ghost-dedup"], timeout_ms: 1000 });
    const text = refused.body.result?.content?.[0]?.text ?? "";
    expect(text).toContain('entry "ghost-dedup"');
    expect(text).not.toContain("and 1 more");
  });

  test("two concurrent waits on one id both resolve from the same status change", async () => {
    const id = await seed("concurrent", "two waiters");
    approve(first.store, id);
    const applied = await markApplied({ id, result: "applied" });
    expect(applied.body.error).toBeUndefined();

    const startedAt = Date.now();
    const waitingA = awaitApproved({ ids: [id], timeout_ms: 3000 });
    const waitingB = awaitApproved({ ids: [id], timeout_ms: 3000 });
    await sleep(150);

    // One dispatch, two listeners: both waiters registered on the same bus, so the single
    // anchor_stale event settles them both. A refactor sharing one per-id listener or settling a
    // single waiter would strand the second response until its timeout.
    const stale = await markApplied({ id, result: "anchor_stale", found_text: "Go on" });
    expect(stale.body.error).toBeUndefined();

    const [resultA, resultB] = await Promise.all([waitingA, waitingB]);
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeLessThan(POLL_MS);
    for (const { body } of [resultA, resultB]) {
      expect(body.error).toBeUndefined();
      expect(body.result?.isError).toBeUndefined();
      expect(body.result?.resultType).toBe("complete");
    }
    const ra = resultA.body.result?.structuredContent as AwaitResult;
    const rb = resultB.body.result?.structuredContent as AwaitResult;
    expect(ra.resolved).toBe(true);
    expect(rb.resolved).toBe(true);
    expect(ra.statuses).toEqual({ [id]: "approved" });
    expect(rb.statuses).toEqual(ra.statuses);
    expect(ra.entries?.[0]?.id).toBe(id);
    expect(ra.entries?.[0]?.text).toBe("signed off");
    expect(rb.entries).toEqual(ra.entries);
    expect(first.store.waiterCount()).toBe(0);
  });
});

describe("refusals", () => {
  test("an unknown id is refused naming the id and the fix, and creates nothing", async () => {
    // The shared app has rows from the earlier legs, so "creates nothing" is the connection's
    // row-change counter holding still across the refused call — any INSERT, UPDATE, or DELETE
    // from the refusal path would move it.
    const changedBefore = (first.store.db.query("SELECT total_changes() AS n").get() as { n: number }).n;

    const { status, body } = await awaitApproved({ ids: ["ghost-id"], timeout_ms: 1000 });
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
    expect(body.result?.isError).toBe(true);
    const text = body.result?.content?.[0]?.text ?? "";
    expect(text).toContain("ghost-id");
    expect(text).toContain("no such entry");
    expect(text).toContain("fix:");

    const changedAfter = (first.store.db.query("SELECT total_changes() AS n").get() as { n: number }).n;
    expect(changedAfter).toBe(changedBefore);
  });

  test("a mix of existing and unknown ids is refused, naming the unknown one", async () => {
    const id = await seed("mixed-ghost", "anchor");
    const { body } = await awaitApproved({ ids: [id, "ghost-mix"], timeout_ms: 1000 });
    expect(body.result?.isError).toBe(true);
    const text = body.result?.content?.[0]?.text ?? "";
    expect(text).toContain("ghost-mix");
    expect(text).not.toContain("and 1 more");
  });

  test("an empty ids array is refused at the schema boundary", async () => {
    const { body } = await awaitApproved({ ids: [], timeout_ms: 1000 });
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text ?? "").toContain("ids");
  });

  test("a timeout_ms below 1, non-integer, or non-numeric is refused at the schema boundary", async () => {
    for (const bad of [0, -5, 1.5, "5000"]) {
      const { body } = await awaitApproved({ ids: ["whatever"], timeout_ms: bad });
      expect(body.result?.isError, String(bad)).toBe(true);
      expect(body.result?.content?.[0]?.text ?? "", String(bad)).toContain("timeout_ms");
    }
  });
});

describe("clampTimeoutMs", () => {
  test("caps at the contract's 600000 and floors at 1", () => {
    expect(AWAIT_TIMEOUT_MAX_MS).toBe(600_000);
    expect(clampTimeoutMs(600_000)).toBe(600_000);
    expect(clampTimeoutMs(600_001)).toBe(600_000);
    expect(clampTimeoutMs(7_200_000)).toBe(600_000);
    expect(clampTimeoutMs(60_000)).toBe(60_000);
    expect(clampTimeoutMs(1)).toBe(1);
    expect(clampTimeoutMs(0)).toBe(1);
    expect(clampTimeoutMs(-100)).toBe(1);
  });
});

describe("the drain path", () => {
  test("drain resolves an in-flight wait with the poll-again shape", async () => {
    const drainApp = serveDrainApp();
    try {
      const filed = (await drainApp.call(
        "tools/call",
        { name: "file_entries", arguments: { project: "drain", entries: [entry()] } },
        "file_entries",
      )).body.result?.structuredContent as FiledResult;
      const id = filed.results[0]!.id;

      const startedAt = Date.now();
      const waiting = drainApp.call(
        "tools/call",
        { name: "await_approved", arguments: { ids: [id], timeout_ms: 3000 } },
        "await_approved",
      );
      // The waiter registers synchronously when the request lands; a beat makes the landing
      // observable without racing it.
      await sleep(150);

      const drain = await drainApp.drain();
      expect(drain.status).toBe(200);

      const { body } = await waiting;
      const result = body.result?.structuredContent as AwaitResult;
      expect(body.error).toBeUndefined();
      expect(body.result?.isError).toBeUndefined();
      expect(body.result?.resultType).toBe("complete");
      expect(result.resolved).toBe(false);
      expect(result.statuses).toEqual({ [id]: "draft" });
      expect(result.poll_again_after_ms).toBe(POLL_AGAIN_MS);
      // The drain cut the wait short: a timeout would have taken the full 3000ms.
      expect(Date.now() - startedAt).toBeLessThan(2000);
      expect(drainApp.store.waiterCount()).toBe(0);

      // The settled wait must have torn down its bus listener and poll timer. Against the closed
      // store either leak throws — the listener synchronously on the dispatch, the timer at the
      // next 500ms tick, which always lands inside this beat however late the drain arrived —
      // and the run reds; a clean teardown leaves both lines silent.
      drainApp.close();
      drainApp.store.notifyStatusChange("leak-probe", "approved");
      await sleep(550);
    } finally {
      drainApp.close();
    }
  });

  test("drain answers the poll-again shape even when the entry became approved while the wait was in flight", async () => {
    const drainApp = serveDrainApp();
    try {
      const filed = (await drainApp.call(
        "tools/call",
        { name: "file_entries", arguments: { project: "drain-approved", entries: [entry()] } },
        "file_entries",
      )).body.result?.structuredContent as FiledResult;
      const id = filed.results[0]!.id;

      const startedAt = Date.now();
      const waiting = drainApp.call(
        "tools/call",
        { name: "await_approved", arguments: { ids: [id], timeout_ms: 3000 } },
        "await_approved",
      );
      await sleep(150);

      // The dashboard's sign-off, mid-wait, without a bus event: the waiter's next re-check is
      // the 500ms poll, and the drain lands before it.
      approve(drainApp.store, id);

      const drain = await drainApp.drain();
      expect(drain.status).toBe(200);

      const { body } = await waiting;
      const result = body.result?.structuredContent as AwaitResult;
      expect(body.error).toBeUndefined();
      expect(body.result?.isError).toBeUndefined();
      expect(body.result?.resultType).toBe("complete");
      // The drain's answer is the poll-again shape whatever the statuses say: the daemon is
      // leaving, so a resolved:true here would hand the client a completed answer with no daemon
      // behind it to apply against.
      expect(result.resolved).toBe(false);
      expect(result.statuses).toEqual({ [id]: "approved" });
      expect(result.poll_again_after_ms).toBe(POLL_AGAIN_MS);
      expect("entries" in result).toBe(false);
      expect(Date.now() - startedAt).toBeLessThan(2000);
      expect(drainApp.store.waiterCount()).toBe(0);
    } finally {
      drainApp.close();
    }
  });
});
