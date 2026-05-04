import { ensureTrailingNewline } from "../genesis/core.ts";
import type { ExistingMind, RepoSignals } from "./signals.ts";

const ASSEMBLE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const ASSEMBLE_MAX_SLUG_LEN = 40;

// ---------------------------------------------------------------------------
// Assemble proposer — team recommendation prompt + strict JSON parser
//
// Used by /assembly to ask a child Pi process to propose a team of minds based
// on a project description and bounded repo signals. Output is a strict JSON
// object whose `members` array shapes individual Genesis authoring runs that
// follow.
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
	/**
	 * Preferred team_slug when available. The orchestrator passes
	 * `"assembly"` for the first convene of a workspace so the simple
	 * single-team case skips contextual naming. Belt-and-suspenders override
	 * happens after parsing.
	 */
	defaultTeamSlug?: string;
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
	const defaultSlugDirective = renderDefaultSlugDirective(input.defaultTeamSlug);
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
- ${universeDirective}${defaultSlugDirective}
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
			"Assemble proposer output did not contain a JSON object. Re-run /assembly to retry.",
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

export function validateAssembleProposal(
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
	const file = (
		label: string,
		signal: { content: string; truncated: boolean } | undefined,
	) => {
		if (!signal) {
			lines.push(`${label}: (not present)`);
			return;
		}
		lines.push(
			`${label} (${signal.truncated ? "truncated, " : ""}${signal.content.length} chars):`,
		);
		lines.push(indentBlock(signal.content));
	};
	file("README.md", signals.readme);
	file("AGENTS.md", signals.agentsMd);
	file("CLAUDE.md", signals.claudeMd);
	if (signals.manifest) {
		lines.push(
			`${signals.manifest.kind} (${signals.manifest.truncated ? "truncated, " : ""}${signals.manifest.content.length} chars):`,
		);
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

function renderDefaultSlugDirective(defaultTeamSlug: string | undefined): string {
	if (!defaultTeamSlug) return "";
	return `\n- Use "${defaultTeamSlug}" as the team_slug and a matching display name (title-cased equivalent) when this is the first team for the project; only pick a contextual slug if the project clearly demands one.`;
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
