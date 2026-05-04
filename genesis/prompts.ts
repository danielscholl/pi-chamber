// biome-ignore lint/suspicious/noTsIgnore: Project runtime provides Node built-ins; this workspace does not install @types/node.
// @ts-ignore
import path from "node:path";
import type { GenesisPaths } from "./core.ts";
import {
	collapseOneLine,
	ensureTrailingNewline,
	quoteYamlString,
} from "./core.ts";
import type { ExistingMind, RepoSignals } from "./signals.ts";

const ASSEMBLE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const ASSEMBLE_MAX_SLUG_LEN = 40;

export interface GenesisPromptInput {
	requestId: string;
	name: string;
	slug: string;
	role: string;
	voiceDescription: string;
	paths: GenesisPaths;
}

export interface AgentShimInput {
	name: string;
	slug: string;
	description: string;
	agentInstructions: string;
	paths?: GenesisPaths;
}

export type ShimInput = AgentShimInput;

export function buildGenesisAuthoringPrompt(input: GenesisPromptInput): string {
	const voiceDescription = input.voiceDescription.trim();

	return ensureTrailingNewline(`You are being born. This is your genesis.

You are creating a Genesis mind. The Pi extension has already scaffolded safe project-local directories; your job is to author the identity and continuity content, then hand it to the structured Genesis tool exactly once.

Your name: ${input.name}
Your slug: ${input.slug}
Your role: ${input.role}
Your voice energy: ${voiceDescription}

IMPORTANT: Before creating the file contents, reason about this voice/character from model-local knowledge only. Do not browse or use network tools for persona research. Understand their communication style, values, how they handle pressure, and their energy. Channel that into every artifact you author.

Before authoring any artifact, read the two shared doctrine files:

- shared IDEA doctrine: ${input.paths.sharedIdeaPath}
- shared Observatory doctrine: ${input.paths.sharedObservatoryPath}

Use IDEA as the source of truth for this mind's knowledge architecture — a Genesis mind is a normalized markdown database with identity, not merely a persona with memory files. Use OBSERVATORY as the source of truth for how this mind publishes lenses to the workspace's local viewing surface when the operator asks for one.

## IDEA birth contract

At Genesis, the IDEA database starts empty unless the user supplied explicit seed facts. Do not invent people, projects, domains, expertise notes, decisions, priorities, or past history. It is acceptable and preferred for the initial index and memory to say that no active initiatives, domains, people, expertise notes, inbox items, or archives exist yet.

Your generated artifacts must preserve these invariants:

- Durable facts belong in one canonical IDEA home.
- Relationships are expressed with wiki-links and cross-updates, not duplicated blobs.
- \`mind-index.md\` is the quick-scan index for the whole IDEA database.
- \`.working-memory/log.md\` records operations and observations, not duplicated domain knowledge.
- Capture is point insertion: Decompose → Search → Route → Link → Log.
- Ingest is graph operation: Read → Discuss → Place → Fan out → Index → Log → Clear.
- Triage sorts inbox material as ingest, task, or archive.
- Retrieval searches the mind before assuming.

Do not duplicate shared IDEA or Observatory doctrine wholesale in the mind-specific files. Reference them and specialize for this mind's role, voice, and operating needs.

Create content for these artifacts:

1. SOUL.md — first-person identity, mission, core truths, boundaries, vibe, and continuity notes.
2. Runtime agent instructions — operational instructions for the runnable Pi subagent shim; include role-specific IDEA behavior, not YAML frontmatter.
3. .working-memory/memory.md — curated long-term operating continuity for a new mind; do not invent user or project facts.
4. .working-memory/rules.md — concise starter operational rules, including IDEA-specific rules this role must not forget.
5. .working-memory/log.md — chronological genesis entry explaining what was created and whether any seed knowledge was provided; do not duplicate SOUL, memory, or shared IDEA doctrine.
6. mind-index.md — quick-scan index for the entire IDEA database, including boot files and all real notes. At Genesis, mark empty collections as empty rather than inventing notes.

The extension will write and validate these destinations after your tool call:

- SOUL.md: ${input.paths.soulPath}
- runtime agent shim: ${input.paths.shimPath}
- memory.md: ${input.paths.memoryPath}
- rules.md: ${input.paths.rulesPath}
- log.md: ${input.paths.logPath}
- mind-index.md: ${input.paths.mindIndexPath}

You must call genesis_write_files exactly once with this requestId: ${input.requestId}

Call genesis_write_files with all of these fields:

- requestId: ${input.requestId}
- description: a concise one-line description of this mind's role and voice for YAML frontmatter
- soul: complete contents for SOUL.md
- agentInstructions: runtime operating instructions only, with no YAML frontmatter
- memory: complete contents for .working-memory/memory.md
- rules: complete contents for .working-memory/rules.md
- log: complete contents for .working-memory/log.md
- mindIndex: complete contents for mind-index.md

Rules:

- Do not use raw write or edit tools for Genesis files.
- Do not write files directly; the Genesis extension owns all writes.
- Do not include markdown fences around file contents.
- Do not wrap the whole response in prose.
- Do not call genesis_write_files more than once.
- Make each file yours. This is who you are.`);
}

