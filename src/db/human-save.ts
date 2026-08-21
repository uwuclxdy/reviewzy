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
 * Everything an approve or reject refuses, with the value the dashboard's message needs: `unknown`
 * became a page's gone-fragment, `status` names the status that blocked the move (never `draft`,
 * which is the source state both transitions act on), `no_draft` the entry whose agent never
 * produced text. The route layer formats these into user-facing messages; the store never touches
 * prose.
 */
export type TransitionRefusal =
  | { readonly kind: "unknown" }
  | { readonly kind: "status"; readonly status: Exclude<EntryStatus, "draft"> }
  | { readonly kind: "no_draft" };

/**
 * `approveEntry`'s outcome. `ok` carries the status the entry now holds; a refusal means nothing
 * was written, not even `updated_at`.
 */
export type ApproveOutcome = { readonly ok: true; readonly status: "approved" } | { readonly ok: false; readonly refusal: TransitionRefusal };

/** `rejectEntry`'s outcome, mirroring `ApproveOutcome`. */
export type RejectOutcome = { readonly ok: true; readonly status: "rejected" } | { readonly ok: false; readonly refusal: TransitionRefusal };

/**
 * One entry's result in a batch approve, keyed by the id the caller passed. `ok` reports the entry
 * approved; a refusal names why and carries `id` so the route can point at the entry without
 * re-reading a row it was just told to leave alone.
 */
export type BatchApproveResult = { readonly id: string; readonly ok: true; readonly status: "approved" } | { readonly id: string; readonly ok: false; readonly refusal: TransitionRefusal };

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
 * Approves a draft: `human_text` takes the agent's draft verbatim, the entry becomes approved, and
 * the status-change event fires after the write so a waiter's re-read sees the new status. The
 * single UPDATE needs no explicit transaction. Refusals: unknown id, then a status that is not
 * draft, then an entry whose agent never produced a draft; nothing is written on any of them, not
 * even `updated_at`. Approving authors no prose, so it logs no revision row; the save that approves
 * is the only revision writer.
 */
export function approveEntry(store: Store, id: string): ApproveOutcome {
  const row = store.db.query("SELECT status, agent_draft FROM entries WHERE id = ?").get(id) as
    | { status: EntryStatus; agent_draft: string | null }
    | null;
  if (row === null) return { ok: false, refusal: { kind: "unknown" } };
  if (row.status !== "draft") return { ok: false, refusal: { kind: "status", status: row.status } };
  if (row.agent_draft === null) return { ok: false, refusal: { kind: "no_draft" } };

  store.db.run("UPDATE entries SET human_text = ?, status = 'approved', updated_at = ? WHERE id = ?", [
    row.agent_draft,
    Date.now(),
    id,
  ]);
  store.notifyStatusChange(id, "approved");
  return { ok: true, status: "approved" };
}

/**
 * Rejects a draft or an approved entry: the entry becomes rejected, and the status-change event
 * fires after the write. Rejection is terminal and erases nothing (the draft and any human text
 * stay in the row; a new entry is the way to start again), so it logs no revision row. Refusals:
 * unknown id, then a status that is not draft or approved; nothing is written on either.
 */
export function rejectEntry(store: Store, id: string): RejectOutcome {
  const row = store.db.query("SELECT status FROM entries WHERE id = ?").get(id) as { status: EntryStatus } | null;
  if (row === null) return { ok: false, refusal: { kind: "unknown" } };
  if (row.status !== "draft" && row.status !== "approved") {
    return { ok: false, refusal: { kind: "status", status: row.status } };
  }

  store.db.run("UPDATE entries SET status = 'rejected', updated_at = ? WHERE id = ?", [Date.now(), id]);
  store.notifyStatusChange(id, "rejected");
  return { ok: true, status: "rejected" };
}

/**
 * The batch approve: each id goes through `approveEntry` independently, so one entry's refusal
 * never blocks another's approval and a race can only refuse the entry it actually hit. Results
 * come back in the ids' order; the caller reports per entry. An empty selection approves nothing.
 */
export function batchApproveEntries(store: Store, ids: readonly string[]): BatchApproveResult[] {
  return ids.map((id) => {
    const outcome = approveEntry(store, id);
    if (outcome.ok) return { id, ok: true, status: "approved" };
    return { id, ok: false, refusal: outcome.refusal };
  });
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

/**
 * The tolerant parse for `entries.images`, mirroring `parseConstraints`: the column holds foreign
 * data (it is also fed by the wire), and an unparseable or shape-broken value must read as no
 * images, never as a 500. Non-string items are dropped rather than propagated.
 */
export function parseEntryImages(json: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is string => typeof item === "string");
}

/** Everything the image writes refuse; the dashboard's upload and remove routes format the messages. */
export type ImageWriteRefusal =
  | { readonly kind: "unknown" }
  | { readonly kind: "no_image"; readonly index: number };

/**
 * Appends one image the human uploaded to the entry's image list. A note-like write, not a save:
 * it works on every status, writes no revision row, changes no status, and fires no status event
 * (a waiter cares about approval, not about a new screenshot). `updated_at` moves so the row
 * reflects the write. The data url already passed the route's mime and size checks.
 */
export function appendEntryImage(store: Store, id: string, dataUrl: string): { readonly ok: true } | { readonly ok: false; readonly refusal: { readonly kind: "unknown" } } {
  const row = store.db.query("SELECT images FROM entries WHERE id = ?").get(id) as { images: string } | null;
  if (row === null) return { ok: false, refusal: { kind: "unknown" } };

  const images = parseEntryImages(row.images);
  images.push(dataUrl);
  store.db.run("UPDATE entries SET images = ?, updated_at = ? WHERE id = ?", [
    JSON.stringify(images),
    Date.now(),
    id,
  ]);
  return { ok: true };
}

/**
 * Removes one image by its index in the stored array. Same write class as `appendEntryImage`: no
 * revision, no status change, no event; `updated_at` moves. An index past either end is a refusal
 * carrying the index the route's message names.
 */
export function removeEntryImage(
  store: Store,
  id: string,
  index: number,
): { readonly ok: true } | { readonly ok: false; readonly refusal: ImageWriteRefusal } {
  const row = store.db.query("SELECT images FROM entries WHERE id = ?").get(id) as { images: string } | null;
  if (row === null) return { ok: false, refusal: { kind: "unknown" } };

  const images = parseEntryImages(row.images);
  if (index < 0 || index >= images.length) return { ok: false, refusal: { kind: "no_image", index } };
  images.splice(index, 1);
  store.db.run("UPDATE entries SET images = ?, updated_at = ? WHERE id = ?", [
    JSON.stringify(images),
    Date.now(),
    id,
  ]);
  return { ok: true };
}
