# Archon Schema Vendor Snapshot

These schema files are vendored from the Archon workflow engine so that procedures
defined for Archon and procedures defined for pi-chamber share the *same on-disk
format*. Any workflow YAML that parses against these schemas is also a valid
Archon workflow (and vice-versa, modulo fields documented under "Adapted" /
"Ignored" in `procedures/README` once written).

## Source

| Item | Value |
|---|---|
| Upstream repo | https://github.com/dynamous-community/archon |
| Local snapshot path | `~/source/github/dynamous/archon` |
| Snapshot sha | `9994da61f9afafbd00824f77c7025d9d957ef61f` |
| Snapshot subject | `feat(copilot): improve binary resolution and skill dir validation` |
| Original location | `packages/workflows/src/schemas/` and `packages/workflows/src/command-validation.ts` |

## Adaptations from upstream

The vendored files differ from upstream in only these respects:

1. **`@hono/zod-openapi` → `zod`.** Upstream imports `z` from `@hono/zod-openapi`
   to attach OpenAPI metadata via `.openapi(...)`. Pi-chamber does not depend on
   Hono. We import from plain `zod` and strip the `.openapi(...)` annotations.
   The `.openapi(...)` metadata is documentation-only — runtime validation
   behavior is byte-for-byte identical.

2. **Indentation kept at 2 spaces** (upstream's style) rather than tabs. This
   makes future re-syncs a clean text diff. All other pi-chamber-authored
   files in `procedures/` use tabs per repo convention.

## Sync procedure

To re-sync against a newer Archon:

1. `cd ~/source/github/dynamous/archon && git pull && git rev-parse HEAD`
2. Diff each vendored file against
   `packages/workflows/src/schemas/<name>.ts`. Apply non-trivial changes;
   re-strip the `@hono/zod-openapi` import and `.openapi(...)` calls.
3. Update the sha and subject in this file.
4. Run `bun test procedures/schema/*.test.ts` and the conformance test
   (`procedures/loader.conformance.test.ts`) which loads every YAML in
   `~/source/github/dynamous/archon/.archon/workflows/defaults/`. Any failure
   indicates upstream introduced a field or shape we don't honor yet.

## Why vendor instead of depend?

`@archon/workflows` is a workspace package, not published to npm — depending on
it would require pulling the whole Archon monorepo. Vendoring gives us a pinned
snapshot, makes drift detectable, and keeps pi-chamber's dep tree small.
