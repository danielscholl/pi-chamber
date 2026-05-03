export interface ObservatoryFrameInput {
	title: string;
	subtitle?: string;
	sidebar: string[];
	body: string[];
	footer: string;
	notification?: { message: string; type: "info" | "warning" | "error" } | null;
	width: number;
	height: number;
}

export interface ColumnLayout {
	width: number;
	sidebarWidth: number;
	bodyWidth: number;
	bodyHeight: number;
}

const SEPARATOR = " │ ";
const MIN_SIDEBAR = 18;
const MAX_SIDEBAR = 30;

export function computeColumnLayout(width: number, height: number): ColumnLayout {
	const w = Math.max(40, width);
	let sidebar = Math.floor(w * 0.3);
	if (sidebar < MIN_SIDEBAR) sidebar = MIN_SIDEBAR;
	if (sidebar > MAX_SIDEBAR) sidebar = MAX_SIDEBAR;
	if (sidebar + 12 + SEPARATOR.length > w) sidebar = Math.max(8, w - 12 - SEPARATOR.length);
	const body = w - sidebar - SEPARATOR.length;
	// Title (1) + separator under title (1) + footer (1) + optional notification (1).
	const bodyHeight = Math.max(3, height - 3);
	return { width: w, sidebarWidth: sidebar, bodyWidth: body, bodyHeight };
}

export function renderObservatoryFrame(input: ObservatoryFrameInput): string[] {
	const { title, subtitle, sidebar, body, footer, notification, width, height } =
		input;
	const layout = computeColumnLayout(width, height);
	const lines: string[] = [];

	lines.push(renderTitleBar(title, subtitle, layout.width));
	lines.push(repeat("─", layout.width));

	const sidebarPadded = padColumn(sidebar, layout.sidebarWidth, layout.bodyHeight);
	const bodyPadded = padColumn(body, layout.bodyWidth, layout.bodyHeight);

	for (let i = 0; i < layout.bodyHeight; i++) {
		lines.push(`${sidebarPadded[i]}${SEPARATOR}${bodyPadded[i]}`);
	}

	if (notification) {
		const prefix =
			notification.type === "error"
				? "✗"
				: notification.type === "warning"
					? "⚠"
					: "ℹ";
		lines.push(truncate(`${prefix} ${notification.message}`, layout.width));
	}
	lines.push(truncate(footer, layout.width));
	return lines;
}

function renderTitleBar(
	title: string,
	subtitle: string | undefined,
	width: number,
): string {
	const main = subtitle ? `${title} · ${subtitle}` : title;
	return truncate(main, width);
}

function padColumn(lines: string[], width: number, height: number): string[] {
	const out: string[] = [];
	for (let i = 0; i < height; i++) {
		const raw = lines[i] ?? "";
		out.push(padRight(truncate(raw, width), width));
	}
	return out;
}

function padRight(text: string, width: number): string {
	if (text.length >= width) return text;
	return text + " ".repeat(width - text.length);
}

function truncate(text: string, width: number): string {
	if (text.length <= width) return text;
	if (width <= 1) return text.slice(0, width);
	return `${text.slice(0, width - 1)}…`;
}

function repeat(ch: string, n: number): string {
	if (n <= 0) return "";
	return ch.repeat(n);
}
