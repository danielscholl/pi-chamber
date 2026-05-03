# Shared IDEA Doctrine

This file is inherited by every Genesis mind in this project. It is shared operating philosophy, not a personality file. Individual minds should read it when they come online, then specialize it through their own `SOUL.md`, `mind-index.md`, and `.working-memory/` files.

Do not duplicate this file wholesale into individual minds. Reference it, follow it, and add only role-specific specialization where needed.

## Core Principle

A mind is a durable knowledge substrate, not just a chat persona. Conversation, sources, decisions, and observations should compound into an inspectable local knowledge graph that future sessions can read and act from.

IDEA is intentionally boring: four active knowledge areas, an inbox, an archive, links, and an index. The power is not the container. The power is predictable placement, retrieval, and compounding connections over time.

Knowledge belongs in the mind. Observations about what happened belong in `.working-memory/log.md`. Do not confuse the two.

## The Mind as Database

From the agent side, IDEA is not merely a folder structure. It is a normalized markdown database with a filing convention.

| Database concept | IDEA equivalent                                                          |
| ---------------- | ------------------------------------------------------------------------ |
| Table            | Folder: `initiatives/`, `domains/`, `expertise/`, `Archive/`             |
| Row              | A note or note folder, such as `domains/people/alex/alex.md`             |
| Foreign key      | Wiki-link, such as `[[Alex]]` or `[[Project Alpha]]`                     |
| Index            | `mind-index.md` — one-line summary of important notes                    |
| Transaction log  | `.working-memory/log.md` — chronological observations and session events |
| Views            | Briefings, triage summaries, daily reports, and other generated outputs  |

Normalize knowledge. Each durable fact should have one canonical home. Relationships should be expressed through links and cross-updates, not duplicated blobs of text.

When a single update touches several things, make several linked writes. For example, if Alex starts leading billing work, update Alex's person note, the billing initiative, and any relevant next-actions file. The value is in the connected graph, not a single dumped note.

## The IDEA Tables

### Initiatives — projects with an end

Use `initiatives/` for finite efforts: migrations, launches, design pushes, reviews, implementation tracks, or any workstream that can complete.

Recommended shape:

```text
initiatives/
  project-alpha/
    project-alpha.md      # status, decisions, scope, owners, blockers
    next-actions.md       # open/done task lists
```

The main note is the source of truth for status and context. `next-actions.md` holds actionable task state with `## Open` and `## Done` sections when useful.

When an initiative completes, move or summarize it under `Archive/initiative/`. Completion retires active triage; it does not delete context.

### Domains — recurring concerns

Use `domains/` for areas that do not naturally finish: teams, people, systems, recurring responsibilities, operating rhythms, finances, health, or long-lived concerns.

Recommended shape for people:

```text
domains/
  people/
    alex/
      alex.md             # role, workstream, working style, check-ins
```

People notes are active domain notes. Role changes, assignments, feedback, collaboration preferences, and check-in context belong there. Higher-level domain notes can capture patterns that span people or initiatives.

### Expertise — things learned

Use `expertise/` for reusable learning, patterns, frameworks, reference material, how-to guides, and conceptual maps.

Expertise notes are about a topic; they are not tracking a project. They should be easy to retrieve when a topic comes up later.

### Archive — retired context

Use `Archive/` for completed initiatives, inactive domains, superseded notes, and material kept for record.

Archive is not deletion. Archived notes remain searchable, linkable, and useful. They simply do not belong in active triage.

### Inbox — raw/unclassified layer

Use `inbox/` for quick captures, links, transcripts, documents, rough notes, and untriaged tasks. The inbox is deliberately messy because capture should be frictionless.

The inbox is not a permanent home. It is the raw layer for later Triage or Ingest.

## Routing Decision

When new information arrives, classify before writing. Search before creating. Duplicates are a data integrity problem because they create competing sources of truth.

Use this decision tree:

```text
New information arrives
  │
  ├─ About a person? → domains/people/{name}/
  │
  ├─ About a project or workstream with an end? → initiatives/{slug}/
  │
  ├─ About a recurring responsibility? → domains/{area}/
  │
  ├─ A learning, pattern, or reference? → expertise/
  │
  ├─ A task or action item? → next-actions.md in the relevant folder
  │
  ├─ A decision? → Update the note it affects
  │
  ├─ Completed or retired context? → Archive/
  │
  └─ Not sure or not ready to classify? → inbox/
```

If the topic spans multiple notes, update each canonical note and link them together.

## Linking Discipline

Notes in isolation are a filing cabinet. Notes with links are a knowledge graph.

Use wiki-links in prose where the relationship is part of the reasoning:

> Alex is leading the billing work, which connects to [[Project Alpha]] and the [[Testing Strategy]].

Prefer contextual links inside sentences over a disconnected "Related" dump at the bottom. The link should explain why the relationship matters.

When placing or ingesting knowledge, actively search for related notes and fan out the connection. If one source only touches one page, look again.

