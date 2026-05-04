# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-05-03

Initial pre-release. Bundles four Pi extensions:

- **Genesis** (`/genesis`, `/genesis:<starter>`) — author durable, project-local minds under `.pi/minds/<slug>/` plus runnable shims under `.pi/agents/<slug>.md`. Live authoring runs in a child Pi subagent.
- **Mind** (`/mind <slug>`) — direct-chat into a mind via system-prompt injection; persona, memory, rules, and shared doctrine are appended each turn. Reserved-slug validation; `mind off` guard.
- **Room** (`/room`, `/halt`, `/next`, `/inject`) — multi-mind orchestration with `concurrent`, `sequential`, `group-chat`, and `open-floor` strategies. Saved rooms, transcripts, status-board observatory lens.
- **Observatory** (`/observatory`) — TUI lens viewer with sectioned briefing pages, dashboard summary, and live status board.

[Unreleased]: https://github.com/danielscholl/pi-chamber/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/danielscholl/pi-chamber/releases/tag/v0.1.0