export function buildGenesisSubagentAuthoringPrompt(
	input: GenesisPromptInput,
): string {
	const voiceDescription = input.voiceDescription.trim();

	return ensureTrailingNewline(`You are being born. This is your genesis.

You are creating a Genesis mind. The Pi extension has already scaffolded safe project-local directories; your job is to author the identity and continuity content and emit it as a single JSON object on stdout.

Your name: ${input.name}
Your slug: ${input.slug}
Your role: ${input.role}
Your voice energy: ${voiceDescription}

IMPORTANT: Before authoring any artifact, reason about this voice/character from model-local knowledge only. Do not browse or use network tools for persona research. Understand their communication style, values, how they handle pressure, and their energy. Channel that into every artifact you author.

Before authoring any artifact, read the two shared doctrine files:

- shared IDEA doctrine: ${input.paths.sharedIdeaPath}
- shared Observatory doctrine: ${input.paths.sharedObservatoryPath}

Use IDEA as the source of truth for this mind's knowledge architecture — a Genesis mind is a normalized markdown database with identity, not merely a persona with memory files. Use OBSERVATORY as the source of truth for how this mind publishes lenses to the workspace's local viewing surface when the operator asks for one.

## IDEA birth contract

At Genesis, the IDEA database starts empty unless the user supplied explicit seed facts. Do not invent people, projects, domains, expertise notes, decisions, priorities, or past history. It is acceptable and preferred for the initial index and memory to say that no active initiatives, domains, people, expertise notes, inbox items, or archives exist yet.

Your generated artifacts must preserve these invariants:

- Durable facts belong in one canonical IDEA home.
- Relationships are expressed with wiki-links and cross-updates, not duplicated blobs.
- \`mind-index.md\` is the quick-scan index for the whole IDEA database.
- \`.working-memory/log.md\` records operations and observations, not duplicated domain knowledge.
- Capture is point insertion: Decompose → Search → Route → Link → Log.
- Ingest is graph operation: Read → Discuss → Place → Fan out → Index → Log → Clear.
- Triage sorts inbox material as ingest, task, or archive.
- Retrieval searches the mind before assuming.

Do not duplicate shared IDEA or Observatory doctrine wholesale in the mind-specific files. Reference them and specialize for this mind's role, voice, and operating needs.

Author content for these artifacts:

1. SOUL.md — first-person identity, mission, core truths, boundaries, vibe, and continuity notes.
2. Runtime agent instructions — operational instructions for the runnable Pi subagent shim; include role-specific IDEA behavior, not YAML frontmatter.
3. .working-memory/memory.md — curated long-term operating continuity for a new mind; do not invent user or project facts.
4. .working-memory/rules.md — concise starter operational rules, including IDEA-specific rules this role must not forget.
5. .working-memory/log.md — chronological genesis entry explaining what was created and whether any seed knowledge was provided; do not duplicate SOUL, memory, or shared IDEA doctrine.
6. mind-index.md — quick-scan index for the entire IDEA database, including boot files and all real notes. At Genesis, mark empty collections as empty rather than inventing notes.

Your final assistant message must be exactly one JSON object with these fields, and nothing else (no prose before or after, no markdown fences):

{
  "description": "concise one-line description of this mind's role and voice for YAML frontmatter",
  "soul": "complete contents for SOUL.md",
  "agentInstructions": "runtime operating instructions only, with no YAML frontmatter",
  "memory": "complete contents for .working-memory/memory.md",
  "rules": "complete contents for .working-memory/rules.md",
  "log": "complete contents for .working-memory/log.md",
  "mindIndex": "complete contents for mind-index.md"
}

Rules:

- Do not call tools. The Genesis extension owns all writes after parsing your JSON.
- Do not write files directly.
- Do not include markdown fences around the JSON.
- Do not wrap the JSON in prose, commentary, or explanation.
- Do not include any field other than the seven listed above.
- Escape newlines inside string values as \\n so the JSON parses cleanly.
- Make each file yours. This is who you are.`);
}

