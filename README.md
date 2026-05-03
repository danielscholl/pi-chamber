# pi-chamber

Pi extension package providing four composable features for the Pi coding agent:

- **Genesis** (`/genesis`) — generate durable, project-local agent identities ("minds") under `.pi/minds/<slug>/` and runnable shims under `.pi/agents/<slug>.md`.
- **Mind mode** (`/mind <slug>`) — direct-chat into a generated mind from the main session.
- **Room** (`/room`) — multi-mind orchestration with concurrent / sequential / group-chat strategies, director shortcuts, saved rooms, and live transcripts.
- **Observatory** (`/observatory`) — in-terminal TUI lens viewer that renders mind-authored briefing and status-board lenses, with a built-in Dashboard summary view.

## Install

Once published:

```jsonc
// .pi/settings.json
{
  "packages": ["npm:pi-chamber"]
}
```

For local development (sibling repo layout), reference the feature entries directly in your workspace's `.pi/settings.json` `extensions` array:

```jsonc
{
  "extensions": [
    "../pi-chamber/genesis/index.ts",
    "../pi-chamber/mind/index.ts",
    "../pi-chamber/room/index.ts",
    "../pi-chamber/observatory/index.ts"
  ]
}
```

Each feature is an independent Pi extension entry — load all four for the full stack, or pick subsets.

## Layout

```
genesis/        Genesis authoring + storage
mind/           /mind direct-chat
room/           /room multi-mind orchestration
observatory/    Lens server + renderer
shared/         session-exit (used by mind + room)
```

See `AGENTS.md` for operational rules and conventions.

## Develop

```bash
bun install
bun test
```

This package targets the Pi runtime; `@mariozechner/pi-coding-agent` is a peer/dev dependency provided by Pi.
