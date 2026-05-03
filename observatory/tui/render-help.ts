export function renderHelp(width: number): string[] {
	const w = Math.max(20, width);
	const sections: string[][] = [
		[
			"Observatory — keys",
			"",
			"  j / k       move sidebar selection",
			"  ↑ / ↓       move sidebar selection",
			"  enter, l, → enter detail mode",
			"  h, ←, esc   leave detail (or exit overlay)",
			"  q           exit overlay",
			"  r           refresh: re-discover and reload data",
			"  e           expand long values (flat briefings only)",
			"  g g         scroll body to top",
			"  G           scroll body to bottom",
			"  ctrl-d / u  half-page scroll in detail",
			"  ?           toggle this help",
		],
		[
			"Authoring lenses",
			"",
			"Each lens lives at .pi/observatory/lenses/<slug>/ with two files:",
			"",
			"  lens.json:",
			'    { "name": "Operations",',
			'      "kind": "briefing",',
			'      "source": "data.json",',
			'      "icon": "activity",',
			'      "description": "..." }',
			"",
			"  data.json (briefing):",
			"    sectioned   → { priority, metrics, activity, lists,",
			"                    narrative, details, summary, status }",
			'    flat        → { "active_minds": 3, ... } (card grid)',
			"",
			"  data.json (status-board):",
			"    array       → [{ name, status, ... }, ...]",
		],
	];
	const out: string[] = [];
	for (let i = 0; i < sections.length; i++) {
		if (i > 0) out.push("");
		for (const line of sections[i]) {
			out.push(truncate(line, w));
		}
	}
	return out;
}

function truncate(text: string, width: number): string {
	if (text.length <= width) return text;
	if (width <= 1) return text.slice(0, width);
	return `${text.slice(0, width - 1)}…`;
}