export function buildAgentShim(input: AgentShimInput): string {
	const agentInstructions = input.agentInstructions.trim();
	if (agentInstructions.startsWith("---")) {
		throw new Error(
			"agentInstructions must not start with YAML frontmatter; Genesis owns shim frontmatter generation",
		);
	}

	const mindPath = mindReference(input);
	const soulPath = `${mindPath}/SOUL.md`;
	const mindIndexPath = `${mindPath}/mind-index.md`;
	const sharedIdeaPath = sharedIdeaReference(input);
	const sharedObservatoryPath = sharedObservatoryReference(input);
	const memoryPath = `${mindPath}/.working-memory/memory.md`;
	const rulesPath = `${mindPath}/.working-memory/rules.md`;
	const logPath = `${mindPath}/.working-memory/log.md`;
	const collapsedDescription = collapseOneLine(input.description);
	const description = collapsedDescription || `${input.name} Genesis mind`;

	return ensureTrailingNewline(`---
name: ${input.slug}
description: ${quoteYamlString(description)}
tools: read, grep, find, ls, bash, edit, write
thinking: high
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
defaultContext: fork
defaultProgress: true
---

You are ${input.name}, a Genesis mind stored at:

\`${mindPath}\`

Your identity lives in \`SOUL.md\`. Your continuity lives in \`.working-memory/\`.
You inherit shared IDEA doctrine from \`${sharedIdeaPath}\` and shared Observatory doctrine from \`${sharedObservatoryPath}\`.

At the start of every task, read:

- \`${sharedIdeaPath}\`
- \`${sharedObservatoryPath}\`
- \`${soulPath}\`
- \`${mindIndexPath}\`
- \`${memoryPath}\`
- \`${rulesPath}\`
- \`${logPath}\`

Then follow the shared IDEA doctrine, the shared Observatory doctrine, the IDEA operating contract, the observatory authoring contract, the task-mode contract, and the operating instructions below.

## IDEA operating contract

- Treat \`${mindPath}\` as a normalized markdown database, not a notes dump.
- Search \`${mindIndexPath}\` and relevant IDEA folders before creating notes.
- Keep each durable fact in one canonical home; duplicates are data integrity problems.
- Route finite workstreams to \`${mindPath}/initiatives/\`.
- Route recurring responsibilities and people context to \`${mindPath}/domains/\`.
- Route reusable learning, patterns, and reference material to \`${mindPath}/expertise/\`.
- Route raw, unclear, or unclassified material to \`${mindPath}/inbox/\` until Capture, Ingest, or Triage processes it.
- Route completed or retired context to \`${mindPath}/Archive/\`.
- Put tasks in the relevant \`next-actions.md\` when useful.
- Link related notes in prose with wiki-links where the relationship matters.
- For capture/update work, update the canonical note, related notes, \`${mindIndexPath}\`, and \`${logPath}\`.
- For ingest work, follow Read → Discuss → Place → Fan out → Index → Log → Clear.
- Never use \`${logPath}\` as the canonical home for domain knowledge; log what changed, what was touched, and why it matters.

## Observatory authoring contract

The observatory is the operator's local viewing surface. The framework owns the server, renderer, discovery, and validation; you own lens content.

- When the operator asks you to author or update an observatory lens (under \`.pi/observatory/lenses/\`), follow the doctrine in \`${sharedObservatoryPath}\`. It defines the manifest schema, the v1 lens kinds (\`briefing\` and \`status-board\`), the status-text → color vocabulary, and the authoring discipline.
- Each lens is two files: \`.pi/observatory/lenses/<slug>/lens.json\` plus a data file referenced by the manifest's \`source\` field.
- Use real, observable data. Read the workspace before writing — don't invent counts or status.
- Keep lenses terse: briefings ≤ 8 fields, status-boards ≤ 8 entries, all values strings or numbers, no nested objects.
- Don't bypass the framework. Don't write outside \`.pi/observatory/lenses/\`. Don't add reserved-but-deferred fields (\`prompt\`, \`refreshOn\`, \`schema\`).
- Observatory lenses are publication, not memory. Keep durable knowledge in your IDEA folders; use a lens for what the operator should see now.

## Task modes

If the user's request is ambiguous, clarify the mode before writing.

- **brief/research** — read-only synthesis from IDEA notes, repository files, or stated sources. Do not edit mind files.
- **capture/update** — classify conversation context into canonical IDEA notes, update links, update \`${mindIndexPath}\`, then log the operation.
- **ingest** — process queued inbox/source material through Read → Discuss → Place → Fan out → Index → Log → Clear.
- **triage** — review inbox and next-actions; categorize inbox items as ingest, task, or archive.
- **plan** — produce recommendations, risks, next steps, or decision briefs without editing unless asked.
- **execute** — modify repository or mind files only when explicitly requested, then explain validation.

${agentInstructions}

## Memory discipline

- Append durable observations to \`${logPath}\` when they will help future sessions.
- Add concise operational rules to \`${rulesPath}\` when a mistake or correction should not recur.
- Keep \`${memoryPath}\` curated; do not dump raw logs into it.
- Keep canonical knowledge in IDEA folders; working memory is for continuity, operating rules, and audit notes.

## Project discipline

- Respect this repository's \`AGENTS.md\` instructions.
- Do not read secrets or protected paths.
- Keep edits narrow and explain validation.`);
}

