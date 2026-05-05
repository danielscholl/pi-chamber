# pi-chamber — Agent Instructions

This repo is a **Pi extension package** that ships six composable features (genesis, mind, room, observatory, assembly, procedures). It is consumed by Pi workspaces either via `npm:pi-chamber` or via relative paths during local development.

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

mind/index.ts           # /mind direct-chat runtime wiring (+ /mind retire branch)
mind/core.ts            # pure /mind helpers + validation
mind/retire.ts          # /mind retire orchestration: safety checks + removeMindOnce

room/index.ts                 # /room, /halt, /next, /inject runtime wiring
room/core.ts                  # parsing, validation, state restore, saved-room/transcript IO
room/prompts.ts               # speaker / moderator / synthesis / opener prompt builders + parsers
room/spawn.ts                 # child pi spawn helper, NDJSON parsing, concurrency limiter
room/turn-orchestration.ts    # per-turn glue: builds minds, context, persists, emits messages
room/strategies/              # one file per orchestration strategy; index re-exports executeStrategy
  index.ts                    # public surface: executeStrategy + re-exported types
  types.ts                    # shared type contract (OrchestrationContext, StrategyInput, ...)
  shared.ts                   # cross-strategy helpers (emptyResult)
  concurrent.ts               # parallel takes
  sequential.ts               # ordered refinement chain
  group-chat.ts               # moderator routes the floor (+ optional speakerAddressing)
  open-floor.ts               # speakers route the floor among themselves
  _test-helpers.ts            # fixtures shared by the per-strategy test files
room/ui.ts                    # palette, message renderers, participant-bar factory
room/observatory.ts           # writes a status-board observatory lens mirroring live room state

observatory/index.ts         # /observatory runtime wiring + TUI overlay launch
observatory/core.ts          # discovery, validation, path-containment helpers, lens data reader
observatory/tui/             # TUI overlay component, render-* modules, input handling, watcher

assembly/index.ts            # /assembly extension entry; wires deps from genesis primitives
assembly/core.ts             # orchestration: arg parsing, propose, confirm loop, batch author, room/lens save, audit
assembly/prompts.ts          # team proposal prompt builder + strict JSON parser
assembly/signals.ts          # bounded repo signal collector (README, AGENTS, CLAUDE, manifest, dirs, existing minds)

procedures/index.ts          # /procedures extension entry; subcommand router (run/list/show/status/halt)
procedures/core.ts           # path resolution, discovery wrappers, arg parsing, command-file resolution
procedures/loader.ts         # YAML parse + Zod validate + warning channel; calls validateDagShape
procedures/executor.ts       # layered DAG run loop; spawn dispatch; persistence + event emission
procedures/store.ts          # filesystem-backed run state under .pi/procedures/runs/<id>/
procedures/spawn.ts          # minimal child-pi spawn helper (slimmed from room/spawn.ts; duplicated, not imported)
procedures/conditions.ts     # `when:` expression evaluator (ported from Archon, pure)
procedures/triggers.ts       # checkTriggerRule (ported from Archon, pure)
procedures/graph.ts          # buildTopologicalLayers + validateDagShape (ported from Archon, pure)
procedures/substitute.ts     # $ARGUMENTS / $1..$9 / $nodeId.output[.field] substitution (ported from Archon, pure)
procedures/prompts.ts        # canned message strings for the slash command surface
procedures/ui.ts             # working-panel + per-node notify wrapper for run progress
procedures/nodes/            # one file per node-type handler; dispatched via selectHandler
procedures/schema/           # vendored Archon Zod schemas; sync sha in ARCHON_VERSION.md
procedures/defaults/         # bundled example workflows (hello-world, status-report, classify-changes)
procedures/test-fixtures/    # vendored Archon default workflows for the loader conformance test

shared/session-exit.ts       # shared /exit command coordinator (mind + room)
shared/notice.ts             # toast / transient panel / working-panel primitives (used by assembly + procedures)
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

## Mind rules

