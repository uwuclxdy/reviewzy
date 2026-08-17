---
description: File user-facing copy for human approval, then apply it in a later session
argument-hint: "[project]"
---

file user-facing copy through reviewzy so a human approves it before it lands. follow the reviewzy skill workflow.

1. project slug: `$ARGUMENTS` if given, else the repo directory name.
2. read the project style guide, then find the strings to file (CLI help, TUI strings, web UI strings, error messages).
3. call `file_entries` with the slug and entries. each entry carries the exact `anchor_text`, a proposed `agent_draft`, and any `constraints`.
4. report the returned `dashboard_url` and tell the user to approve there. stop after filing.

apply is a later session: `fetch_approved`, re-read the file, replace the anchor, then `mark_applied`.
