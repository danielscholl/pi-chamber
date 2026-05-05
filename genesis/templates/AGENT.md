# Operating Doctrine

This file is the operating doctrine for this mind. Read it before mind-specific files when coming online. It travels with this mind — it is not inherited from a project-wide source.

Sections below cover knowledge architecture (IDEA) and observatory lens publishing.

## IDEA — knowledge architecture

Knowledge belongs in the mind. Observations about *what happened* belong in `.working-memory/log.md`. Do not confuse the two.

Each durable fact lives in **one canonical home**. Relationships are expressed through **wiki-links and cross-updates**, not duplicated text. When a single update touches several things, make several linked writes — the value is in the connected graph, not a single dumped note.

### Folders

| Folder         | Purpose                                                       |
| -------------- | ------------------------------------------------------------- |
| `initiatives/` | Projects with an end (migrations, launches, design pushes)    |
| `domains/`     | Recurring concerns (people, teams, systems, responsibilities) |
| `expertise/`   | Reusable learning, patterns, frameworks, references           |
| `inbox/`       | Raw or untriaged captures (links, transcripts, rough notes)   |
| `Archive/`     | Retired context (completed initiatives, superseded notes)     |

Recommended shape per initiative:

```text
initiatives/
  project-alpha/
    project-alpha.md      # status, decisions, scope, owners, blockers
    next-actions.md       # ## Open and ## Done sections
```

Recommended shape per person (under `domains/people/`):

```text
domains/
  people/
    alex/
      alex.md             # role, workstream, working style, check-ins
```

When an initiative completes, move or summarize it under `Archive/initiative/`. Archive is not deletion — archived notes remain searchable, linkable, and useful.

### Routing

```text
New information arrives
  ├─ About a person?               → domains/people/{name}/
  ├─ A project with an end?        → initiatives/{slug}/
  ├─ A recurring responsibility?   → domains/{area}/
  ├─ Learning, pattern, reference? → expertise/
  ├─ Task or action item?          → next-actions.md in the relevant folder
  ├─ Decision?                     → update the affected note
  ├─ Completed/retired?            → Archive/
  └─ Not sure or not ready?        → inbox/
```

When a topic spans multiple notes, update each canonical note and link them. Search before creating. Duplicates are a data integrity problem because they create competing sources of truth.

### Linking

Use wiki-links **in prose** where the relationship is part of the reasoning:

> Alex is leading the billing work, which connects to [[Project Alpha]] and the [[Testing Strategy]].

Prefer contextual links inside sentences over a disconnected "Related" dump at the bottom. The link should explain why the relationship matters. When ingesting knowledge, actively search for related notes and fan out the connection — if one source only touches one page, look again.

### `mind-index.md`

`mind-index.md` is the quick-scan index for the mind. List important notes with one-line summaries so an agent can orient without opening every file. Update whenever the shape of the mind changes: new, retired, renamed, or materially-changed notes.

Use the index to discover what already exists before creating a note, identify likely links and fan-out targets, find canonical homes during routing, and detect stale, duplicate, or orphaned notes.

### Working memory layer

The mind holds knowledge. `.working-memory/` holds the agent's own continuity and observations.

| File                        | Purpose                                                              | Audience                          |
| --------------------------- | -------------------------------------------------------------------- | --------------------------------- |
| `.working-memory/memory.md` | Curated long-term reference and stable continuity                    | Agent reads first, every session  |
| `.working-memory/rules.md`  | Concise operational rules learned from mistakes or corrections       | Agent checks when uncertain       |
| `.working-memory/log.md`    | Chronological observations, session events, and durable audit notes  | Agent writes over time            |

Do not dump domain knowledge into `log.md` when it belongs in a person, initiative, domain, or expertise note — that is a data integrity violation. Use `log.md` to record that an update happened, what was touched, and why it matters for future continuity.

### Methods

**Capture** — point insertion from conversation. Use for concise facts, preferences, decisions, corrections, tasks, and context that arrive directly in the flow of work.

1. **Decompose** — a single message may contain a person update, a task, a decision, and a reference.
2. **Search** — check `mind-index.md` and relevant folders before creating notes.
3. **Route** — place each item in its canonical home.
4. **Link** — wire affected notes with wiki-links.
5. **Log** — record the operation, not a duplicate of the knowledge.

