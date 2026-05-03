# pi-chamber — Agent Instructions

This repo is a **Pi extension package** that ships four composable features (genesis, mind, room, observatory). It is consumed by Pi workspaces either via `npm:pi-chamber` or via relative paths during local development.

For user-facing context, read `README.md`. This file is the operational contract for coding agents working in this repo.

## Current priorities

- Treat each feature folder as a small, focused Pi extension entry. The `index.ts` in each folder is the public Pi extension contract; the surrounding files are implementation detail.
- Keep deterministic logic (parsing, validation, prompt building, path resolution) in `core.ts` / `prompts.ts` modules so it can be tested without a live Pi runtime.
- Prefer small, reversible changes with tests for deterministic helpers.
- Don't add features, refactor, or introduce abstractions beyond what the task requires.

## Important paths

```text
genesis/index.ts             # /genesis, /genesis:<starter>, genesis_write_files tool
genesis/core.ts              # pure helpers + validation + subagent JSON parser
genesis/prompts.ts           # authoring prompt (legacy + subagent JSON variant) + shim builder
genesis/spawn.ts             # child-Pi spawn helper for /genesis subagent authoring
genesis/starters.ts          # built-in starter metadata

mind/index.ts           # /mind direct-chat runtime wiring
mind/core.ts            # pure /mind helpers + validation

room/index.ts        # /room, /halt, /next, /inject runtime wiring
room/core.ts         # parsing, validation, state restore, saved-room/transcript IO
room/prompts.ts      # speaker / moderator / synthesis prompt builders
room/spawn.ts        # child pi spawn helper, NDJSON parsing, concurrency limiter
room/strategies.ts   # concurrent / sequential / group-chat orchestration
room/ui.ts           # palette, message renderers, participant-bar factory
room/observatory.ts  # writes a status-board observatory lens mirroring live room state

observatory/index.ts         # /observatory runtime wiring + TUI overlay launch
observatory/core.ts          # discovery, validation, path-containment helpers, lens data reader
observatory/tui/             # TUI overlay component, render-* modules, input handling, watcher

shared/session-exit.ts       # shared /exit command coordinator (mind + room)
```

## Genesis mind orchestration

This package generates Genesis minds — durable, project-local knowledge and identity substrates backed by files under `.pi/minds/<slug>/`. Treat minds as context-bearing collaborators, not disposable workers.

When delegating to a mind, make the task mode explicit:

- **brief/research** — read-only synthesis from IDEA notes, repo files, or stated sources;
- **capture/update** — update the mind's IDEA notes only when the user explicitly asks to capture or ingest;
- **plan** — produce recommendations, risks, next steps, or decision briefs;
- **execute** — make repository changes only when the user explicitly asks for implementation.

Mind briefings are read-only unless the user explicitly asks for capture, ingest, or implementation.

Do not bypass Genesis authoring rules. Live `/genesis` requests run in a child Pi subagent (`genesis/spawn.ts`); the subagent emits a single JSON object with the seven authored fields, and the parent extension parses it and performs the project-local writes through the same validated helper used by `genesis_write_files`. The `genesis_write_files` tool stays registered for any caller that still wants the tool path, but the live `/genesis` flow no longer relies on it.

## Genesis rules

- v1 output stays inside the consumer project: `.pi/minds`, `.pi/agents`, and (when `seedLensViews` is on, the default) a starter newspaper lens under `.pi/observatory/lenses/<slug>-newspaper/`.
- Do not add network calls, registry fetches, automatic commits, lens seeding, or chamber runtime coupling unless explicitly requested.
- Live `/genesis` runs in a child Pi process (`genesis/spawn.ts`) launched with `--no-extensions`; the subagent emits one JSON object containing the seven authored fields and the parent writes the files via the same internal helper that backs `genesis_write_files`. The tool itself stays registered for compatibility but is not the live path.
- Validate path containment with robust path helpers, not string-prefix checks.
- Keep deterministic logic in `genesis/core.ts` / `genesis/prompts.ts` (including the JSON parser and the subagent prompt builder) so it can be tested without a live Pi runtime.
- Generated shims should remain compatible with `pi-subagents` frontmatter and should instruct agents to read shared IDEA doctrine plus their mind files at task start.
- `mind` reads and injects shared IDEA doctrine plus existing mind files for direct chat in the main session; it must not bypass the Genesis write helper during live `/genesis` authoring.