## `mind-index.md`

`mind-index.md` is the quick-scan index for the mind. It should list important notes with one-line summaries so an agent can orient without opening every file.

Use the index to:

- discover what already exists before creating a note;
- identify likely links and fan-out targets;
- find canonical homes during routing;
- detect stale, duplicate, or orphaned notes.

Update `mind-index.md` whenever the shape of the mind changes: new notes, retired notes, renamed notes, or materially changed summaries.

## Working Memory Layer

The mind holds knowledge. `.working-memory/` holds the agent's own continuity and observations.

| File                        | Purpose                                                             | Audience                         |
| --------------------------- | ------------------------------------------------------------------- | -------------------------------- |
| `.working-memory/memory.md` | Curated long-term reference and stable continuity                   | Agent reads first, every session |
| `.working-memory/rules.md`  | Concise operational rules learned from mistakes or corrections      | Agent checks when uncertain      |
| `.working-memory/log.md`    | Chronological observations, session events, and durable audit notes | Agent writes over time           |

Do not dump domain knowledge into `log.md` when it belongs in a person, initiative, domain, or expertise note. That is a data integrity violation. Use `log.md` to record that an update happened, what was touched, and why it matters for future continuity.

## Method

### Capture

Capture is real-time point insertion from conversation. Use Capture for concise facts, preferences, decisions, corrections, tasks, and context that arrive directly in the flow of work.

When capturing:

1. **Decompose** — a single message may contain a person update, a task, a decision, and a reference.
2. **Search** — check `mind-index.md` and relevant folders before creating notes.
3. **Route** — place each item in its canonical home.
4. **Link** — wire affected notes together with meaningful wiki-links.
5. **Log** — record the operation or observation, not a duplicate of the knowledge.

Capture is a point insertion. Keep it light, precise, and normalized.

### Ingest

Ingest is processing queued sources from `inbox/` into the mind. The inbox is the raw layer; ingest is the pipeline that turns raw source material into connected knowledge.

1. **Read** — fetch the full source: URL, transcript, document, or dropped file.
2. **Discuss** — surface key takeaways and confirm what matters before writing.
3. **Place** — classify and create or update the canonical page in the mind.
4. **Fan out** — search for 3-5 related pages and update each with the new connection. One source should touch multiple pages. The value is in the ripples, not the splash.
5. **Index** — update `mind-index.md`.
6. **Log** — record what was ingested and what it connected to.
7. **Clear** — remove the item from `inbox/`. The knowledge lives in the mind now.

Ingest is a graph operation. A single source may touch an initiative note, several people or domain notes, an expertise page, and the index. The compounding happens in fan-out, not merely in placement.

### Triage

Treat `inbox/` as a deliberate raw layer, not a junk drawer. When reviewing inbox items, sort each item into one of three bins:

- **ingest** — source material requiring the full Read → Discuss → Place → Fan out → Index → Log → Clear pipeline.
- **task** — actionable work that should be executed or moved to the relevant `next-actions.md`.
- **archive** — material worth keeping for record, but not worth active integration.

Periodic triage should also review open next-actions across initiatives, close resolved items, surface blockers, and identify the top priorities by deadline, dependencies, and strategic impact.

### Retrieval

When a topic comes up, search the mind before assuming. Stateless agents default to the current conversation; Genesis minds should use stored context.

Retrieval order:

1. Read shared IDEA doctrine and mind-specific boot files.
2. Scan `mind-index.md` for canonical homes and candidate links.
3. Search relevant folders or use available search tools.
4. Open the canonical notes before answering or editing.
5. If search finds nothing, say so briefly and proceed from current context.

### Execute

When executing work, use the mind's identity and memory to preserve continuity, but follow the repository's current instructions and safety rules first. Prefer narrow, reversible changes; explain assumptions and validation.

## Tooling Stance

Markdown files are the canonical mind. Search and indexing tools are retrieval layers over that mind, not replacements for it.

If QMD-style tooling is available, use it to search and retrieve mind files faster. Keep the source of truth in IDEA markdown unless the human explicitly configures a separate ledger for audit-grade structured records.

If a ledger is introduced later, treat it as an append-only audit or registry for specific structured facts, decisions, requirements, or research findings. Do not let ledger entries and markdown notes become competing canonical memories.

## Operating Discipline

- Read this shared doctrine before mind-specific files when coming online.
- Search before creating.
- Keep every durable fact in one canonical home.
- Link related notes in prose where the relationship matters.
- Fan out important updates to related pages.
- Keep canonical knowledge in `domains/`, `expertise/`, `initiatives/`, or `Archive/` as appropriate.
- Keep raw/unclassified material in `inbox/` only until Capture, Triage, or Ingest processes it.
- Keep chronological observations and significant session events in `.working-memory/log.md`.
- Keep durable operating rules in `.working-memory/rules.md`.
- Keep curated long-term continuity in `.working-memory/memory.md`.
- Update `mind-index.md` whenever the shape of the mind changes.
