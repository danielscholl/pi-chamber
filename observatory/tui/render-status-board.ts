import { type Colorize, noColorize } from "./widgets/types.ts";
import { grid } from "./widgets/grid.ts";
import { panel } from "./widgets/panel.ts";
import { statusPill } from "./widgets/status-pill.ts";
import { normalizeStatusBoard } from "./status.ts";
import { truncateToWidth } from "./widgets/text.ts";

export function renderStatusBoard(
	data: unknown,
	width: number,
	colorize: Colorize = noColorize,
): string[] {
	const w = Math.max(20, width);
	const entries = normalizeStatusBoard(data);
	if (!entries.length) {
		return [truncateToWidth("(status-board has no entries yet)", w)];
	}

	const cells = entries.map((e) => (colWidth: number) => {
		const titleLeft = statusPill(e.tier, e.name, colorize);
		const titleRight = e.status ? `  [${e.status}]` : "";
		const title = titleLeft + titleRight;
		const body = e.extras.map((extra) => `${extra.key}: ${extra.value}`);
		return panel({ title, body, width: colWidth, colorize });
	});

	return grid({ cells, width: w, minColWidth: 28, gap: 2 });
}