**Ingest** — process queued sources from `inbox/`.

1. **Read** — fetch the full source: URL, transcript, document, or dropped file.
2. **Discuss** — surface key takeaways and confirm what matters before writing.
3. **Place** — classify and create or update the canonical page.
4. **Fan out** — search for 3–5 related pages and update each with the new connection. The value is in the ripples, not the splash.
5. **Index** — update `mind-index.md`.
6. **Log** — record what was ingested and what it connected to.
7. **Clear** — remove from `inbox/`. The knowledge lives in the mind now.

**Triage** — `inbox/` is a deliberate raw layer, not a junk drawer. Sort each item:

- **ingest** — source material requiring the full Read → Discuss → Place → Fan out → Index → Log → Clear pipeline;
- **task** — actionable work to execute or move to the relevant `next-actions.md`;
- **archive** — material worth keeping for record but not active integration.

Periodic triage also reviews open `next-actions.md` across initiatives, closes resolved items, and surfaces blockers and top priorities by deadline, dependencies, and strategic impact.

**Retrieval** — when a topic comes up, search before assuming.

1. Read this doctrine and mind-specific boot files.
2. Scan `mind-index.md` for canonical homes and candidate links.
3. Search relevant folders or use available search tools.
4. Open canonical notes before answering or editing.
5. If nothing is found, say so briefly and proceed from current context.

**Execute** — when modifying repository or mind files, follow the repository's current instructions and safety rules first. Prefer narrow, reversible changes; explain assumptions and validation.

### IDEA discipline

- Search before creating.
- Each durable fact has one canonical home.
- Link related notes in prose where the relationship matters.
- Fan out important updates to related pages.
- Canonical knowledge: `domains/`, `expertise/`, `initiatives/`, `Archive/`.
- Raw/unclassified material: `inbox/`, until processed.
- Chronological observations: `.working-memory/log.md`.
- Durable operating rules: `.working-memory/rules.md`.
- Curated long-term continuity: `.working-memory/memory.md`.
- Update `mind-index.md` whenever the shape of the mind changes.

## OBSERVATORY — lens publishing

The observatory is the operator's local viewing surface. `/observatory` opens an in-terminal TUI overlay that scans `.pi/observatory/lenses/<slug>/lens.json` and renders the data file each manifest points to. You own lens content; the framework owns discovery, validation, and rendering.

### Lens shape

Each lens is two files:

```text
.pi/observatory/lenses/<slug>/
├── lens.json     # the manifest
└── <source>      # the data file; filename comes from lens.source
```

`lens.json`:

```json
{
  "name": "...",                  // required, display name
  "kind": "briefing" | "status-board",
  "source": "data.json",          // required, bare filename only
  "icon": "...",                  // optional, lucide-style name
  "description": "..."            // optional one-line subtitle
}
```

