# Pi Chamber

A Pi extension package that bundles four composable features for the Pi coding agent: durable agent identities (Genesis minds), direct-chat into a mind, multi-mind orchestration, and a TUI lens viewer.

```text
/genesis  →  author a mind under .pi/minds/<slug>/
/mind     →  direct-chat into a mind
/room     →  run multiple minds together
/observatory →  view mind-authored briefing and status lenses
```

## What's inside

| Feature | Command | Purpose |
|---|---|---|
| **Genesis** | `/genesis`, `/genesis:<starter>` | Generate durable, project-local minds under `.pi/minds/<slug>/` plus runnable shims under `.pi/agents/<slug>.md`. Live authoring runs in a child Pi subagent. |
| **Mind mode** | `/mind <slug>` | Activate a mind in the current session via system-prompt injection. Persona, durable memory, rules, log, and shared doctrine are appended each turn. No session swap. |
| **Room** | `/room` (+ `/halt`, `/next`, `/inject`) | Multi-mind orchestration with `concurrent` / `sequential` / `group-chat` / `open-floor` strategies, director shortcuts, saved rooms, and live transcripts. |
| **Observatory** | `/observatory` | In-terminal TUI lens viewer that renders mind-authored briefing and status-board lenses, with a built-in Dashboard summary. Genesis seeds a starter newspaper lens for each new mind. |

Each feature is an independent Pi extension entry — load all four for the full stack, or pick a subset.

## Install

### From git (current — pre-publish)

Add to your project's `.pi/settings.json`:

```jsonc
{
  "packages": ["git:github.com/danielscholl/pi-chamber@main"]
}
```

> Pin to a tag once releases are cut, e.g. `git:github.com/danielscholl/pi-chamber@v0.1.0`.

### From npm (future, once published)

```bash
pi install npm:pi-chamber
```

```jsonc
// .pi/settings.json
{
  "packages": ["npm:pi-chamber"]
}
```

### Local development (sibling repo layout)

If you have `pi-chamber` checked out next to your consumer project, point at the feature entries directly:

```jsonc
// .pi/settings.json
{
  "extensions": [
    "../pi-chamber/genesis/index.ts",
    "../pi-chamber/mind/index.ts",
    "../pi-chamber/room/index.ts",
    "../pi-chamber/observatory/index.ts"
  ]
}
```

## Quick Start

### Author a mind

```text
/genesis
```

Walks you through naming, role, expertise, and seed notes. Writes:

```
.pi/minds/<slug>/
  identity.md      # persona + voice
  memory.md        # durable knowledge (editable)
  rules.md         # behavioral guardrails
  log.md           # turn-by-turn log (auto-appended)
.pi/agents/<slug>.md   # runnable shim (compatible with pi-subagents)
.pi/observatory/lenses/<slug>-newspaper/   # starter briefing lens
```

Use `/genesis:<starter>` to seed from a built-in starter (run `/genesis:help` for the list).

### Direct-chat with a mind

```text
/mind researcher
```

Activates the mind in your current session. The mind's identity, memory, rules, and shared IDEA doctrine are injected on every turn — edits to `memory.md` or `rules.md` go live on the next turn. `/mind off` deactivates.

### Run multiple minds together

```text
/room
```

Pick a strategy and one or more minds:

| Strategy | Behavior |
|---|---|
| `concurrent` | Parallel takes from each mind on the same prompt |
| `sequential` | Ordered refinement chain — each mind builds on the previous turn |
| `group-chat` | A moderator routes the floor between speakers |
| `open-floor` | Speakers route the floor among themselves (peer-to-peer) |

Director shortcuts: `/halt` to stop, `/next` to advance, `/inject` to drop a fresh prompt mid-turn. Rooms can be saved and replayed; transcripts persist under `.pi/rooms/`.

### View lenses

```text
/observatory
```

Opens an in-terminal TUI overlay that discovers mind-authored lenses under `.pi/observatory/lenses/`. Briefing lenses can use a sectioned page layout (priority, metrics, activity, lists, narrative, details) or fall back to a flat card grid. Status-board lenses mirror live `/room` state.

## Recommended `AGENTS.md` snippet

For consuming projects, add a hint so agents know when to reach for `/room` and `/mind`:

```xml
<pi-chamber>
This project uses pi-chamber. Genesis minds live under `.pi/minds/<slug>/`.

**Use `/mind <slug>`** for direct-chat with a single mind in the current session.
**Use `/room`** when a task benefits from multiple perspectives (review chains, parallel takes, group decisions).
**Don't bypass Genesis authoring** — write minds via `/genesis`, not by hand-editing the directory.
</pi-chamber>
```

## Layout

```
genesis/        Genesis authoring + storage + subagent spawn
mind/           /mind direct-chat (system-prompt injection)
room/           /room orchestration; strategies live in room/strategies/
observatory/    Lens server + TUI renderer + widgets
shared/         session-exit (used by mind + room)
```

See `AGENTS.md` for the full operational contract: per-feature rules, important paths, and Genesis authoring constraints.

## Develop

```bash
bun install
bun test          # 42 test files, run via bun test
bun run typecheck # tsc --noEmit
bun run build     # tsc -p tsconfig.build.json (emits dist/)
```

This package targets the Pi runtime; `@mariozechner/pi-coding-agent` and `@mariozechner/pi-tui` are peer dependencies provided by Pi.

## License

MIT — see [LICENSE](./LICENSE).
