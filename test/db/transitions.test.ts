import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import { loadConfig } from "../../src/config.ts";
import { approveEntry, batchApproveEntries, rejectEntry } from "../../src/db/human-save.ts";
import type { ApproveOutcome, RejectOutcome } from "../../src/db/human-save.ts";
import { openStore, STATUS_CHANGE_EVENT } from "../../src/db/store.ts";
import type { Store } from "../../src/db/store.ts";

const tempDirs: string[] = [];

function openTempStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "reviewzy-transitions-"));
  tempDirs.push(dir);
  return openStore(loadConfig({ REVIEWZY_DB: join(dir, "reviewzy.db") }));
}

function insertProject(store: Store, slug: string) {
  const row = { id: ulid(), slug, created_at: Date.now() };
  store.db.run("INSERT INTO projects (id, slug, created_at) VALUES (?, ?, ?)", [
    row.id,
    row.slug,
    row.created_at,
  ]);
  return row;
}

/** A draft entry with the given overrides; returns the row as stored. */
function insertEntry(
  store: Store,
  projectId: string,
  overrides: { status?: string; agent_draft?: string | null; anchor_hash?: string } = {},
) {
  const now = Date.now();
  const row = {
    id: ulid(),
    batch_id: ulid(),
    repo: "https://example.com/repo.git",
    file: "src/index.ts",
    anchor_text: "hello world",
    anchor_before: "",
    anchor_after: "",
    anchor_hash: "hash-1",
    project_id: projectId,
    file_hash: "filehash-1",
    agent_draft: "hello world draft",
    human_text: null as string | null,
    status: "draft",
    context: "{}",
    constraints: "{}",
    filed_by: "agent",
    stale_note: null,
    created_at: now,
    updated_at: now,
    applied_at: null,
    archived_at: null,
    ...overrides,
  };
  store.db.run(
    `INSERT INTO entries (
      id, project_id, batch_id, repo, file, anchor_text, anchor_before, anchor_after,
      anchor_hash, file_hash, agent_draft, human_text, status, context, constraints,
      filed_by, stale_note, created_at, updated_at, applied_at, archived_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.project_id ?? projectId,
      row.batch_id,
      row.repo,
      row.file,
      row.anchor_text,
      row.anchor_before,
      row.anchor_after,
      row.anchor_hash,
      row.file_hash,
      row.agent_draft,
      row.human_text,
      row.status,
      row.context,
      row.constraints,
      row.filed_by,
      row.stale_note,
      row.created_at,
      row.updated_at,
      row.applied_at,
      row.archived_at,
    ],
  );
  return row;
}

/** The whole stored row, serialized, so a refusal can be proven byte-unchanged. */
function fullRow(store: Store, id: string): string {
  return JSON.stringify(store.db.query("SELECT * FROM entries WHERE id = ?").get(id));
}

function entryRow(store: Store, id: string) {
  return store.db.query("SELECT status, human_text, updated_at FROM entries WHERE id = ?").get(id) as {
    status: string;
    human_text: string | null;
    updated_at: number;
  };
}

function revisionCount(store: Store, entryId: string): number {
  return (store.db.query("SELECT COUNT(*) AS n FROM entry_revisions WHERE entry_id = ?").get(entryId) as {
    n: number;
  }).n;
}

function okOutcome(outcome: ApproveOutcome | RejectOutcome): Extract<ApproveOutcome | RejectOutcome, { ok: true }> {
  if (!outcome.ok) throw new Error(`expected a transition, got refusal ${outcome.refusal.kind}`);
  return outcome;
}

function refusalOf(outcome: ApproveOutcome | RejectOutcome) {
  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error("unreachable");
  return outcome.refusal;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("approveEntry", () => {
  test("approves a draft: human_text takes the agent draft, the event fires after the write, and no revision row appears", () => {
    const store = openTempStore();
    const project = insertProject(store, "alpha");
    const entry = insertEntry(store, project.id);
    const seen: { id: string; status: string }[] = [];
    store.events.addEventListener(STATUS_CHANGE_EVENT, (event) => {
      seen.push((event as CustomEvent).detail);
    });

    const before = Date.now();
    const outcome = okOutcome(approveEntry(store, entry.id));

    expect(outcome.status).toBe("approved");
    expect(entryRow(store, entry.id)).toEqual({
      status: "approved",
      human_text: "hello world draft",
      updated_at: expect.any(Number),
    });
    expect(entryRow(store, entry.id).updated_at).toBeGreaterThanOrEqual(before);

    // The approve authored no prose, so it logs no revision; the save that approves is the only
    // revision writer.
    expect(revisionCount(store, entry.id)).toBe(0);

    expect(seen).toEqual([{ id: entry.id, status: "approved" }]);
    store.close();
  });

  test("approving again is refused: the entry is already approved, nothing written", () => {
    const store = openTempStore();
    const project = insertProject(store, "alpha");
    const entry = insertEntry(store, project.id);
    approveEntry(store, entry.id);
    const before = fullRow(store, entry.id);

    const refusal = refusalOf(approveEntry(store, entry.id));

    expect(refusal).toEqual({ kind: "status", status: "approved" });
    expect(fullRow(store, entry.id)).toBe(before);
    expect(revisionCount(store, entry.id)).toBe(0);
    store.close();
  });

  test.each(["applied", "rejected"] as const)(
    "refuses to approve a %s entry, naming the status, row byte-unchanged",
    (status) => {
      const store = openTempStore();
      const project = insertProject(store, "alpha");
      const entry = insertEntry(store, project.id, { status });
      const before = fullRow(store, entry.id);

      const refusal = refusalOf(approveEntry(store, entry.id));

      expect(refusal).toEqual({ kind: "status", status });
      expect(fullRow(store, entry.id)).toBe(before);
      expect(revisionCount(store, entry.id)).toBe(0);
      store.close();
    },
  );

  test("refuses an unknown id", () => {
    const store = openTempStore();
    const refusal = refusalOf(approveEntry(store, "does-not-exist"));
    expect(refusal).toEqual({ kind: "unknown" });
    store.close();
  });

  test("refuses a draft with no agent draft, naming the gap, row byte-unchanged", () => {
    const store = openTempStore();
    const project = insertProject(store, "alpha");
    const entry = insertEntry(store, project.id, { agent_draft: null });
    const before = fullRow(store, entry.id);

    const refusal = refusalOf(approveEntry(store, entry.id));

    expect(refusal).toEqual({ kind: "no_draft" });
    expect(fullRow(store, entry.id)).toBe(before);
    expect(revisionCount(store, entry.id)).toBe(0);
    store.close();
  });
});

describe("rejectEntry", () => {
  test.each(["draft", "approved"] as const)(
    "rejects a %s entry: rejected status, the event fires after the write",
    (status) => {
      const store = openTempStore();
      const project = insertProject(store, "alpha");
      const entry = insertEntry(store, project.id, { status });
      const seen: { id: string; status: string }[] = [];
      store.events.addEventListener(STATUS_CHANGE_EVENT, (event) => {
        seen.push((event as CustomEvent).detail);
      });

      const before = Date.now();
      const outcome = okOutcome(rejectEntry(store, entry.id));

      expect(outcome.status).toBe("rejected");
      expect(entryRow(store, entry.id).status).toBe("rejected");
      expect(entryRow(store, entry.id).updated_at).toBeGreaterThanOrEqual(before);
      expect(revisionCount(store, entry.id)).toBe(0);
      expect(seen).toEqual([{ id: entry.id, status: "rejected" }]);
      store.close();
    },
  );

  test.each(["applied", "rejected"] as const)(
    "refuses to reject a %s entry, naming the status, row byte-unchanged",
    (status) => {
      const store = openTempStore();
      const project = insertProject(store, "alpha");
      const entry = insertEntry(store, project.id, { status });
      const before = fullRow(store, entry.id);

      const refusal = refusalOf(rejectEntry(store, entry.id));

      expect(refusal).toEqual({ kind: "status", status });
      expect(fullRow(store, entry.id)).toBe(before);
      expect(revisionCount(store, entry.id)).toBe(0);
      store.close();
    },
  );

  test("refuses an unknown id", () => {
    const store = openTempStore();
    const refusal = refusalOf(rejectEntry(store, "does-not-exist"));
    expect(refusal).toEqual({ kind: "unknown" });
    store.close();
  });
});

describe("batchApproveEntries", () => {
  test("approves each draft independently and refuses the rest, per entry", () => {
    const store = openTempStore();
    const project = insertProject(store, "alpha");
    const draft = insertEntry(store, project.id);
    const approved = insertEntry(store, project.id, { status: "approved", anchor_hash: "hash-2" });
    const applied = insertEntry(store, project.id, { status: "applied", anchor_hash: "hash-3" });
    const rejected = insertEntry(store, project.id, { status: "rejected", anchor_hash: "hash-4" });
    const noDraft = insertEntry(store, project.id, { agent_draft: null, anchor_hash: "hash-5" });
    const appliedBefore = fullRow(store, applied.id);
    const rejectedBefore = fullRow(store, rejected.id);
    const noDraftBefore = fullRow(store, noDraft.id);
    const seen: { id: string; status: string }[] = [];
    store.events.addEventListener(STATUS_CHANGE_EVENT, (event) => {
      seen.push((event as CustomEvent).detail);
    });

    const results = batchApproveEntries(store, [draft.id, approved.id, applied.id, rejected.id, noDraft.id, "missing"]);

    const byId = new Map(results.map((r) => [r.id, r]));
    expect(byId.get(draft.id)).toEqual({ id: draft.id, ok: true, status: "approved" });
    expect(byId.get(approved.id)).toEqual({ id: approved.id, ok: false, refusal: { kind: "status", status: "approved" } });
    expect(byId.get(applied.id)).toEqual({ id: applied.id, ok: false, refusal: { kind: "status", status: "applied" } });
    expect(byId.get(rejected.id)).toEqual({ id: rejected.id, ok: false, refusal: { kind: "status", status: "rejected" } });
    expect(byId.get(noDraft.id)).toEqual({ id: noDraft.id, ok: false, refusal: { kind: "no_draft" } });
    expect(byId.get("missing")).toEqual({ id: "missing", ok: false, refusal: { kind: "unknown" } });

    // The one success took the agent draft and dispatched once; every refusal left its row byte-unchanged.
    expect(entryRow(store, draft.id)).toMatchObject({ status: "approved", human_text: "hello world draft" });
    expect(fullRow(store, applied.id)).toBe(appliedBefore);
    expect(fullRow(store, rejected.id)).toBe(rejectedBefore);
    expect(fullRow(store, noDraft.id)).toBe(noDraftBefore);
    expect(revisionCount(store, draft.id)).toBe(0);
    expect(seen).toEqual([{ id: draft.id, status: "approved" }]);
    store.close();
  });

  test("an empty selection approves nothing and refuses nothing", () => {
    const store = openTempStore();
    const results = batchApproveEntries(store, []);
    expect(results).toEqual([]);
    store.close();
  });
});