## Room rules

- Keep v1 project-local. The room extension owns each turn directly and spawns child `pi --mode json -p --no-session --no-extensions` processes per mind for real A2A streaming. Do **not** route through the parent-assistant `subagent` tool.
- Do not add Chamber desktop dependencies, network calls, registries, lens coupling, or writes to `.pi/minds`.
- Keep deterministic logic split across pure modules with Bun tests:
  - `room/core.ts` — parsing, validation, state restore, saved-room IO, transcript IO
  - `room/prompts.ts` — speaker/moderator/synthesis prompt builders, JSON parsing, control-JSON stripping
  - `room/spawn.ts` — child pi spawn helper, NDJSON parsing, concurrency limiter
  - `room/strategies.ts` — concurrent / sequential / group-chat orchestration
  - `room/ui.ts` — palette, message renderers, participant-bar factory
- The runtime extension `room/index.ts` owns: command registration, message-renderer registration, `on("input")` turn capture, `setWidget` participant bar, `setStatus` + `setWorkingIndicator` footer feedback, saved-room/transcript persistence, and observatory lens mirroring.
- Director shortcuts available during an active room:
  - `/halt` aborts the in-flight orchestration (SIGTERM in-flight spawns; partial replies persist marked aborted).
  - `/next <slug>` overrides the moderator's next-speaker pick for one turn (group-chat only).
  - `/inject <text>` prepends a moderator-style note to the next speaker's prompt (group-chat only).
  - `@<slug> <message>` directly addresses one mind, bypassing the room strategy for that single turn.
- Observatory mirroring is reload-based: `room/observatory.ts` writes a `status-board` lens at `.pi/observatory/lenses/room/` whenever room state changes. The directory is gitignored. The lens is removed on `/exit` and on session restore failures.
- Saved rooms live at `.pi/rooms/<slug>/room.json` (durable config) and `.pi/rooms/<slug>/transcript.jsonl` (append-only history). Both are gitignored in the consumer project.
- The bare `/room` invocation is a picker: select a saved room, create a new one, or delete one. Power-user subcommands (`on`, `mode`, `minds`, `clear`) still work but are not advertised in autocomplete.
- Saved rooms (`.pi/rooms/<slug>/room.json`) accept optional fields beyond the core schema: `groupChat: { maxTurns?, minRounds?, maxSpeakerRepeats? }` overrides the per-turn group-chat caps; `synthesizer: "<slug>"` replaces the default `chairman` moderator with a Genesis mind; `concurrentSynthesis: true | "chairman" | "<slug>"` enables an optional synthesis turn after concurrent rounds (default off); `forkPerMind: boolean` enables persistent per-mind sessions. Hand-edit `room.json` to set them; malformed values silently revert to defaults.
- Per-mind config: optional `.pi/minds/<slug>/mind-config.json` carries `{ tools?: string[], model?: string, fallbackModels?: string[] }`. When present, `tools` becomes a child Pi `--tools` allowlist; `model` overrides the default model for that mind; `fallbackModels` are tried in order if the primary fails with a model-side error. Malformed individual fields silently coerce to undefined (room activation never blocks on misshapen config).
- Forked per-mind sessions: when a saved room sets `forkPerMind: true`, each mind's child Pi runs with `--session .pi/rooms/<roomSlug>/sessions/<mindSlug>.session.jsonl` so the mind keeps its own conversational history across turns of the same room. Cost: session-file growth proportional to rooms × minds × turns. Use `/room reset [<slug>]` to drop them. The `sessions/` directory is gitignored along with the rest of `.pi/rooms/`.
- When a room is active, all non-slash user input is captured by the extension and routed to the mind orchestrator. Use `/exit` to leave the room before talking to the parent assistant again.
- Treat live room state as session-local via `pi.appendEntry`; saved-room files own durable cross-session continuity. Durable mind memory remains owned by Genesis minds.
- Supported v1 modes are only `concurrent`, `sequential`, and `group-chat`; handoff and magentic are future modes until explicitly approved.
- Per-mind colors come from `MIND_PALETTE` in `room/ui.ts` via `paletteIndexForSlug(slug)` (djb2 hash). Slot is stable across runs.

