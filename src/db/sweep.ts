import type { Store } from "./store.ts";

/** The hourly cadence `src/daemon/main.ts` arms the sweep timer with. */
export const SWEEP_INTERVAL_MS = 3_600_000;

const MS_PER_DAY = 86_400_000;

/**
 * The retention cutoff for a sweep taken "now": entries applied before this instant are past the
 * `ARCHIVE_AFTER_DAYS` window (`docs/design.md` "retention").
 */
export function archiveCutoff(now: number, archiveAfterDays: number): number {
  return now - archiveAfterDays * MS_PER_DAY;
}

/**
 * The one classification every sweep statement re-asserts, bound with the cutoff: an applied
 * entry whose apply is strictly older than the cutoff and not already archived. `applied_at < ?`
 * never matches a NULL `applied_at` (sqlite folds the comparison to NULL, which a WHERE drops),
 * and `archived_at IS NULL` keeps a live row already stamped out of the selection.
 */
const EXPIRED_APPLIED = "status = 'applied' AND applied_at < ? AND archived_at IS NULL";

/**
 * The candidate snapshot: what one sweep would move if it ran right now. Advisory only — the act
 * (`sweepArchive`) re-asserts the same classification in every statement, so a row that changed
 * after this read is skipped there, never moved.
 */
export function selectArchiveCandidates(store: Store, now: number, archiveAfterDays: number): string[] {
  const rows = store.db
    .query(`SELECT id FROM entries WHERE ${EXPIRED_APPLIED} ORDER BY id`)
    .all(archiveCutoff(now, archiveAfterDays)) as { id: string }[];
  return rows.map((row) => row.id);
}

/**
 * The retention sweep: moves every expired applied entry, plus its revisions, into the archive
 * tables, in one transaction, and returns the number of entries moved. A second run over the same
 * data has nothing left to insert and returns 0.
 *
 * The statement order is load-bearing: the archive inserts run before the live deletes because
 * `entry_revisions_archive.entry_id` references `entries_archive(id)` and `entry_revisions.entry_id`
 * references `entries(id)`, both `NO ACTION` (migrations.ts) — a sweep that moved an entry without
 * first moving its revisions, or deleted an entry before its revisions, fails loudly on the
 * foreign key instead of orphaning or destroying history. Every statement re-asserts the
 * classification, so a row that changed since a candidate snapshot was taken (the selection
 * above) is skipped at act time rather than trusted from the snapshot.
 */
export function sweepArchive(store: Store, now: number, archiveAfterDays: number): number {
  const cutoff = archiveCutoff(now, archiveAfterDays);
  const move = store.db.transaction(() => {
    // The entry copy is column-for-column, `archived_at` stamped with this sweep's now. The
    // write count comes from this insert: it is exactly the entries moved.
    const moved = store.db.run(
      `INSERT INTO entries_archive (
        id, project_id, batch_id, repo, file, anchor_text, anchor_before, anchor_after,
        anchor_hash, file_hash, agent_draft, human_text, status, context, constraints,
        filed_by, stale_note, applied_hash, created_at, updated_at, applied_at, archived_at
      )
      SELECT
        id, project_id, batch_id, repo, file, anchor_text, anchor_before, anchor_after,
        anchor_hash, file_hash, agent_draft, human_text, status, context, constraints,
        filed_by, stale_note, applied_hash, created_at, updated_at, applied_at, ?
      FROM entries
      WHERE ${EXPIRED_APPLIED}`,
      [now, cutoff],
    ).changes;

    store.db.run(
      `INSERT INTO entry_revisions_archive (id, entry_id, human_text, status, created_at, archived_at)
       SELECT r.id, r.entry_id, r.human_text, r.status, r.created_at, ?
       FROM entry_revisions r
       JOIN entries e ON e.id = r.entry_id
       WHERE e.${EXPIRED_APPLIED}`,
      [now, cutoff],
    );

    // Live revisions die before their entries: the NO ACTION foreign key makes the reverse order
    // an immediate failure.
    store.db.run(`DELETE FROM entry_revisions WHERE entry_id IN (SELECT id FROM entries WHERE ${EXPIRED_APPLIED})`, [
      cutoff,
    ]);
    store.db.run(`DELETE FROM entries WHERE ${EXPIRED_APPLIED}`, [cutoff]);

    return moved;
  });
  return move();
}
