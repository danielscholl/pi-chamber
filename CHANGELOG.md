# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Procedures** (`/procedures`) — Archon-compatible workflow runtime. Loads the same YAML schema Archon uses (vendored under `procedures/schema/` with sync sha tracked in `ARCHON_VERSION.md`) and executes the portable subset by spawning child `pi` processes. Phase 1 covers `prompt`, `command`, `bash`, and `cancel` nodes plus DAG controls (`depends_on`, `when:`, `trigger_rule`); `loop`, `approval`, and `script` nodes parse but throw a not-yet-implemented message at execution. Subcommands: `run`, `list`, `show`, `status`, `halt` (stub). Discovery walks bundled defaults → `~/.pi/procedures/` → `<repo>/.pi/procedures/` → `<repo>/.archon/workflows/` for zero-config Archon reuse. Run state lives at `.pi/procedures/runs/<id>/` (run.json + events.ndjson + per-node outputs + artifacts). Three bundled examples: `hello-world`, `status-report`, `classify-changes`. See README's compatibility table for the core / adapted / ignored field tiers; `--strict` hard-fails when any "ignored" field is present. Conformance test loads representative Archon defaults to detect upstream schema drift.

### Changed

- README and AGENTS.md updated to describe the procedures feature alongside the existing five.
- `package.json`: added `zod` (^3.25.28) as a runtime dependency for the vendored Archon schemas; added `procedures/**` to `files` and `./procedures/index.ts` to `pi.extensions`.

## [0.1.0] - 2026-05-03

Initial pre-release. Bundles four Pi extensions:

- **Genesis** (`/genesis`, `/genesis:<starter>`) — author durable, project-local minds under `.pi/minds/<slug>/` plus runnable shims under `.pi/agents/<slug>.md`. Live authoring runs in a child Pi subagent.
- **Mind** (`/mind <slug>`) — direct-chat into a mind via system-prompt injection; persona, memory, rules, and shared doctrine are appended each turn. Reserved-slug validation; `mind off` guard.
- **Room** (`/room`, `/halt`, `/next`, `/inject`) — multi-mind orchestration with `concurrent`, `sequential`, `group-chat`, and `open-floor` strategies. Saved rooms, transcripts, status-board observatory lens.
- **Observatory** (`/observatory`) — TUI lens viewer with sectioned briefing pages, dashboard summary, and live status board.

[Unreleased]: https://github.com/danielscholl/pi-chamber/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/danielscholl/pi-chamber/releases/tag/v0.1.0