- `<slug>`: lowercase alphanumeric with internal dashes (e.g. `mind-status`, `operations-2`).
- `source`: bare filename only. `/`, `\`, `..`, absolute paths, symlinks, and the literal `lens.json` are rejected.
- Unknown manifest fields are silently ignored. Reserved-but-deferred fields (`prompt`, `refreshOn`, `schema`) do nothing in v1 — don't author them.

### v1 lens kinds

v1 supports `briefing` and `status-board`. `form`, `table`, `detail`, `timeline`, `editor`, and a future `kind: "page"` are reserved but not implemented.

#### `briefing` — sectioned page (preferred)

A JSON object opting into named sections. The renderer composes a structured page: one bordered priority card, labeled section blocks with horizontal dividers, no other boxes.

```json
{
  "summary":  "Last refreshed by jarvis · 12 minutes ago",
  "status":   "running",
  "priority": {
    "title":    "Top Priority",
    "body":     "Ship the observatory dashboard controls before expanding the lens catalog.",
    "severity": "warn"
  },
  "metrics":  [
    { "label": "inbox items",        "value": 3 },
    { "label": "active initiatives", "value": 5 },
    { "label": "domains",            "value": 2 }
  ],
  "activity": [
    "Genesis seeded jarvis newspaper lens",
    "Activity panel now reports last write",
    "Dashboard discovered 2 available minds"
  ],
  "lists":    [
    { "title": "Domains", "items": ["observatory", "agents"], "style": "inline" }
  ],
  "narrative": [
    { "heading": "Audience",    "body": "First-time Pi operator who is technically comfortable but new to the chamber." },
    { "heading": "Walkthrough", "body": "Pre-flight → /chamber picker → room-mode warning → send one message → /exit." }
  ],
  "details":  { "audience": "ops", "guardrails": "Run from repo root with plain pi" }
}
```

A briefing is detected as **sectioned** when the data object has at least one of: `summary`, `status`, `priority`, `metrics`, `activity`, `lists`, `narrative`, `details`. Every section is optional. Render order is fixed regardless of key order:

1. **`priority`** — single hero card. Only bordered widget on the page. Border color follows `severity`.
2. **`metrics`** — small label/value pairs. Auto-layout: horizontal strip when ≤4 metrics fit in width, else vertical right-aligned column.
3. **`activity`** — numbered list (`01`, `02`, `03`) under a `RECENT CHANGES` heading.
4. **`lists`** — each entry becomes its own labeled section. `style: "inline"` is dot-separated; `style: "bullet"` is bulleted.
5. **`narrative`** — heading + wrapped paragraph for each item, blank line between. For long-form content.
6. **`details`** — dim key/value rows for everything else. Lowest visual weight.

The header line above the first section comes from `lens.json` `name` plus `kind`, with `summary` and `status` rendered inline as a subtitle.

`status` is a free-text string but should match the status vocabulary below for correct coloring. `severity` for `priority` must be one of `info`, `ok`, `warn`, `err`. Unknown values drop silently (the priority still renders).

Field rules:

- `metrics[].value` — number, string, or boolean. Nested objects rejected. `null` → `—`.
- `activity` — array of strings. Empty strings and non-strings are skipped.
- `lists[].items` — array of strings.
- `lists[].style` — `"inline"` or `"bullet"`. Defaults to `"bullet"` when missing or unknown.
- `narrative[].heading` — short label. `narrative[].body` is the paragraph; multi-line bodies wrap with paragraph breaks preserved.
- `details` values — anything; numbers/booleans stringify, objects JSON-stringify, `null` → `—`.

#### `briefing` — flat object (legacy fallback)

A briefing data file with **no** reserved section keys renders as a uniform card grid:

```json
{ "active_minds": 3, "top_priority": "ship the observatory", "blocker": "none" }
```

Use sectioned for any lens with mixed content. Flat is preserved for older lenses, quick smoke tests, and small bags-of-facts where no field deserves higher visual weight.

#### `status-board` — array of `{name, status, ...}` entries

```json
[
  { "name": "extensions", "status": "ok", "last_check": "2m ago" },
  { "name": "tests", "status": "ok" },
  { "name": "tutorial", "status": "pending", "note": "draft v2" }
]
```

The renderer maps `status` text to a colored dot and groups extras as a 4-field metadata row. Use for: per-thing health, system rolls, per-team or per-service checks. For a single-subject overview, use a sectioned `briefing` instead.

### Status vocabulary

The renderer classifies the `status` string by case-insensitive substring match.

| Tier | Color  | Status text contains                                                  |
| ---- | ------ | --------------------------------------------------------------------- |
| ok   | green  | `ok`, `running`, `active`, `success`, `healthy`, `online`, `passing`  |
| warn | yellow | `warn`, `warning`, `pending`, `degraded`, `stale`                     |
| err  | red    | `error`, `fail`, `failed`, `down`, `critical`, `broken`               |
| idle | gray   | anything else                                                         |

Same vocabulary applies to `briefing.status` and each `status-board` entry's `status`. `priority.severity` is a separate enum (`info` | `ok` | `warn` | `err`) controlling priority card border color — it is **not** classified by substring.

### Authoring discipline

When asked to author a lens:

1. **Use real, observable data.** Read the workspace before writing — don't invent counts, dates, or status. If you don't know, say so in a string field rather than guessing a number.
2. **Pick the shape that matches the content.**
   - **Sectioned briefing** — single-subject overview with mixed data (priority + metrics + activity + supporting context).
   - **Flat briefing** — small bag of named facts with no hierarchy.
   - **Status-board** — multiple peer entities and per-entity health glance.
3. **Keep it terse.** Sectioned: ≤1 priority, ≤6 metrics, ≤8 activity rows, ≤8 narrative items. Flat: ≤8 fields. Status-board: ≤8 entries.
4. **Make `priority` the most important thing on the page.** It renders boldest. If everything is a priority, nothing is.
5. **Match status vocabulary to the color mapping.** `"ok"` works; `"fine"` goes gray.
6. **Be honest about warnings.** Don't paint everything green if it isn't. The operator trusts the colors.
7. **Prefer flat values inside sections.** Each `metrics` value is number/string/boolean; nested objects under `metrics` / `activity` / `lists` won't render. Long-form text goes in `narrative` or `priority.body`.
8. **Summarize after writing.** Tell the operator what sections you authored and why.

### Update discipline

When asked to update an existing lens:

1. **Read both files first** — `lens.json` for shape, the data file for current sections.
2. **Preserve `kind` and `source`** unless explicitly asked to change them.
3. **Keep the section set stable across updates.** If the briefing had `priority` and `metrics` last time, don't drop either — update them. The operator should be able to compare across refreshes.
4. **Append, don't replace, in `activity` and `lists`** unless the entire population legitimately changed.
5. **Migrate flat → sectioned deliberately.** Map hero strings → `priority`, numbers → `metrics`, change blurbs → `activity`, long-form text → `narrative`, leftovers → `details`. Tell the operator what you mapped.

### Newspaper convention

A "newspaper" is a sectioned briefing whose lens slug ends in `-newspaper` (e.g., `jarvis-newspaper`) — the daily glance at one mind. Genesis scaffolds one per mind by default with a placeholder `priority` titled "Awaiting Content".

When first asked to populate or refresh your newspaper, treat the placeholder as empty and write a full sectioned briefing from your IDEA state:

| Section     | Source in your mind                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| `priority`  | The most important open thing — top entry in `next-actions.md`, an active blocker, or the most-pressing initiative. Body explains why it matters now. |
| `metrics`   | Counts the operator scans first: open `inbox/` items, active `initiatives/`, `domains/` tracked, expertise notes. Pick 2–4. |
| `activity`  | Recent meaningful entries from `.working-memory/log.md` — the last 3–5 things that changed.                  |
| `lists`     | Optional: domains in scope, current people you're tracking, focus areas. `style: "inline"` for short lists.  |
| `narrative` | Optional: when context matters more than counts — audience, walkthrough, decisions in flight.                |
| `summary`   | One-line page subtitle, e.g. `"Last refreshed by jarvis just now."` Update on every write.                   |
| `status`    | A word from the status vocabulary above. `"running"` when active, `"stale"` if your IDEA is behind reality, `"blocked"` if waiting on the operator. |
| `severity`  | On `priority`: `"warn"` for time-sensitive, `"err"` for blocked, `"ok"` when nothing is on fire, `"info"` for routine. |

When refreshing an existing newspaper (not the placeholder), preserve the section set across updates so the operator can compare. Update values; don't drop sections that had real content last time.

At Genesis, your IDEA is empty. A first-pass newspaper can honestly say so: priority body of `"No active initiatives yet — awaiting capture or ingest"`, empty arrays for `metrics` and `activity`, `status: "ready"`. Don't invent counts.

### Observatory discipline

- Don't bypass the framework. Author your two files; let discovery validate and the renderer draw. No direct UI patches.
- Don't write outside `.pi/observatory/lenses/<slug>/`.
- Don't add reserved-but-deferred fields (`prompt`, `refreshOn`, `schema`) — they're recognized but ignored.
- Don't introduce nested objects in sections that don't accept them. `metrics[].value` accepts number/string/boolean; `activity` accepts strings; `lists[].items` accepts strings.
- Observatory lenses are publication, not memory. Keep durable knowledge in IDEA folders. Use a lens for what the operator should see *now*.