## Observatory rules

- The framework owns the TUI overlay, discovery, and validation. Minds author lenses by writing two files; do not bypass that.
- Lens files live at `.pi/observatory/lenses/<slug>/lens.json` plus a data file referenced by the manifest's `source` field.
- v1 manifest schema: `name`, `kind` (`briefing` or `status-board`), `source` (bare filename), optional `icon`, optional `description`. Anything else is silently ignored.
- `source` must be a bare filename. The framework rejects `/`, `..`, absolute paths, and the literal `lens.json`. Symlinked data files are also rejected.
- v1 lens kinds are only `briefing` and `status-board`. `form`, `table`, `detail`, `timeline`, `editor`, and `kind: "page"` are future work.
- A `briefing` data file may use either of two shapes. **Sectioned** is preferred: a JSON object with any of the reserved sections `summary`, `status`, `priority`, `metrics`, `activity`, `lists`, `narrative`, `details` — the renderer composes a page with one bordered `PriorityCard` plus labeled `Section` blocks (no other borders). **Flat** legacy: any other JSON object renders as a uniform card grid of key/value cells. Detection is automatic via `observatory/page.ts:isSectionedShape`. Unknown top-level keys in sectioned data are ignored (forward-compat).
- A `status-board` data file is an array of `{name, status, ...}` entries → status blocks. Unchanged.
- v1 has no `prompt`, no `refreshOn`, no `schema`, and no writeback. Refresh = filesystem watch (debounced 300ms) plus manual `r`.
- Keep deterministic discovery, validation, and path-containment helpers in `observatory/core.ts` with Bun tests.
- Keep render functions in `observatory/tui/render-*.ts` pure — they take data + width and return `string[]`. The component layer owns side effects (watcher, theme application, requestRender).
- The `/observatory` overlay is on-demand only. There is no `openOnStart` or `session_start` auto-mount.
- The built-in Dashboard view is synthesized in-memory from discovered lenses, the optional `room` status-board lens, the Genesis mind list, and lens-root mtimes; it is not authored as a lens on disk. The repo still ships zero lenses.
- Do not author default lenses in this repo; pi-chamber ships zero lenses. Tutorial walkthroughs may author them, but committed lenses belong with the consumer workspace, not the framework.

## Coding conventions

- Extensions are standalone TypeScript files loaded by Pi through jiti; no build step is expected for local development.
- Register Pi tools, commands, and shortcuts synchronously at extension load time, not inside event handlers.
- Use `isToolCallEventType()` for type-safe `tool_call` event handling.
- Keep edits narrow and prefer `edit` for targeted changes.
- Use `write` for new files or complete rewrites only.

## Tooling

```bash
bun install        # install local dependencies (typebox + dev deps)
bun test           # run all tests
bun typecheck      # tsc --noEmit
bun run build      # tsc -p tsconfig.build.json (emits dist/, only needed before publishing)
```

`@mariozechner/pi-coding-agent` and the `typebox` it transitively brings are provided by the Pi runtime when this package is loaded. They are listed as devDependencies / peerDependencies so local typecheck and `bun test` resolve them.

## Testing expectations

Before finishing code changes that touch any feature folder, run:

```bash
bun test
```

Docs-only changes do not require tests; say that explicitly in the final response.

## Commit convention

Use `aipr` for commits and PR descriptions when asked to commit:

```bash
git commit -m "$(aipr commit -s)"
gh pr create --title "..." --body "$(aipr pr -s)"
```