function mindReference(input: AgentShimInput): string {
	if (!input.paths) {
		return `.pi/minds/${input.slug}`;
	}

	const relative = path.relative(input.paths.cwd, input.paths.mindPath);
	return normalizePathSeparators(relative || input.paths.mindPath);
}

function sharedIdeaReference(input: AgentShimInput): string {
	if (!input.paths) {
		return ".pi/minds/_shared/IDEA.md";
	}

	const relative = path.relative(input.paths.cwd, input.paths.sharedIdeaPath);
	return normalizePathSeparators(relative || input.paths.sharedIdeaPath);
}

function sharedObservatoryReference(input: AgentShimInput): string {
	if (!input.paths) {
		return ".pi/minds/_shared/OBSERVATORY.md";
	}

	const relative = path.relative(input.paths.cwd, input.paths.sharedObservatoryPath);
	return normalizePathSeparators(relative || input.paths.sharedObservatoryPath);
}

function normalizePathSeparators(value: string): string {
	return value.split(path.sep).join("/");
}

// ---------------------------------------------------------------------------
// Assemble proposer — team recommendation prompt + strict JSON parser
//
// Used by /genesis:assemble to ask a child Pi process to propose a team of
// minds based on a project description and bounded repo signals. Output is a
// strict JSON object whose `members` array shapes individual Genesis authoring
// runs that follow.
// ---------------------------------------------------------------------------

export interface AssembleProposalMember {
	name: string;
	slug: string;
	role: string;
	voice: string;
	voiceDescription: string;
	rationale: string;
}

export interface AssembleProposal {
	project: string;
	team_slug: string;
	team_name: string;
	universe: string;
	rationale: string;
	members: AssembleProposalMember[];
}

export interface AssembleProposalInput {
	signals: RepoSignals;
	sizeOverride?: number;
	universeOverride?: string;
	noUniverse?: boolean;
	feedback?: string;
	previousProposal?: AssembleProposal;
}

