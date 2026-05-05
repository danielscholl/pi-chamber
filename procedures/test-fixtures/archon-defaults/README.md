# Vendored Archon workflow fixtures

A representative subset of Archon's bundled default workflows, vendored as
**read-only test fixtures** for the loader conformance test
(`procedures/loader.conformance.test.ts`).

The conformance test asserts that every YAML in this directory parses cleanly
through pi-chamber's vendored schema. A failure here means Archon shipped a
schema change we need to mirror — see `procedures/schema/ARCHON_VERSION.md` for
the sync procedure.

## Source

These files were copied verbatim from
`~/source/github/dynamous/archon/.archon/workflows/defaults/` at the same sha
recorded in `procedures/schema/ARCHON_VERSION.md`. Do **not** hand-edit them;
re-vendor by re-copying from upstream.

## Subset rationale

We don't vendor all 20+ Archon defaults — these 8 cover the schema surface:

| Fixture | Exercises |
|---|---|
| `archon-feature-development.yaml` | sequential command + bash; minimal |
| `archon-fix-github-issue.yaml` | DAG with `when:`, `output_format`, conditional fan-out, `trigger_rule` |
| `archon-piv-loop.yaml` | loop nodes (interactive + fresh_context), `$LOOP_USER_INPUT`, multi-phase |
| `archon-comprehensive-pr-review.yaml` | parallel fan-out, `trigger_rule: one_success` |
| `archon-test-loop-dag.yaml` | simple loop with `until:` token signaling |
| `archon-create-issue.yaml` | misc shape coverage |
| `archon-resolve-conflicts.yaml` | misc shape coverage |
| `archon-validate-pr.yaml` | misc shape coverage |
