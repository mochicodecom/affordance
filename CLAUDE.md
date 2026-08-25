# CLAUDE.md

## Development environment

All development runs on a sprite (remote dev VM, via the sprites MCP tools), not on the local machine. Each Claude session uses its own sprite, named `affordance-<unique>` where `<unique>` is the first hyphen-separated segment of the Claude session id (visible in the session's scratchpad directory path). Create the session's sprite on first use and reuse it for the rest of the session; use only sprites named for the current session. Provision a newly created sprite by writing `scripts/provision-sprite.sh` to it and executing it there — it installs pnpm and postgres, registers postgres as a sprite service, and creates the `sprite` superuser role and `sprite` database, in under a minute.

At session end, a SessionEnd hook (`.claude/settings.json`) stops every service on the session's sprites and deletes any service that registers an `http_port`, so every endpoint service must be recreatable from the repo.

Note: the sprites `exec` tool splits its `cmd` string on whitespace into command + args — shell quoting does not survive, so pass plain commands without quotes, or write a script file on the sprite and execute it.

## Agent skills

### Issue tracker

Issues live as local markdown files under `.scratch/<feature-slug>/` in this repo — there is no remote issue tracker. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its name, recorded as a `Status:` line on each issue file. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` (vocabulary) and one `docs/architecture.md` (the architecture and the reasoning behind it) at the repo root. See `docs/agents/domain.md`.

### Prose style

Plain, literal prose in every doc comment and doc an agent writes or reviews — state the claim, unpack any term of art. See `docs/agents/prose.md`.