- `/mind` activates a Genesis mind in the current main Pi session via system-prompt injection at every `before_agent_start`. There is no child Pi process and no session swap; the mind's persona, durable memory, rules, log, and shared doctrine are appended to the parent session's system prompt. Activation is instantaneous (no TUI flicker).
- Mind files are re-read every turn so that edits to `memory.md`, `rules.md`, or `log.md` become live on the next turn. Do not cache.
- `/mind` does **not** apply `mind-config.json` (`tools`, `model`, `fallbackModels`). That file is consumed only by `/room` when spawning per-mind child Pi processes. Direct-chat inherits the parent session's tool surface and model by design: direct-chat *is* the parent session. If a mind needs restricted tools or a specific model, run it inside a room.
- Two end verbs:
  - `/leave` (priority 20 mind target; priority 10 room target) stops persona injection and persists a `mind-state` deactivation entry. The conversation continues in the *same* session; the mind chat history bridges back into the parent transcript. No session swap.
  - `/detach` rewinds. At activation we capture the session leaf id; on `/detach` we fork at that id (`ctx.fork(preMindLeafId, { position: "at" })`) and switch into the fork. The original session, with the mind chat, is preserved as an artifact. The fork starts clean (no persona injection, no carried turns). If `ctx.fork` is unavailable or the captured leaf id is missing, `/detach` falls back to a `/leave`-style cleanup with a warning.
- After `/leave` (not `/detach`), the next `before_agent_start` injects a one-shot "Mind Mode Off" guard naming the previously-active mind, then clears. Subsequent turns run with the unmodified base system prompt. `/detach` does not need this guard because the new (forked) session's transcript never adopted the mind's voice.
- Slugs that exact-match a `/mind` subcommand keyword (`help`, `list`, `create`, `new`, `retire`) are reserved by `normalizeMindSlug` so such names cannot become discoverable minds. `off` is intentionally not reserved.
- `/mind retire [slug]` is the inverse of `/genesis`: full single-mind teardown via the genesis-side `removeMindOnce` primitive (`.pi/minds/<slug>/`, `.pi/agents/<slug>.md`, and the `.pi/observatory/lenses/<slug>-newspaper/` lens). Refuses when the slug is currently active in mind mode (the user must `/leave` or `/detach` first), and when any saved room references the slug (the error message points to `/room close <room-slug>` or `/assembly adjourn <team-slug>` depending on provenance). Audit lives on the existing `genesis` stream as `action: "remove"` with `source: "mind-retire"`. Keep deterministic logic in `mind/retire.ts`; do not duplicate `removeMindOnce`.

## Room rules

- Keep v1 project-local. The room extension owns each turn directly and spawns child `pi --mode json -p --no-session --no-extensions` processes per mind for real A2A streaming. Do **not** route through the parent-assistant `subagent` tool.
- Do not add Chamber desktop dependencies, network calls, registries, lens coupling, or writes to `.pi/minds`.
- Keep deterministic logic split across pure modules with Bun tests:
  - `room/core.ts` — parsing, validation, state restore, saved-room IO, transcript IO
  - `room/prompts.ts` — speaker/moderator/synthesis/opener prompt builders, JSON parsing, control-JSON stripping
  - `room/spawn.ts` — child pi spawn helper, NDJSON parsing, concurrency limiter
  - `room/turn-orchestration.ts` — per-turn glue between the host extension and `executeStrategy`
  - `room/strategies/` — one file per mode (`concurrent.ts`, `sequential.ts`, `group-chat.ts`, `open-floor.ts`); `index.ts` exposes `executeStrategy` and the shared type contract from `types.ts`
  - `room/ui.ts` — palette, message renderers, participant-bar factory