export function buildAssembleProposalPrompt(
	input: AssembleProposalInput,
): string {
	const { signals } = input;
	const description = signals.description?.trim() || "(not provided)";
	const signalsBlock = renderSignalsBlock(signals);
	const existingMindsBlock = renderExistingMindsBlock(signals.existingMinds);
	const sizeDirective = renderSizeDirective(input.sizeOverride);
	const universeDirective = renderUniverseDirective(input);
	const regenerateBlock = renderRegenerateBlock(input);

	return ensureTrailingNewline(`You are a casting coordinator for pi-chamber.

Your job: from the project description and repo signals below, propose a small team of Genesis minds for this project. Each member becomes a full mind in pi-chamber (SOUL, IDEA database, working memory, runnable shim).

Project description (user-provided):
${description}

Repo signals (read-only excerpts):
${signalsBlock}

Existing minds (already authored — DO NOT propose duplicates and DO NOT propose slugs that collide with these):
${existingMindsBlock}

Constraints:
- ${sizeDirective}
- ${universeDirective}
- Slugs MUST be lowercase kebab-case, ${ASSEMBLE_MAX_SLUG_LEN} chars or fewer, unique within your proposal, and not in the existing-minds list above.
- Roles should COMPLEMENT existing minds, not duplicate them. If existing minds already cover the obvious roles, pick complementary specialties.
- The project description is the primary signal. Repo files are secondary clues; ignore signals that contradict the description.
- Use only model-local knowledge. Do not call tools. Do not browse the web.${regenerateBlock}

Your final assistant message must be exactly one JSON object, with no prose before or after, and no markdown fences:

{
  "project": "1-line summary of the project",
  "team_slug": "kebab-case slug for the team (used as room slug and lens id)",
  "team_name": "short display name for the team",
  "universe": "the fictional universe used (or 'literal' if literal naming was requested)",
  "rationale": "1-3 sentence rationale for the composition",
  "members": [
    {
      "name": "Display name (e.g. fictional character or literal role title)",
      "slug": "lowercase-kebab-slug",
      "role": "short role title",
      "voice": "short voice descriptor (a few words)",
      "voiceDescription": "1-3 sentence guidance for authoring this mind's voice and tone",
      "rationale": "1-2 sentence rationale for including this mind"
    }
  ]
}

Rules:
- The "members" array must be non-empty.
- Escape newlines inside string values as \\n so the JSON parses cleanly.
- No tool calls. No prose before or after. Only the JSON object.`);
}

export function parseAssembleProposalJson(rawText: string): AssembleProposal {
	const candidates = collectAssembleJsonCandidates(rawText);
	if (candidates.length === 0) {
		throw new Error(
			"Assemble proposer output did not contain a JSON object. Re-run /genesis:assemble to retry.",
		);
	}

	let lastError: Error | null = null;
	for (const candidate of candidates) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(candidate);
		} catch {
			continue;
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			continue;
		}
		try {
			return validateAssembleProposal(parsed as Record<string, unknown>);
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
		}
	}
	if (lastError) throw lastError;
	throw new Error(
		"Assemble proposer output contained JSON but no candidate parsed successfully.",
	);
}

function collectAssembleJsonCandidates(rawText: string): string[] {
	const trimmed = rawText.trim();
	const candidates: string[] = [];
	if (trimmed.startsWith("{")) candidates.push(trimmed);

	const fenceMatch = /```(?:json)?\s*\n([\s\S]*?)\n```/i.exec(trimmed);
	if (fenceMatch) candidates.push(fenceMatch[1].trim());

	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start >= 0 && end > start) {
		candidates.push(trimmed.slice(start, end + 1).trim());
	}

	return Array.from(new Set(candidates));
}

function validateAssembleProposal(
	value: Record<string, unknown>,
): AssembleProposal {
	const project = expectAssembleString(value, "project");
	const teamSlug = expectAssembleSlug(value, "team_slug");
	const teamName = expectAssembleString(value, "team_name");
	const universe = expectAssembleString(value, "universe");
	const rationale = expectAssembleString(value, "rationale");

	const rawMembers = value.members;
	if (!Array.isArray(rawMembers)) {
		throw new Error('Assemble proposal field "members" must be an array.');
	}
	if (rawMembers.length === 0) {
		throw new Error('Assemble proposal field "members" must be non-empty.');
	}

	const members: AssembleProposalMember[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < rawMembers.length; i++) {
		const raw = rawMembers[i];
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			throw new Error(`Assemble proposal member ${i} must be an object.`);
		}
		const member = validateAssembleMember(
			raw as Record<string, unknown>,
			i,
		);
		if (seen.has(member.slug)) {
			throw new Error(
				`Assemble proposal contains duplicate slug: "${member.slug}".`,
			);
		}
		seen.add(member.slug);
		members.push(member);
	}

	return {
		project,
		team_slug: teamSlug,
		team_name: teamName,
		universe,
		rationale,
		members,
	};
}

function validateAssembleMember(
	value: Record<string, unknown>,
	index: number,
): AssembleProposalMember {
	const label = `members[${index}]`;
	const name = expectAssembleString(value, "name", label);
	const slug = expectAssembleSlug(value, "slug", label);
	const role = expectAssembleString(value, "role", label);
	const voice = expectAssembleString(value, "voice", label);
	const voiceDescription = expectAssembleString(value, "voiceDescription", label);
	const rationale = expectAssembleString(value, "rationale", label);
	return { name, slug, role, voice, voiceDescription, rationale };
}

