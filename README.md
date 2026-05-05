# Pi Chamber

[![CI](https://github.com/danielscholl/pi-chamber/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/danielscholl/pi-chamber/actions/workflows/ci.yml)

A Pi extension package that bundles six composable features for the Pi coding agent: durable agent identities (Genesis minds), direct-chat into a mind, multi-mind orchestration, a TUI lens viewer, on-demand team assembly, and Archon-compatible workflow procedures.

```text
/genesis    →  author a mind under .pi/minds/<slug>/
/mind       →  direct-chat into a mind
/room       →  run multiple minds together
/observatory→  view mind-authored briefing and status lenses
/assembly   →  propose and author a team of minds for the project
/procedures →  run Archon-compatible scripted workflows (DAG of prompt + bash + cancel + command nodes)
```

## What's inside

| Feature | Command | Purpose |
|---|---|---|
| **Genesis** | `/genesis`, `/genesis:<starter>` | Generate durable, project-local minds under `.pi/minds/<slug>/` plus runnable shims under `.pi/agents/<slug>.md`. Live authoring runs in a child Pi subagent. |
| **Mind mode** | `/mind <slug>`, `/mind retire [<slug>]` | Activate a mind in the current session via system-prompt injection. Persona, durable memory, rules, log, and shared doctrine are appended each turn. No session swap. `/mind retire` is the inverse of `/genesis` — full per-mind teardown. |
| **Room** | `/room` (+ `/halt`, `/next`, `/inject`, `/room close [<slug>]`) | Multi-mind orchestration with `concurrent` / `sequential` / `group-chat` / `open-floor` strategies, director shortcuts, saved rooms, and live transcripts. `/room close` removes a saved room (assembly-provenance rooms route to `/assembly adjourn`). |
| **Observatory** | `/observatory` | In-terminal TUI lens viewer that renders mind-authored briefing and status-board lenses, with a built-in Dashboard summary. Genesis seeds a starter newspaper lens for each new mind. |
| **Assembly** | `/assembly [description]` | Propose a team of minds based on the current project (description plus a bounded repo scan), confirm interactively, batch-author the minds via Genesis, and auto-save an open-floor `/room` plus a team status-board lens. |
| **Procedures** | `/procedures` (+ `run`, `list`, `show`, `status`, `halt`) | Archon-compatible workflow runtime. Loads the same YAML schema Archon uses, executes the **portable subset** (prompt / command / bash / cancel nodes, `depends_on`, `when:`, `trigger_rule`) by spawning child `pi` processes. Workflows that use only the core subset run identically under both Archon and pi-chamber. |

Each feature is an independent Pi extension entry — load all six for the full stack, or pick a subset.

## Install

### From git (current — pre-publish)

Add to your project's `.pi/settings.json`:

```jsonc
{
  "packages": ["git:github.com/danielscholl/pi-chamber@main"]
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
  identity.md          # persona + voice
  memory.md            # durable knowledge (editable)
  rules.md             # behavioral guardrails
  log.md               # turn-by-turn log (auto-appended)
.pi/agents/<slug>.md   # runnable shim (compatible with pi-subagents)
.pi/observatory/lenses/<slug>-newspaper/   # starter briefing lens
```

Use `/genesis:<starter>` to seed from a built-in starter (run `/genesis:help` for the list).

### Direct-chat with a mind

```text
/mind researcher
```

Activates the mind in your current session. The mind's identity, memory, rules, and shared IDEA doctrine are injected on every turn — edits to `memory.md` or `rules.md` go live on the next turn. `/mind off` deactivates.

### Retire a mind

```text
/mind retire           # picker over Genesis minds
/mind retire <slug>    # named target
```

Full single-mind teardown after confirmation: removes `.pi/minds/<slug>/`, the `.pi/agents/<slug>.md` shim, and the `.pi/observatory/lenses/<slug>-newspaper/` lens. Refuses if the mind is currently active in this session (use `/leave` or `/detach` first) or if any saved room references it — the error message points at `/room close <room>` for hand-rolled rooms and `/assembly adjourn <team>` for assembly rooms.

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

Close a saved room with `/room close [<slug>]` (or via the bare `/room` picker's "Close a saved room…" entry). Assembly-provenance rooms are refused there — use `/assembly adjourn <team>` so member minds are torn down too.

### View lenses

```text
/observatory
```

Opens an in-terminal TUI overlay that discovers mind-authored lenses under `.pi/observatory/lenses/`. Briefing lenses can use a sectioned page layout (priority, metrics, activity, lists, narrative, details) or fall back to a flat card grid. Status-board lenses mirror live `/room` state.

### Call an assembly

```text
/assembly "I'm building a CLI for X"
```

Reads a small set of repo signals (`README.md`, `AGENTS.md`, `CLAUDE.md`, the manifest, depth-1 directory listing), proposes a team of 3-5 minds in a child Pi process, and lets you approve, drop, edit (members or team metadata), or regenerate before authoring. Each approved member is authored as a full Genesis mind (concurrency cap 3); the team auto-saves to `.pi/rooms/<team-slug>/room.json` (open-floor strategy) and a team status-board lens to `.pi/observatory/lenses/<team-slug>-team/`. Existing minds are preserved and surfaced to the proposer so duplicates are avoided.

For the common single-team case the team is named `Assembly` (slug `assembly`) automatically. Subsequent assemblies pick contextual names.

### Adjourn an assembly

```text
/assembly adjourn          # only one team: adjourns it after confirmation
/assembly adjourn <slug>   # specific team
```

Full teardown: removes the room, the team status-board lens, and each member's mind directory, runnable shim, and newspaper lens. Members that appear in another saved room are preserved with a note in the confirmation dialog. `/assembly adjourn` only operates on rooms it created; hand-rolled `/room` rooms must be removed via `/room delete`.

### Run a procedure

```text
/procedures                          # list discovered procedures + recent runs
/procedures list                     # all procedures with their source label
/procedures show <name>              # render the procedure's DAG as text
/procedures run <name> [args] [--strict]
                                     # execute a workflow end-to-end
/procedures status [<run-id>]        # recent runs (or one run's events)
/procedures halt [<run-id>]          # Phase 1: not yet implemented (Ctrl-C aborts the in-flight run)
```

Procedures are scripted multi-step workflows defined in YAML. Pi-chamber's loader and runtime are **schema-compatible with [Archon](https://github.com/dynamous-community/archon)**: any workflow YAML that uses only the core subset (see compat table below) runs identically under both runtimes.

Discovery walks four roots in precedence order: bundled defaults → `~/.pi/procedures/` (global) → `<repo>/.pi/procedures/` (project) → `<repo>/.archon/workflows/` (zero-config Archon reuse). Run state lives under `.pi/procedures/runs/<id>/` (gitignored): `run.json`, `events.ndjson`, `nodes/<id>.{json,txt}`, `artifacts/`.

#### Compatibility tiers

| Tier | Fields | Behavior |
|---|---|---|
| **Core (full parity)** | `id`, `depends_on`, `when`, `trigger_rule`, `prompt`, `bash`, `command`, `cancel`, `model`, `context` (`fresh`/`shared`), `idle_timeout`, `allowed_tools`, `denied_tools`, `systemPrompt` | Workflow runs identically under both Archon and pi-chamber. |
| **Adapted** | `provider` (only `claude` accepted in v1; codex errors at load), `model` strings (passed through unchanged), `tags` | Best-effort. Provider+model semantics differ from Archon's claude-agent-sdk path. |
| **Phase-1 ignored (warn)** | `hooks`, `agents`, `sandbox`, `betas`, `fallbackModel`, `maxBudgetUsd`, `mcp`, `skills`, `script` nodes, `loop` nodes, `approval` nodes, `additionalDirectories`, `mutates_checkout`, top-level `interactive`, `worktree.enabled`, `output_format` | The loader warns at parse time. The runtime drops the field. `--strict` makes any "ignored" field hard-fail at load. |

Phase 2 will add loop + approval execution + `output_format` JSON-schema validation. Phase 3 adds script nodes, worktree integration, and inline subagent (`agents:`) support. Hooks, sandbox, MCP, and codex provider are intentionally out-of-scope for now.

#### Authoring

Workflow YAMLs go under `.pi/procedures/<name>.yaml`. The schema is documented in [Archon's workflow guide](https://github.com/dynamous-community/archon) — every field that parses there parses here. Three bundled examples ship under `procedures/defaults/`:

- `hello-world.yaml` — single prompt smoke test
- `status-report.yaml` — bash → prompt sequential pattern
- `classify-changes.yaml` — bash → prompt → conditional bash → fan-in collector (DAG with `when:` + `trigger_rule`)

Run `/procedures show hello-world` to see what a procedure DAG renders as.

#### Phase 1 limits worth knowing about

- **`command:` nodes are bring-your-own.** Pi-chamber doesn't ship a curated command library. Workflows that reference `command: archon-implement` (or similar) fail at runtime unless the consuming project supplies the matching `.pi/commands/<name>.md` or `.archon/commands/<name>.md` file.
- **No halt / resume yet.** `/procedures halt` is a stub; use Ctrl-C. Resuming is planned for Phase 2 — the run state on disk is already shaped for it.
- **No live streaming UI.** The slash command emits one line per node start/completion. Long-running prompt nodes are silent until they finish. The animated working panel shows the run is alive.

## Recommended `AGENTS.md` snippet

For consuming projects, add a hint so agents know when to reach for each feature:

```xml
<pi-chamber>
This project uses pi-chamber. Genesis minds live under `.pi/minds/<slug>/`.

**Use `/mind <slug>`** for direct-chat with a single mind in the current session.
**Use `/room`** when a task benefits from multiple perspectives (review chains, parallel takes, group decisions).
**Use `/assembly`** to propose and author a fresh team of minds based on the project; the assembled team auto-saves as a room you can immediately run.
**Use `/procedures`** for scripted multi-step workflows (DAG of prompt + bash + cancel nodes, conditional branching, fan-in). Procedures are deterministic and reproducible — reach for them when a task is "do A, then B if A succeeds, then C and D in parallel," not when it's a conversation.
**Don't bypass Genesis authoring** — write minds via `/genesis` or `/assembly`, not by hand-editing the directory.
</pi-chamber>
```

## Layout

```
genesis/        Genesis authoring + storage + subagent spawn
mind/           /mind direct-chat (system-prompt injection)
room/           /room orchestration; strategies live in room/strategies/
observatory/    Lens server + TUI renderer + widgets
assembly/       /assembly team proposal + batch authoring orchestration
procedures/     /procedures Archon-compatible workflow runtime; schema vendored under procedures/schema/
shared/         session-exit + notice helpers (used by multiple features)
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