- The runtime extension `room/index.ts` owns: command registration, message-renderer registration, `on("input")` turn capture, `setWidget` participant bar, `setStatus` + `setWorkingIndicator` footer feedback, saved-room/transcript persistence, and observatory lens mirroring.
- Director shortcuts available during an active room:
  - `/halt` aborts the in-flight orchestration (SIGTERM in-flight spawns; partial replies persist marked aborted).
  - `/next <slug>` overrides the next-speaker pick for one turn (group-chat or open-floor).
  - `/inject <text>` prepends a director note to the next speaker's prompt (group-chat or open-floor; in open-floor it lands as the addressed `reason`).
  - `@<slug> <message>` directly addresses one mind, bypassing the room strategy for that single turn.
- Observatory mirroring is reload-based: `room/observatory.ts` writes a `status-board` lens at `.pi/observatory/lenses/room/` whenever room state changes. The directory is gitignored. The lens is removed on `/leave` or `/detach` and on session restore failures.
- Saved rooms live at `.pi/rooms/<slug>/room.json` (durable config) and `.pi/rooms/<slug>/transcript.jsonl` (append-only history). Both are gitignored in the consumer project.
- The bare `/room` invocation is a picker: select a saved room, create a new one, or close one. Power-user subcommands (`on`, `mode`, `minds`, `clear`) still work but are not advertised in autocomplete. `close` is advertised in autocomplete and accepts an optional slug.
- `/room close [slug]` is the named alias for the picker's "Close a saved room…" entry: deletes `.pi/rooms/<slug>/` (room.json + transcript + sessions). Refuses on rooms with `assembledBy === "assembly"` and points the user at `/assembly adjourn`. If the target is the currently-active room, `leaveRoom` is called first so live state is not torn out. The picker entry and the named subcommand share `runCloseSavedRoom`; keep them unified.
- Saved rooms (`.pi/rooms/<slug>/room.json`) accept optional fields beyond the core schema:
  - `groupChat: { maxTurns?, minRounds?, maxSpeakerRepeats? }` overrides the per-turn group-chat caps.
  - `synthesizer: "<slug>"` replaces the default `chairman` moderator (group-chat) or sets the closing voice (open-floor).
  - `concurrentSynthesis: true | "chairman" | "<slug>"` enables an optional synthesis turn after concurrent rounds (default off).
  - `forkPerMind: boolean` enables persistent per-mind sessions.
  - `speakerAddressing: boolean` (group-chat only) lets speakers emit a JSON tail suggesting the next speaker; the moderator is biased toward honoring it but still enforces repeat-cap and round-floor.
  - `openFloor: { maxTurns?, minRounds?, maxSpeakerRepeats?, endVoteThreshold? }` (open-floor only) tunes the speaker-routed loop. `endVoteThreshold` is a fraction (0..1] of speakers that must vote `end` after `minRounds` is met before the room closes early; default 0.5.
  - `opener: "chairman" | "<slug>"` (open-floor only) sets the optional opening voice; defaults to first participant when absent.
  - Hand-edit `room.json` to set them; malformed values silently revert to defaults.
- Per-mind config: optional `.pi/minds/<slug>/mind-config.json` carries `{ tools?: string[], model?: string, fallbackModels?: string[] }`. When present, `tools` becomes a child Pi `--tools` allowlist; `model` overrides the default model for that mind; `fallbackModels` are tried in order if the primary fails with a model-side error. Malformed individual fields silently coerce to undefined (room activation never blocks on misshapen config).
- Forked per-mind sessions: when a saved room sets `forkPerMind: true`, each mind's child Pi runs with `--session .pi/rooms/<roomSlug>/sessions/<mindSlug>.session.jsonl` so the mind keeps its own conversational history across turns of the same room. Cost: session-file growth proportional to rooms × minds × turns. Use `/room reset [<slug>]` to drop them. The `sessions/` directory is gitignored along with the rest of `.pi/rooms/`.
- When a room is active, all non-slash user input is captured by the extension and routed to the mind orchestrator. Use `/leave` to leave the room (round stays in the current session) or `/detach` to rewind and preserve the round as an artifact, before talking to the parent assistant again.
- Room activation is in-place (no session swap, no TUI flicker), mirroring `/mind`. The leaf id captured at activation is stored on the room state as `preRoomLeafId`; `/detach` forks at that point. If the leaf id is missing or `ctx.fork` is unavailable, `/detach` falls back to `/leave` with a warning.
- Treat live room state as session-local via `pi.appendEntry`; saved-room files own durable cross-session continuity. Durable mind memory remains owned by Genesis minds.
- Supported v1 modes are `concurrent`, `sequential`, `group-chat`, and `open-floor`; handoff and magentic are future modes until explicitly approved. Open-floor lets speakers route the floor among themselves via address tails (`{action: "address" | "pass" | "end"}`); the chairman participates only as an optional opener and/or synthesizer.
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

