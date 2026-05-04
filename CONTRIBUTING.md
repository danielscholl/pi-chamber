# Contributing to pi-chamber

Thanks for helping test and improve pi-chamber. The package is pre-publish; the workflow below assumes you're installing it directly from GitHub and either filing issues or proposing patches.

## Install for testing

pi-chamber is a Pi extension, so it lives inside a Pi workspace. Add it to your project's `.pi/settings.json`:

```jsonc
{
  "packages": ["git:github.com/danielscholl/pi-chamber@main"]
}
```

To pin a specific commit while reproducing a bug, replace `main` with the SHA:

```jsonc
{
  "packages": ["git:github.com/danielscholl/pi-chamber@<sha>"]
}
```

The README covers the per-feature commands (`/genesis`, `/mind`, `/room`, `/observatory`, `/assembly`).

## Filing bugs

Use the [bug report](.github/ISSUE_TEMPLATE/bug_report.yml) issue template. The fields exist because they're the ones that are usually missing: Pi version, pi-chamber commit, OS, and the exact `/command` sequence that triggered the failure.

If the bug involves persisted state, include the relevant snippet from `.pi/minds/<slug>/`, `.pi/rooms/<slug>/room.json`, or `.pi/observatory/lenses/<slug>/` after redacting anything sensitive.

## Local development

Requires [Bun](https://bun.sh).

```bash
bun install
bun run check     # typecheck + tests + build (mirrors CI)
```

Individual targets:

```bash
bun run typecheck # tsc --noEmit
bun test          # 48 test files via bun's runner
bun run build     # tsc -p tsconfig.build.json (emits dist/)
```

`AGENTS.md` is the operational contract for this repo: per-feature rules, important paths, and Genesis authoring constraints. Skim it before non-trivial changes.

## Pull requests

1. Branch from `main`.
2. Keep changes small and reversible. The repo follows the rule from `AGENTS.md`: don't add features, refactor, or introduce abstractions beyond what the task requires.
3. Add or update tests for deterministic helpers (the `core.ts` / `prompts.ts` modules are designed to be tested without a live Pi runtime).
4. Run `bun run check` before pushing.
5. Update `CHANGELOG.md` under `## [Unreleased]` if the change is user-visible.
6. Update `README.md` and/or `AGENTS.md` when the operational contract changes.
7. Open a PR; CI runs typecheck and tests on Ubuntu and macOS, and builds `dist/` on Ubuntu.

Conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, ...) are encouraged but not yet enforced.

## Scope and design

Each feature folder (`genesis/`, `mind/`, `room/`, `observatory/`, `assembly/`) is an independent Pi extension entry. The `index.ts` in each folder is the public Pi extension contract; surrounding files (`core.ts`, `prompts.ts`, `spawn.ts`, etc.) are implementation detail and should stay testable without a Pi runtime.

When in doubt, prefer the smaller change.
