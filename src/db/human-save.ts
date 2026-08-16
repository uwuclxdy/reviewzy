import { ulid } from "ulid";
import type { EntryStatus } from "./queries.ts";
import type { Store } from "./store.ts";

export type HumanSaveInput = {
  readonly id: string;
  readonly text: string;
};

/**
 * Everything `saveHumanText` refuses, with the values the dashboard's message needs: `unknown`
 * became a page's 404; `status` names the terminal status; `max_len` carries the limit and the
 * length actually seen; `placeholder` names the first declared placeholder the text misses. The
 * route layer formats these into user-facing messages; the store never touches prose.
 */
export type HumanSaveRefusal =
  | { readonly kind: "unknown" }
  | { readonly kind: "status"; readonly status: "applied" | "rejected" }
  | { readonly kind: "max_len"; readonly maxLen: number; readonly length: number }
  | { readonly kind: "placeholder"; readonly placeholder: string }
  | { readonly kind: "empty" };

/**
 * `saved` distinguishes a write from a no-op: text identical to the stored `human_text` writes
 * nothing and returns the current state; anything else wrote exactly one revision row, approved
 * the entry, and dispatched the status-change event.
 */
export type HumanSaveOutcome =
  | { readonly ok: true; readonly saved: boolean; readonly status: EntryStatus; readonly text: string }
  | { readonly ok: false; readonly refusal: HumanSaveRefusal };

/** One `entry_revisions` row as the history pane reads it, newest first. */
export type RevisionRow = {
  readonly id: string;
  readonly human_text: string;
  readonly status: EntryStatus;
  readonly created_at: number;
};

/**
 * The constraints the editor enforces and displays. `max_len` and `placeholders` are enforced at
 * save; `tone` and `notes` are shown only. `undefined`/absent means "no constraint": the stored
 * JSON is foreign data and may be malformed, and an unparseable or shape-broken value must read as
 * no constraint, never as a 500.
 */
export type Constraints = {
  readonly maxLen: number | undefined;
  readonly placeholders: readonly string[];
  readonly tone: string | undefined;
  readonly notes: string | undefined;
};

const NO_CONSTRAINTS: Constraints = { maxLen: undefined, placeholders: [], tone: undefined, notes: undefined };

/**
 * The tolerant parse for `entries.constraints`: malformed JSON, non-objects, and wrongly-typed
 * members all fall back to "no constraint" (the same stance `style-guide.ts`'s glossary and banned
 * words take). `max_len` must be a positive integer; `placeholders` keeps the non-empty strings in
 * order, duplicates dropped, so the checklist never repeats a token.
 */
export function parseConstraints(json: string): Constraints {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return NO_CONSTRAINTS;
  }
  if (typeof parsed !== "object" || parsed === null) return NO_CONSTRAINTS;
  const raw = parsed as Record<string, unknown>;
  const maxLen = typeof raw.max_len === "number" && Number.isInteger(raw.max_len) && raw.max_len > 0
    ? raw.max_len
    : undefined;
  const placeholders: string[] = [];
  if (Array.isArray(raw.placeholders)) {
    for (const placeholder of raw.placeholders) {
      if (typeof placeholder === "string" && placeholder !== "" && !placeholders.includes(placeholder)) {
        placeholders.push(placeholder);
      }
    }
  }
  const tone = typeof raw.tone === "string" ? raw.tone : undefined;
  const notes = typeof raw.notes === "string" ? raw.notes : undefined;
  return { maxLen, placeholders, tone, notes };
}

/**
 * The dashboard's one save path, owned here so no route decides a status change. The refusal order
 * is deliberate: unknown id, then a terminal status (nothing is ever written on those), then empty
 * text, then the identical-text no-op, then the constraint checks. A save that passes all of them
 * inserts exactly one revision row recording the status the entry held at that moment (a draft save
 * records "draft"), updates the entry to approved, and dispatches the status-change event after the
 * write so a waiter's re-read sees the new status. The insert and the update are one transaction:
 * a crash between them must not leave a revision without its approval. Old revision rows are never
 * mutated; "undo" is restoring a revision's text, which writes a new row like any other save.
 */
export function saveHumanText(store: Store, input: HumanSaveInput): HumanSaveOutcome {
  const row = store.db.query("SELECT status, human_text, constraints FROM entries WHERE id = ?").get(input.id) as
    | { status: EntryStatus; human_text: string | null; constraints: string }
    | null;
  if (row === null) return { ok: false, refusal: { kind: "unknown" } };

  // `draft` and `approved` are the two statuses the dashboard owns; the agents own the rest, so
  // anything else is terminal from this side.
  if (row.status !== "draft" && row.status !== "approved") {
    return { ok: false, refusal: { kind: "status", status: row.status } };
  }

  if (input.text.trim() === "") {
    return { ok: false, refusal: { kind: "empty" } };
  }

  // The no-op save: identical text writes nothing, returns the current state, and fires no event.
  if (input.text === row.human_text) {
    return { ok: true, saved: false, status: row.status, text: input.text };
  }

  const constraints = parseConstraints(row.constraints);
  if (constraints.maxLen !== undefined && input.text.length > constraints.maxLen) {
    return { ok: false, refusal: { kind: "max_len", maxLen: constraints.maxLen, length: input.text.length } };
  }
  for (const placeholder of constraints.placeholders) {
    if (!input.text.includes(placeholder)) {
      return { ok: false, refusal: { kind: "placeholder", placeholder } };
    }
  }

  // The revision's status is the entry's status at this moment, before the transition: the save
  // that approves a draft records "draft", a re-save on an approved entry records "approved".
  const recordedStatus = row.status;
  const now = Date.now();
  store.db.transaction(() => {
    store.db.run(
      "INSERT INTO entry_revisions (id, entry_id, human_text, status, created_at) VALUES (?, ?, ?, ?, ?)",
      [ulid(), input.id, input.text, recordedStatus, now],
    );
    store.db.run("UPDATE entries SET human_text = ?, status = 'approved', updated_at = ? WHERE id = ?", [
      input.text,
      now,
      input.id,
    ]);
  })();
  store.notifyStatusChange(input.id, "approved");
  return { ok: true, saved: true, status: "approved", text: input.text };
}

/**
 * The history pane's read: the entry's revision rows, newest first, `rowid` as the same-millisecond
 * tie-break. `id` cannot break that tie: a ulid's random bits never encode recency, so ordering on
 * it shuffles a history saved within one millisecond (same trap as the task-11 batch walk).
 * `rowid` is insertion order, which is exactly the recency the pane promises.
 */
export function listRevisions(store: Store, entryId: string): RevisionRow[] {
  return store.db
    .query(
      "SELECT id, human_text, status, created_at FROM entry_revisions WHERE entry_id = ? ORDER BY created_at DESC, rowid DESC",
    )
    .all(entryId) as RevisionRow[];
}