## Assembly rules

- `/assembly` orchestrates Genesis primitives; it must not duplicate the single-mind authoring pipeline. Use `authorMindOnce` exported from `genesis/index.ts` as the only authoring path. If new authoring behavior is needed, add it to genesis and reuse from assembly.
- Live `/assembly` runs the proposal step in a child Pi process via `--no-extensions` (using `genesis/spawn.ts`); per-member authoring also runs in child Pi processes through `authorMindOnce`. The proposal returns strict JSON with no fallback parsers.
- Repo signals are bounded: `README.md`, `AGENTS.md`, `CLAUDE.md`, the first detected manifest, and a depth-1 directory listing only. Per-file cap is 4 KB. Never recurse, never read `.env*`, never call the network. Failures are swallowed (best-effort snapshot).
- Existing minds are surfaced to the proposer so it does not propose colliding slugs. Before authoring, the orchestrator re-validates against `listGenesisMinds` and rejects collisions defensively.
- Output stays inside the consumer project: `.pi/minds/<slug>/`, `.pi/agents/<slug>.md`, `.pi/rooms/<team-slug>/room.json`, `.pi/observatory/lenses/<team-slug>-team/`. No registry, no commits.
- Team rooms always save with `mode: "open-floor"`, `opener: "chairman"`, `synthesizer: "chairman"`, the default `openFloor` tunables, and `assembledBy: "assembly"` as a provenance marker. `assembly/core.ts:ASSEMBLE_OPEN_FLOOR_DEFAULTS` is the single source of truth for the strategy values.
- Confirmation UX is mandatory: approve / drop / edit (member or team metadata) / regenerate (with optional feedback) / cancel. Non-UI callers are refused; do not add a `--yes` headless mode unless explicitly approved.
- Batch authoring uses `mapWithConcurrencyLimit` from `room/spawn.ts` with a cap of 3. Partial failures preserve successful minds; the room is saved with the surviving slugs and the audit entry records both `succeeded` and `failed` arrays.
- Default team naming: when no saved room with slug `assembly` exists, the proposer is asked to use `"assembly"` and the orchestrator overrides any other choice deterministically. When `assembly` is taken, the proposer's contextual choice is honored. `ASSEMBLE_DEFAULT_TEAM_SLUG` and `ASSEMBLE_DEFAULT_TEAM_NAME` in `assembly/core.ts` are the single source of truth.
- `/assembly adjourn [slug]` is the inverse: it removes a team's room, team lens, and every member's mind directory + shim + newspaper lens. It refuses to operate on rooms without `assembledBy === "assembly"` (those belong to `/room delete`). Members shared with another saved room are preserved; the partition is shown in the confirmation dialog.
- Adjourn uses the genesis-side primitive `removeMindOnce(slug, cwd, config, appendEntry)` for per-mind teardown. `removeNewspaperLens` and `removeTeamStatusBoard` in `observatory/core.ts` are the lens inverses. Don't add ad-hoc removal paths.
- Keep deterministic logic split across pure modules with Bun tests: `assembly/signals.ts` (signal collection), `assembly/prompts.ts` (proposal prompt builder + parser), `assembly/core.ts` (orchestration helpers like `parseAssembleArgs`, `validateProposalForAuthoring`), `assembly/adjourn.ts` (teardown orchestration).
- Audit entries: `genesis-assemble` stream gets one entry per convene (`action: "assemble"` implicit) and one per adjourn (`action: "adjourn"`). The `genesis` stream gets one entry per mind authored (no `action` field for backward compat) and one per mind removed (`action: "remove"`). Do not double-audit.

