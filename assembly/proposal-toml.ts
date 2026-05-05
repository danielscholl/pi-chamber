// assembly/proposal-toml — round-trip the AssembleProposal as TOML so
// users can review/edit the generated team in a plain-text editor.
//
// Format choice: TOML over YAML/JSON because Bun.TOML.parse is built-in
// and TOML's literal multi-line strings ('''...''') round-trip arbitrary
// human text without escape-handling, which matters for the long-form
// `rationale` and `voiceDescription` fields.

import {
	type AssembleProposal,
	validateAssembleProposal,
} from "./prompts.ts";

export function serializeProposalToToml(proposal: AssembleProposal): string {
	const lines: string[] = [];
	lines.push(`project = ${formatString(proposal.project)}`);
	lines.push(`team_name = ${formatString(proposal.team_name)}`);
	lines.push(`team_slug = ${formatString(proposal.team_slug)}`);
	lines.push(`universe = ${formatString(proposal.universe)}`);
	lines.push(`rationale = ${formatString(proposal.rationale)}`);

	for (const m of proposal.members) {
		lines.push("");
		lines.push("[[members]]");
		lines.push(`name = ${formatString(m.name)}`);
		lines.push(`slug = ${formatString(m.slug)}`);
		lines.push(`role = ${formatString(m.role)}`);
		lines.push(`voice = ${formatString(m.voice)}`);
		lines.push(`voiceDescription = ${formatString(m.voiceDescription)}`);
		lines.push(`rationale = ${formatString(m.rationale)}`);
	}

	return `${lines.join("\n")}\n`;
}

export type ParseResult =
	| { ok: true; proposal: AssembleProposal }
	| { ok: false; error: string };

export function parseProposalFromToml(text: string): ParseResult {
	let parsed: unknown;
	try {
		// biome-ignore lint/suspicious/noExplicitAny: Bun global typing varies.
		parsed = (globalThis as any).Bun.TOML.parse(text);
	} catch (error) {
		return { ok: false, error: `TOML syntax error: ${errorMessage(error)}` };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return {
			ok: false,
			error: "TOML root must be a table (key/value pairs).",
		};
	}
	try {
		const proposal = validateAssembleProposal(
			parsed as Record<string, unknown>,
		);
		return { ok: true, proposal };
	} catch (error) {
		return { ok: false, error: errorMessage(error) };
	}
}

// Pick the TOML string form: literal multi-line ('''...''') when the value
// contains newlines (no escape processing — round-trips arbitrary text);
// basic single-line ("...") otherwise. The literal-multiline form can't
// contain three consecutive single quotes, so we fall back to escaped
// basic-multiline in that rare case.
function formatString(value: string): string {
	if (value.includes("\n")) {
		if (!value.includes("'''")) {
			const trailing = value.endsWith("\n") ? "" : "\n";
			return `'''\n${value}${trailing}'''`;
		}
		const escaped = value
			.replace(/\\/g, "\\\\")
			.replace(/"""/g, '\\"\\"\\"')
			.replace(/"/g, '\\"');
		return `"""\n${escaped}\n"""`;
	}
	const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	return `"${escaped}"`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