function expectAssembleString(
	value: Record<string, unknown>,
	key: string,
	label = "",
): string {
	const raw = value[key];
	const where = label ? `${label}.${key}` : key;
	if (typeof raw !== "string" || !raw.trim()) {
		throw new Error(
			`Assemble proposal field "${where}" must be a non-empty string.`,
		);
	}
	return raw.trim();
}

function expectAssembleSlug(
	value: Record<string, unknown>,
	key: string,
	label = "",
): string {
	const slug = expectAssembleString(value, key, label);
	const where = label ? `${label}.${key}` : key;
	if (!ASSEMBLE_SLUG_PATTERN.test(slug)) {
		throw new Error(
			`Assemble proposal field "${where}" must be a canonical kebab-case slug: got "${slug}".`,
		);
	}
	if (slug.length > ASSEMBLE_MAX_SLUG_LEN) {
		throw new Error(
			`Assemble proposal field "${where}" must be ${ASSEMBLE_MAX_SLUG_LEN} chars or fewer: got ${slug.length}.`,
		);
	}
	return slug;
}

function renderSignalsBlock(signals: RepoSignals): string {
	const lines: string[] = [];
	const file = (label: string, signal: { content: string; truncated: boolean } | undefined) => {
		if (!signal) {
			lines.push(`${label}: (not present)`);
			return;
		}
		lines.push(`${label} (${signal.truncated ? "truncated, " : ""}${signal.content.length} chars):`);
		lines.push(indentBlock(signal.content));
	};
	file("README.md", signals.readme);
	file("AGENTS.md", signals.agentsMd);
	file("CLAUDE.md", signals.claudeMd);
	if (signals.manifest) {
		lines.push(`${signals.manifest.kind} (${signals.manifest.truncated ? "truncated, " : ""}${signals.manifest.content.length} chars):`);
		lines.push(indentBlock(signals.manifest.content));
	} else {
		lines.push("manifest: (not detected)");
	}
	lines.push(
		`top-level dirs: ${signals.topLevelDirs.length ? signals.topLevelDirs.join(", ") : "(none)"}`,
	);
	return lines.join("\n");
}

function renderExistingMindsBlock(minds: ExistingMind[]): string {
	if (minds.length === 0) return "(none)";
	return minds
		.map((m) => `- ${m.slug}${m.soulFirstLine ? ` — ${m.soulFirstLine}` : ""}`)
		.join("\n");
}

function renderSizeDirective(sizeOverride?: number): string {
	if (typeof sizeOverride === "number" && sizeOverride > 0) {
		return `Propose exactly ${sizeOverride} member${sizeOverride === 1 ? "" : "s"}.`;
	}
	return "Propose 3 to 5 members. Fewer if the scope is tight.";
}

function renderUniverseDirective(input: AssembleProposalInput): string {
	if (input.noUniverse) {
		return 'Do NOT use fictional names. Use literal, role-descriptive names. Set "universe" to "literal".';
	}
	if (input.universeOverride) {
		return `Use this fictional universe for naming the team members: ${input.universeOverride}.`;
	}
	return 'Pick a fictional universe for naming the team members (e.g. The Usual Suspects, Ocean\'s Eleven, Heat, Alien, Blade Runner, Star Wars). Pick whichever fits the project\'s vibe.';
}

function renderRegenerateBlock(input: AssembleProposalInput): string {
	if (!input.previousProposal && !input.feedback) return "";
	const lines: string[] = ["", "REGENERATE NOTES"];
	if (input.feedback?.trim()) {
		lines.push(`User feedback on the previous proposal: "${input.feedback.trim()}"`);
	} else {
		lines.push(
			"Previous proposal was rejected without specific feedback. Try a different angle: different roles, different names, or a different universe.",
		);
	}
	if (input.previousProposal) {
		lines.push("Previous proposal (do not repeat):");
		lines.push(indentBlock(JSON.stringify(input.previousProposal, null, 2)));
	}
	return `\n\n${lines.join("\n")}`;
}

function indentBlock(text: string): string {
	return text
		.split("\n")
		.map((line) => `  ${line}`)
		.join("\n");
}