## Procedures rules

- `/procedures` is a runtime for **Archon-compatible workflow YAMLs** — the schema is vendored under `procedures/schema/` and the conformance test (`procedures/loader.conformance.test.ts`) loads representative Archon defaults to detect drift. When upstream Archon ships a schema change, re-sync per `procedures/schema/ARCHON_VERSION.md`; do not let the schemas diverge silently.
- The runtime is intentionally narrower than Archon's. Phase 1 honors prompt + command + bash + cancel nodes plus DAG controls (`depends_on`, `when:`, `trigger_rule`); loop / approval / script nodes parse but throw a Phase-1 message at execution. Hook / agent / sandbox / MCP / `output_format` / `betas` / `fallbackModel` / `maxBudgetUsd` / `mutates_checkout` / `additionalDirectories` fields parse and warn — they do **not** alter execution. `--strict` on `/procedures run` hard-fails when any "ignored" field is present.
- Provider scope: only `provider: claude` (or omitted) is accepted at load. `provider: codex` errors with a "not supported in Phase 1" message. Do not silently fall back to claude.
- Discovery roots in precedence order (later overrides earlier on name collisions): bundled defaults → `~/.pi/procedures/` (global) → `<repo>/.pi/procedures/` (project) → `<repo>/.archon/workflows/` (zero-config Archon reuse). Discovery is filename-blind to extension other than `.yaml` / `.yml`.
- Run state lives at `.pi/procedures/runs/<id>/`: `run.json` (status + metadata), `events.ndjson` (append-only), `nodes/<id>.{json,txt}` (per-node NodeOutput + raw text), `artifacts/` (= `$ARTIFACTS_DIR` for the run). The `.txt` mirror is for human inspection only — schema reads come from `.json`. Sanitize node ids (`[^\w.-]` → `_`) before composing on-disk paths.
- Session threading mirrors Archon: in a sequential single-node layer, the prior layer's session id is forwarded as `--resume <id>` for `context !== 'fresh'` AI nodes. Parallel layers (>1 node) reset the threaded session because two nodes can't share one. Do not invent additional threading rules.
- `command:` nodes are bring-your-own. Resolution walks `<cwd>/.pi/commands/<name>.{md,prompt.md}` then `<cwd>/.archon/commands/<name>.{md,prompt.md}`. Missing-command failure prints the bring-your-own message — do not auto-fall-back to a stub prompt.
- Keep deterministic logic split per the per-feature rule: pure ports (`conditions.ts`, `triggers.ts`, `graph.ts`, `substitute.ts`) carry no Pi runtime coupling and are tested standalone. The loader (`loader.ts`), store (`store.ts`), and core (`core.ts`) are filesystem-only. Spawn (`spawn.ts`) is the only file that talks to child processes. The executor (`executor.ts`) wires them together; the slash-command index (`index.ts`) is the seam between the runtime and Pi's UI.
- Per the per-feature isolation rule, `procedures/spawn.ts` is a slimmed copy of `room/spawn.ts` rather than an import. Same convention as `genesis/spawn.ts`. If a meaningful shared utility emerges, propose moving it to `shared/` rather than cross-importing between feature folders.
- The vendored schemas keep upstream's 2-space indentation so re-syncs are clean text diffs. All other procedures files use tabs (chamber convention).
- Audit: there is no audit stream for procedures yet. Run state under `.pi/procedures/runs/<id>/` is the source of truth. Do not add a `pi.appendEntry("procedures", ...)` stream without a clear consumer.
- Bundled defaults under `procedures/defaults/` must parse with zero loader warnings — `procedures/defaults.test.ts` enforces this. Keep them simple Phase-1 examples; if a default needs a Phase-2 feature, defer the default until the feature lands.

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
