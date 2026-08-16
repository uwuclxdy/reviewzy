<div align="center">

# reviewzy

**human-in-the-loop mcp review for user-facing text: agents file the strings they want to write, a human authors or approves them on a dashboard, and any later agent session applies the approved words in place**

bulk-audit and rewrite user-facing copy across CLIs, TUIs, web UIs, and websites; prose authorship stays human

[![license](https://shields.uwuclxdy.dev/badge/license-AGPL--3.0-blue)](#license)
[![mcp](https://shields.uwuclxdy.dev/badge/mcp-2026--07--28-orange)](https://modelcontextprotocol.io)

</div>

---

reviewzy is a self-hosted dashboard and mcp server for human-in-the-loop copy review. a coding agent files the exact strings it wants to write or rewrite, and a human authors or approves each one. any later agent session fetches the approved words and applies them in place. no i18n keys, no content layer: each entry points at the string where it already lives.

```json
{
  "project": "my-app",
  "entries": [
    {
      "repo": "https://github.com/me/my-app",
      "file": "src/cli/main.ts",
      "anchor_text": "error: something went wrong",
      "agent_draft": "error: could not reach the reviewzy daemon",
      "file_content": "#!/usr/bin/env bun\nconsole.error(\"error: something went wrong\")\n",
      "constraints": { "max_len": 48, "tone": "plain, lowercase" }
    }
  ],
  "filed_by": "help-text-audit"
}
```

the call answers `batch_id 01M060XY9GNK6ANVENN4Y4MK7N` with the entry as `draft`, plus a `dashboard_url` for the batch. an agent can never approve: the human authors or rejects on the dashboard, and a later agent session applies through `mark_applied`.

## Why

- **file + snippet anchors, no i18n keys:** apply-back is a targeted replace in place
- **humans author, agents apply:** the status machine is server-enforced; only the dashboard reaches `approved` or `rejected`
- **per-project style guide as an mcp resource:** merged with the global guide, embedded in `fetch_approved`
- **append-only revision history:** every save is undoable, and history survives archiving
- **ntfy and webhook notifications, archive retention:** one ping per filing batch; applied entries archive after `ARCHIVE_AFTER_DAYS`

## How it works

| stage | who | what happens |
|---|---|---|
| file | agent | `file_entries` through the stdio shim, which finds or spawns one shared daemon |
| notify | daemon | pings ntfy and/or the webhook with a dashboard link |
| author | human | edits, approves, or rejects on the dashboard; saving prose releases it as `approved` |
| fetch | agent | `fetch_approved` (or a blocking `await_approved`) returns text, anchor, constraints, and the merged style guide |
| apply | agent | replaces the anchor, reports through `mark_applied` |
| archive | daemon | applied entries past `ARCHIVE_AFTER_DAYS` move to the archive with their revisions |

## Install

```sh
bunx reviewzy@latest
```

requires bun >= 1.3 (the store is `bun:sqlite`, bun-only; no `npx` form). the shim spawns one shared daemon per machine on first use.

from a checkout:

```sh
bun install
bun run daemon
```

## Usage

```sh
curl http://127.0.0.1:3123/health
```

```json
{"name":"reviewzy","version":"0.1.0","pid":4172598,"nonce":"881f0e93-8dde-4c75-b559-d2e3d3b223f0","startedAt":"2026-08-16T19:31:28.640Z"}
```

open http://127.0.0.1:3123/ for the dashboard. point an mcp client at reviewzy to start filing:

```json
{
  "mcpServers": {
    "reviewzy": {
      "command": "bunx",
      "args": ["reviewzy@latest"]
    }
  }
}
```

the shim resolves `@latest` per session and drains a stale daemon on upgrade. the endpoint speaks the stateless `2026-07-28` mcp revision.

## Configuration

copy `.env.example` to `.env` and edit. every key is optional; a bad value refuses startup.

| key | default | what it does |
|---|---|---|
| `REVIEWZY_PORT` | `3123` | dashboard and mcp port; the bind is `127.0.0.1` always |
| `REVIEWZY_DB` | `~/.local/share/reviewzy/reviewzy.db` | sqlite file (`$XDG_DATA_HOME` respected) |
| `REVIEWZY_BASE_URL` | `http://127.0.0.1:$REVIEWZY_PORT` | dashboard url used in notification links |
| `REVIEWZY_TOKEN` | unset | bearer token guarding mcp; set it and it is required |
| `DASHBOARD_PASSWORD` | unset | dashboard login; set it and it is required |
| `ARCHIVE_AFTER_DAYS` | `90` | days an applied entry waits before archiving |
| `NTFY_URL` + `NTFY_TOPIC` | unset | ntfy server and topic; ntfy fires only when both are set |
| `NTFY_PRIORITY` | `3` | ntfy priority, `1` to `5` |
| `WEBHOOK_URL` | unset | generic webhook; posts project, batch id, count, and a dashboard link |

a credential left unset keeps that surface loopback-only with a startup warning.

## Comparison

| | reviewzy | Contentrain | gotoHuman | Ditto |
|---|---|---|---|---|
| authorship | human authors, agent files and applies | agent authors, human approves | human edits form fields | team edits a live library |
| code integration | anchors on live strings, no externalization | restructures the repo into a content layer | generic forms, no write-back | no code patch-back |
| hosting | self-hosted | self-hosted | saas only | saas only |
| queue | async queue plus blocking long-poll | queue, git/PR-first review | async queue | none |

the blocking human-in-the-loop mcp family pops a dialog per call: no queue, no persistence, no dashboard.

## FAQ

**How do I approve AI-generated text before it lands in my code?** the agent files strings as drafts, you author or approve them on the dashboard, the agent applies. an agent can never reach `approved` on its own.

**Can an AI agent rewrite my CLI help text without i18n keys?** yes. entries anchor on the exact current strings; apply-back is a targeted replace.

**How do I bulk-rewrite all user-facing copy in a codebase?** file batches per project, group by project or batch on the dashboard, approve in bulk with a before/after diff, then let a later agent session fetch and apply.

**How do I update the style guide my agents read?** edit it on the dashboard at `/style-guide`. the resource carries a 60-second cache hint, so a saved edit can take up to 60s to reach an agent that already cached it.

## Development

```sh
bun run check  # tsc --noEmit && bun test
```

## License

[AGPL-3.0](LICENSE). self-hosted stays self-hosted; a saas wrapping it publishes its changes.
