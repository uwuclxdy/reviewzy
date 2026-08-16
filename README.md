<div align="center">

# reviewzy

**human-in-the-loop mcp review for user-facing text: agents file the strings they want to write, a human authors or approves them on a dashboard, and any later agent session applies the approved words in place**

bulk-audit and rewrite user-facing copy across CLIs, TUIs, web UIs, and websites; prose authorship stays human

[![license](https://shields.uwuclxdy.dev/badge/license-AGPL--3.0-blue)](#license)
[![mcp](https://shields.uwuclxdy.dev/badge/mcp-2026--07--28-orange)](https://modelcontextprotocol.io)

</div>

---

reviewzy is a self-hosted dashboard and mcp server for human-in-the-loop copy review. a coding agent files the exact strings it wants to write or rewrite (repo, file, current text, context lines), and a human authors or approves each one on the dashboard. any later agent session fetches the approved words back and applies them in place. no i18n keys, no content layer: each entry points at the string where it already lives.

an agent files a batch, then a human signs off:

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

```json
{
  "batch_id": "01M060XY9GNK6ANVENN4Y4MK7N",
  "results": [
    { "id": "01M060XY9GAT0FD611BT1BV18J", "status": "draft", "deduped": false, "updated": false }
  ],
  "dashboard_url": "http://127.0.0.1:3123/?project=my-app"
}
```

the entry lands as `draft`. the human authors it on the dashboard, or rejects it, and the next agent session applies the approved text and reports back through `mark_applied`. an agent can never approve.

## Why

- **File + snippet anchors, no i18n keys:** an entry names a repo, a file, the exact current text, and context lines; apply-back is a targeted replace in place. nothing gets externalized into a content layer.
- **Humans author, agents apply:** the status machine is server-enforced. an agent files drafts and applies approved text; only the dashboard can reach `approved` or `rejected`.
- **Append-only revision history:** every human save appends a revision row, so an edit is undoable and the history of how a line evolved survives archiving.
- **Per-project style guide as a resource:** one global guide plus per-project rules merge into a single mcp resource, and `fetch_approved` embeds the same merged text, so a bulk rewrite shares one voice.
- **ntfy and webhook notifications:** one ping per filing batch, debounced; each transport toggles separately in `.env`.
- **Archive retention:** applied entries move into archive tables after `ARCHIVE_AFTER_DAYS` (default 90), revisions included, in one transaction.

## How it works

| stage | who | what happens |
|---|---|---|
| file | agent | calls `file_entries` through the stdio shim, which finds or spawns one shared daemon and forwards the request |
| notify | daemon | pings ntfy and/or the webhook with a dashboard link |
| author | human | opens the dashboard, edits, approves, or rejects; saving prose releases the entry as `approved` |
| fetch | agent | a later session calls `fetch_approved` (or blocks on `await_approved`) and gets the text, anchor, constraints, and merged style guide |
| apply | agent | re-reads the file, replaces the anchor with the approved text, reports through `mark_applied` |
| archive | daemon | applied entries older than `ARCHIVE_AFTER_DAYS` move to the archive with their revisions |

one daemon per machine holds the sqlite store and serves the dashboard and a stateless `2026-07-28` mcp endpoint, so concurrent agent sessions share one queue and one dashboard.

## Install

```sh
bunx reviewzy@latest
```

requires bun >= 1.3. the store is `bun:sqlite`, which is bun-only, so there is no `npx` form. the shim spawns one shared daemon per machine on first use; nothing else to install.

from a checkout of this repo:

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

then open http://127.0.0.1:3123/ in a browser for the dashboard, and point an mcp client at reviewzy (below) to start filing.

## Configuration

copy `.env.example` to `.env` and edit. every key is optional; an unset key takes the default shown. a bad value refuses startup, naming the variable.

| key | default | what it does |
|---|---|---|
| `REVIEWZY_PORT` | `3123` | port for the dashboard and the mcp endpoint; the bind is `127.0.0.1` always |
| `REVIEWZY_DB` | `~/.local/share/reviewzy/reviewzy.db` | sqlite file (`$XDG_DATA_HOME` respected) |
| `REVIEWZY_BASE_URL` | `http://127.0.0.1:$REVIEWZY_PORT` | absolute dashboard url used in notification links |
| `REVIEWZY_TOKEN` | unset | bearer token guarding the mcp endpoint; set it and it is required |
| `DASHBOARD_PASSWORD` | unset | dashboard password (login form plus signed session cookie); set it and it is required |
| `ARCHIVE_AFTER_DAYS` | `90` | days an applied entry waits before archiving |
| `NTFY_URL` | unset | ntfy server; ntfy fires only when `NTFY_URL` and `NTFY_TOPIC` are both set |
| `NTFY_TOPIC` | unset | ntfy topic |
| `NTFY_PRIORITY` | `3` | ntfy priority, `1` to `5` |
| `WEBHOOK_URL` | unset | generic webhook; posts project, batch id, count, and a dashboard link when set |

a credential left unset keeps that surface loopback-only, with a warning at startup; the loopback bind and `Origin` validation are unconditional.

## Integrations

point a mcp client at the published entrypoint:

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

every session that starts it shares the one daemon and the one queue on that machine. the shim resolves `@latest` on each session start; when a newer shim outranks the running daemon, it drains it and starts the new version.

from a checkout, point the client at the local shim:

```json
{
  "mcpServers": {
    "reviewzy": {
      "command": "bun",
      "args": ["run", "bin/reviewzy"]
    }
  }
}
```

the endpoint speaks the stateless `2026-07-28` mcp revision over streamable http.

## Comparison

| | reviewzy | Contentrain | gotoHuman | Ditto |
|---|---|---|---|---|
| authorship | human authors, agent files and applies | agent authors, human approves | human edits text in form fields | team edits a live library |
| code integration | file + snippet anchors, no externalization | restructures the repo into a content layer | generic forms, no write-back | no code patch-back |
| hosting | self-hosted | self-hosted | saas only | saas only |
| queue | async queue plus blocking long-poll, one server | queue, git/PR-first review | async queue | none; edits land live |

the blocking human-in-the-loop mcp family (interactive-mcp and friends) pops a dialog and blocks one call: no queue, no persistence, no dashboard.

## FAQ

**How do I approve AI-generated text before it lands in my code?** the agent files the strings as draft entries, you author or approve them on the dashboard, and the agent applies the approved text. an agent can never reach `approved` on its own.

**Can an AI agent rewrite my CLI help text without i18n keys?** yes. entries anchor on the exact current strings, and apply-back is a targeted replace. no keys, no content layer.

**How do I bulk-rewrite all user-facing copy in a codebase with a coding agent?** file batches per project, group by project or batch on the dashboard, approve in bulk with a before/after diff, then let a later agent session fetch and apply.

**How do I update the style guide my agents read?** edit it on the dashboard at `/style-guide`. the merged guide reaches agents through the mcp resource and inside `fetch_approved`. the resource carries a 60-second cache hint, so a saved edit can take up to 60s to reach an agent that already cached the guide.

**How does reviewzy compare to gotoHuman?** both queue work for a human on a dashboard. reviewzy is self-hosted, anchors live source strings, and lets the agent apply the approved result; gotoHuman is a saas of generic form fields with no code write-back.

## Development

```sh
bun run check  # tsc --noEmit && bun test
```

## License

[AGPL-3.0](LICENSE). self-hosted stays self-hosted; a saas wrapping it publishes its changes.
