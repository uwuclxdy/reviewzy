---
name: reviewzy
description: "This skill should be used when filing, rewriting, or applying user-facing copy (CLI help, TUI strings, web UI strings, error messages, microcopy) through reviewzy's human-in-the-loop MCP tools."
when_to_use: "Use when a copy change must not land until a human approves it."
---

# reviewzy

agents file user-facing text, a human authors or approves it on the dashboard, a later session fetches the approved words and applies them in place. no i18n keys, no content layer: each entry points at the text where it already lives.

load this skill whenever a copy change must wait on a human.

## tools

five tools, one resource. names are unprefixed; the client namespaces by server.

| tool | what it does |
|---|---|
| `file_entries` | file one or more entries for a project, answers with a batch id and a dashboard url |
| `list_entries` | filter the queue by project, status, ids, or text |
| `fetch_approved` | return approved entries (text, anchor, constraints) plus the merged style guide |
| `await_approved` | block until named ids reach `approved` or `rejected` |
| `mark_applied` | report an apply as `applied` or `anchor_stale` |

resource: `reviewzy://projects/{slug}/style-guide`, mime `text/markdown`. read it before drafting so the prose matches the project voice.

## workflow

1. file. gather the exact text to write or rewrite, read the style guide, then call `file_entries` with the project slug and entries (`repo`, `file`, `anchor_text`, `agent_draft`, `context`, `constraints`). one entry is one edit: `anchor_text` is the whole passage being replaced, `agent_draft` the proposed replacement. report the returned `dashboard_url` to the user.
2. hand off. a human authors or approves each entry on the dashboard. only the dashboard can reach `approved` or `rejected`; the server enforces this.
3. fetch. in a later session, call `fetch_approved` with `project` and `since` to get everything approved, or `await_approved` with `ids` and `timeout_ms` to block a live session until those ids resolve.
4. apply. re-read the file, match `anchor_text` inside its context window, replace it, then call `mark_applied` with `result: "applied"`. if the anchor no longer matches, call `mark_applied` with `result: "anchor_stale"`.

## rules

- an agent can never move an entry to `approved` or `rejected`. those transitions belong to the dashboard alone.
- one entry is one edit. `anchor_text` and `agent_draft` may contain newlines: file a multi-line passage as a single entry, never one entry per line.
- the identity key is `(project_id, repo, file, anchor_hash)`. re-filing an existing key never creates a second row: a `draft` overwrites in place, an `approved`/`applied`/`rejected` entry is a no-op that returns the existing status.
- anchors go stale when the file moves underneath an entry. re-verify `anchor_text` before replacing, and report `anchor_stale` rather than guessing.
- constraints (`max_len`, `placeholders`, `tone`) are enforced at approval. a save that exceeds `max_len` or drops a declared placeholder is refused.
- `await_approved` times out to `resolved: false` plus per-id statuses plus `poll_again_after_ms`; a timeout is never an error.
- every entry carries exactly one file provenance: `file_content` (the whole file at filing time) or `file_hash` (sha256 hex). sending both or neither is refused.
