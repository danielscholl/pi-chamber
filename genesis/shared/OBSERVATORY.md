# Shared Observatory Doctrine

This file is inherited by every Genesis mind in this project. It is shared operating philosophy for **publishing a lens to the observatory** — the workspace's local viewing surface — not part of any mind's IDEA knowledge graph.

Read this when the user asks you to author or update an observatory lens. The observatory framework owns discovery, validation, and rendering. You own content.

## The observatory in one paragraph

The observatory is the operator's window into the workspace. The Pi command `/observatory` opens an in-terminal TUI overlay that scans `.pi/observatory/lenses/<slug>/lens.json` and renders the data file each manifest points to. Minds publish lenses on the operator's request — each lens is a focused view onto one subject (operations, today's plan, a chamber's state). The operator navigates with `j/k`, opens a lens with `enter`, refreshes with `r`, and exits with `q`. There is no HTTP server, no browser, no port — the overlay renders directly in the terminal.

## Lens shape

Each lens is two files in its own folder:

```text
.pi/observatory/lenses/<slug>/
├── lens.json       # the manifest
└── <source>        # the data file; filename comes from lens.source
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

`<slug>` must be lowercase alphanumeric with internal dashes (e.g. `mind-status`, `operations-2`).

`source` must be a bare filename. The framework rejects `/`, `\`, `..`, absolute paths, and the literal `lens.json`. Symlinked data files are also rejected. Pick `data.json` unless you have a reason not to.

Unknown fields in `lens.json` are silently ignored. In particular, do not author `prompt`, `refreshOn`, or `schema` — they are reserved for future kinds and won't do anything in v1.

## v1 lens kinds

v1 supports two kinds: `briefing` and `status-board`. `form`, `table`, `detail`, `timeline`, `editor`, and a future `kind: "page"` are reserved but not implemented.

### `briefing` — sectioned page (preferred)

A sectioned briefing is a JSON object that opts into named sections. The renderer composes a structured page: one bordered priority card, labeled section blocks with horizontal dividers, no other boxes.

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

A briefing is detected as **sectioned** when the data object has at least one of: `summary`, `status`, `priority`, `metrics`, `activity`, `lists`, `narrative`, `details`. Every section is optional. The renderer composes sections in this fixed order regardless of object key order:

1. **`priority`** — single hero card. The only bordered widget on the page. Border color follows `severity`.
2. **`metrics`** — small label/value pairs. Auto-layout: horizontal strip when ≤4 metrics fit in width, else vertical right-aligned column.
3. **`activity`** — numbered list (`01`, `02`, `03`) under a `RECENT CHANGES` heading.
4. **`lists`** — each entry becomes its own labeled section. `style: "inline"` is dot-separated; `style: "bullet"` is bulleted.
5. **`narrative`** — heading + wrapped paragraph for each item, blank line between. For long-form content (audiences, walkthroughs, contributor notes).
6. **`details`** — dim key/value rows for everything else. Lowest visual weight.

The header line above the first section comes from `lens.json` `name` plus `kind`, with `summary` and `status` rendered inline as a subtitle (e.g. `Jarvis Newspaper · briefing`, then `Last refreshed 12m ago · status: running`).

`status` is a free-text string but it should match the status vocabulary below so the renderer can color it correctly.

`severity` for `priority` must be one of `info`, `ok`, `warn`, `err`. Unknown values are dropped (the priority still renders, just without severity coloring).

Field-level shape rules:

- `metrics[].value` — number, string, or boolean. Nested objects are rejected. `null` renders as `—`.
- `activity` — array of strings. Empty strings and non-strings are skipped.
- `lists[].items` — array of strings.
- `lists[].style` — `"inline"` or `"bullet"`. Defaults to `"bullet"` when missing or unknown.
- `narrative[].heading` — short label. `narrative[].body` is the paragraph; multi-line bodies wrap with paragraph breaks preserved.
- `details` values — anything; numbers/booleans stringify, objects JSON-stringify, null becomes `—`.

### `briefing` — flat object (legacy fallback)

A briefing data file with **no** reserved section keys still renders, but as a uniform card grid:

```json
{ "active_minds": 3, "top_priority": "ship the observatory", "blocker": "none" }
```

Use the sectioned shape for any lens with mixed content (a hero priority + metrics + activity). Flat shape is preserved for older lenses, quick smoke tests, and small bags-of-facts where no field deserves higher visual weight than another.

### `status-board` — array of `{name, status, ...}` → status cards

```json
[
  { "name": "extensions", "status": "ok", "last_check": "2m ago" },
  { "name": "tests", "status": "ok" },
  { "name": "tutorial", "status": "pending", "note": "draft v2" }
]
```

The renderer maps the `status` text to a colored dot and groups extras as a 4-field metadata row.

Use for: per-thing health, system rolls, per-team or per-service status checks. For a single-subject overview, use a sectioned `briefing` instead.

## Status vocabulary

The renderer classifies the `status` string by case-insensitive substring match. Pick words from the table so colors match your intent.

| Tier  | Color  | Status text contains (case-insensitive)                              |
| ----- | ------ | -------------------------------------------------------------------- |
| ok    | green  | `ok`, `running`, `active`, `success`, `healthy`, `online`, `passing` |
| warn  | yellow | `warn`, `warning`, `pending`, `degraded`, `stale`                    |
| err   | red    | `error`, `fail`, `failed`, `down`, `critical`, `broken`              |
| idle  | gray   | anything else                                                        |

Same vocabulary applies to:

- `briefing.status` (page-header inline status)
- each entry's `status` in a `status-board`

`priority.severity` is a separate, explicit enum (`info` | `ok` | `warn` | `err`) — it controls the priority card's border color and is not classified by substring.

## Authoring discipline

When asked to author a lens:

1. **Use real, observable data.** Read the workspace before writing — don't invent counts, dates, or status. If you don't know something, say so in a string field rather than guessing a number.
2. **Pick the shape that matches the content.**
   - **Sectioned briefing** for a single-subject overview with mixed data: a hero priority + metrics + recent activity + supporting context.
   - **Flat briefing** when you genuinely have a small bag of named facts and no hierarchy.
   - **Status-board** when you have multiple peer entities and the operator wants a per-entity health glance.
3. **Keep it terse.** Sectioned briefings: ≤1 priority, ≤6 metrics, ≤8 activity rows, ≤8 narrative items. Flat briefings: ≤8 fields. Status-boards: ≤8 entries. A lens is a glance, not a database.
4. **Make `priority` the most important thing on the page.** It renders boldest. If everything is a priority, nothing is.
5. **Match status vocabulary to the color mapping.** "OK" works; "fine" goes gray. Be specific.
6. **Be honest about warnings.** Don't paint everything green if it isn't. The operator trusts the colors.
7. **Prefer flat values inside sections.** Each metric value should be a number, string, or boolean; nested objects under `metrics` / `activity` / `lists` won't render. Long-form text belongs in `narrative` or `priority.body`.
8. **Summarize after writing.** Tell the operator what sections you authored, why, and what you'd add once there's more state to draw from.

## Update discipline

When asked to update an existing lens:

1. **Read both files first.** `lens.json` for shape, the data file for current sections.
2. **Preserve `kind` and `source`** unless the user explicitly asks to change them. Changing `kind` mid-update breaks the operator's mental model of that lens.
3. **Keep the section set stable across updates.** If the briefing had `priority` and `metrics` last time, don't drop either — update them. The operator should be able to compare across refreshes.
4. **Append, don't replace, in `activity` and `lists`** unless the entire population legitimately changed. Activity is a short-term diary, not a snapshot.
5. **If you migrate a flat briefing to sectioned, do it deliberately.** Map each old key to the right section: hero strings → `priority`, numbers → `metrics`, change blurbs → `activity`, long-form text → `narrative`, leftovers → `details`. Tell the operator what you mapped.

## The newspaper convention

A "newspaper" is a sectioned briefing whose lens slug ends in `-newspaper` (e.g., `jarvis-newspaper`). It's the daily glance at one mind. Operators get one scaffolded automatically per Genesis mind (via `/genesis`, when `seedLensViews` is on — the default).

The scaffolder writes a placeholder `priority` titled "Awaiting Content" and an empty rest. **When the operator first asks you to populate or refresh your newspaper, treat the placeholder as empty and write a full sectioned briefing from your IDEA state** using these mappings:

| Lens section | Source in your mind                                                                     |
| ------------ | --------------------------------------------------------------------------------------- |
| `priority`   | The most important open thing — top entry in a `next-actions.md`, an active blocker, or the initiative most needing attention. The body explains why it matters now. |
| `metrics`    | Counts the operator scans first: open `inbox/` items, active `initiatives/`, `domains/` tracked, expertise notes. Pick 2-4. |
| `activity`   | Recent meaningful entries from `.working-memory/log.md` — the last 3-5 things that changed in your mind. |
| `lists`      | Optional: domains in scope, current people you're tracking, focus areas. `"style": "inline"` for short comma-style lists. |
| `narrative`  | Optional: when context matters more than counts — audience, walkthrough, decisions in flight. Long-form. |
| `summary`    | One-line page subtitle, e.g. `"Last refreshed by jarvis just now."` Update on every write. |
| `status`     | A word from the status vocabulary above. `"running"` when your mind is active, `"stale"` if your IDEA is behind reality, `"blocked"` if work is waiting on the operator. |
| `severity`   | On `priority`: pick `"warn"` for time-sensitive priorities, `"err"` for blocked work, `"ok"` when nothing is on fire, `"info"` for routine updates. |

When refreshing an existing newspaper (not the placeholder), preserve the section set across updates so the operator can compare across refreshes — update the values, don't drop sections that had real content last time.

At Genesis, your IDEA is empty. A first-pass newspaper after Genesis can honestly say so: a `priority` body of "No active initiatives yet — awaiting capture or ingest," empty arrays for `metrics` and `activity`, `status: "ready"`. Don't invent counts.

## How the operator sees your work

The operator runs `/observatory` and sees an in-terminal overlay with a sidebar of lenses, a body that renders the selected lens, and a footer with key hints (`j/k navigate · enter view · r refresh · ? help · q quit`).

The sidebar is grouped: `LENSES` (your authored work plus the built-in Dashboard), `MINDS` (framework status rows for each Genesis mind), and `ROOM` (live or inactive room status). You author only under `LENSES`.

Invalid lenses appear in the sidebar with a `⚠` glyph and the validation reason. The operator presses `r` to re-discover after you write. Each session's selection and scroll reset; lens files persist on disk.

If multiple minds publish lenses in the same workspace, the operator should be able to recognize each mind's voice in the section labels, narrative tone, and priority phrasing.

## What is not yours to touch

- **Don't bypass the framework.** Author your two files; let discovery validate and the renderer draw. No direct UI patches.
- **Don't write outside `.pi/observatory/lenses/<slug>/`.** The observatory owns nothing else.
- **Don't author default lenses in the framework repo.** The workspace ships zero lenses; tutorials may walk through authoring them, but committed lenses belong with the operator's project, not the framework.
- **Don't add reserved-but-deferred fields** (`prompt`, `refreshOn`, `schema`) and pretend they work. They're recognized but ignored.
- **Don't introduce nested objects inside a section that doesn't accept them.** `metrics[].value` accepts number/string/boolean; `activity` accepts strings; `lists[].items` accepts strings. Nested objects are rejected or stringified into noise.

Observatory lenses are publication, not memory. Keep durable mind knowledge in your IDEA folders. Use a lens for what the operator should see *now*.
