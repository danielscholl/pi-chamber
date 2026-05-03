// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import { renderBriefingPage } from "./render-briefing-page.ts";
import { visibleWidth } from "./widgets/text.ts";

const manifest = { name: "Jarvis Newspaper", kind: "briefing" as const };

describe("renderBriefingPage", () => {
	test("page header has name and kind on line 1", () => {
		const out = renderBriefingPage({
			manifest,
			page: {},
			width: 60,
		});
		expect(out[0]).toContain("Jarvis Newspaper");
		expect(out[0]).toContain("briefing");
	});

	test("page header line 2 has summary and status when both present", () => {
		const out = renderBriefingPage({
			manifest,
			page: { summary: "Last updated 38m ago", status: "running" },
			width: 60,
		});
		expect(out[1]).toContain("Last updated 38m ago");
		expect(out[1]).toContain("status:");
		expect(out[1]).toContain("running");
	});

	test("page header line 2 omitted when neither summary nor status", () => {
		const out = renderBriefingPage({
			manifest,
			page: {},
			width: 60,
		});
		// No body sections present, so header is the only content.
		// Line 1 only — no subtitle.
		expect(out.length).toBe(1);
	});

	test("priority renders below header with blank-line separator", () => {
		const out = renderBriefingPage({
			manifest,
			page: {
				priority: {
					title: "Top Priority",
					body: "Ship the dashboard controls.",
				},
			},
			width: 60,
		});
		expect(out.some((l) => l.includes("Top Priority"))).toBe(true);
		expect(out.some((l) => l.includes("Ship the dashboard controls."))).toBe(
			true,
		);
	});

	test("metrics section renders with METRICS header and divider", () => {
		const out = renderBriefingPage({
			manifest,
			page: {
				metrics: [
					{ label: "inbox", value: "3" },
					{ label: "domains", value: "2" },
				],
			},
			width: 60,
		});
		const joined = out.join("\n");
		expect(joined).toContain("METRICS");
		expect(joined).toContain("inbox");
		expect(joined).toContain("3");
	});

	test("activity section uses RECENT CHANGES label and numbered items", () => {
		const out = renderBriefingPage({
			manifest,
			page: { activity: ["alpha", "bravo"] },
			width: 60,
		});
		const joined = out.join("\n");
		expect(joined).toContain("RECENT CHANGES");
		expect(joined).toContain("01");
		expect(joined).toContain("02");
		expect(joined).toContain("alpha");
	});

	test("lists section uses each list's title", () => {
		const out = renderBriefingPage({
			manifest,
			page: {
				lists: [
					{
						title: "Domains",
						items: ["observatory", "agents"],
						style: "inline",
					},
				],
			},
			width: 60,
		});
		const joined = out.join("\n");
		expect(joined).toContain("DOMAINS");
		expect(joined).toContain("observatory");
		expect(joined).toContain("·");
	});

	test("narrative section renders heading and body", () => {
		const out = renderBriefingPage({
			manifest,
			page: {
				narrative: [{ heading: "Audience", body: "First-time operators." }],
			},
			width: 60,
		});
		const joined = out.join("\n");
		expect(joined).toContain("NARRATIVE");
		expect(joined).toContain("Audience");
		expect(joined).toContain("First-time operators.");
	});

	test("details section renders dim k/v rows", () => {
		const out = renderBriefingPage({
			manifest,
			page: { details: [{ label: "audience", value: "first-timers" }] },
			width: 60,
		});
		const joined = out.join("\n");
		expect(joined).toContain("DETAILS");
		expect(joined).toContain("audience");
		expect(joined).toContain("first-timers");
	});

	test("section order is fixed: priority → metrics → activity → lists → narrative → details", () => {
		const out = renderBriefingPage({
			manifest,
			page: {
				details: [{ label: "k", value: "v" }],
				narrative: [{ heading: "N", body: "n" }],
				lists: [{ title: "Listsection", items: ["x"], style: "bullet" }],
				activity: ["a"],
				metrics: [{ label: "m", value: "1" }],
				priority: { title: "P", body: "p" },
			},
			width: 60,
		});
		const joined = out.join("\n");
		const priorityIdx = joined.indexOf("╭"); // priority card top border
		const metricsIdx = joined.indexOf("METRICS");
		const recentIdx = joined.indexOf("RECENT CHANGES");
		const listIdx = joined.indexOf("LISTSECTION");
		const narrativeIdx = joined.indexOf("NARRATIVE");
		const detailsIdx = joined.indexOf("DETAILS");
		expect(priorityIdx).toBeGreaterThanOrEqual(0);
		expect(metricsIdx).toBeGreaterThan(priorityIdx);
		expect(recentIdx).toBeGreaterThan(metricsIdx);
		expect(listIdx).toBeGreaterThan(recentIdx);
		expect(narrativeIdx).toBeGreaterThan(listIdx);
		expect(detailsIdx).toBeGreaterThan(narrativeIdx);
	});

	test("every line is padded to exactly the requested width", () => {
		const out = renderBriefingPage({
			manifest,
			page: {
				summary: "Last updated 38m ago",
				status: "running",
				priority: {
					title: "Top Priority",
					body: "Ship the dashboard controls.",
				},
				metrics: [{ label: "inbox", value: "3" }],
				activity: ["alpha"],
				lists: [{ title: "Domains", items: ["o", "a"], style: "inline" }],
				narrative: [{ heading: "H", body: "b" }],
				details: [{ label: "k", value: "v" }],
			},
			width: 50,
		});
		for (const line of out) {
			expect(visibleWidth(line)).toBe(50);
		}
	});

	test("empty-section arrays do not render that section", () => {
		const out = renderBriefingPage({
			manifest,
			page: { metrics: [], activity: [], lists: [], narrative: [], details: [] },
			width: 60,
		});
		const joined = out.join("\n");
		expect(joined).not.toContain("METRICS");
		expect(joined).not.toContain("RECENT CHANGES");
		expect(joined).not.toContain("NARRATIVE");
		expect(joined).not.toContain("DETAILS");
	});

	test("status color key is invoked from the tier classification", () => {
		const calls: string[] = [];
		renderBriefingPage({
			manifest,
			page: { status: "running" }, // running → tier "ok" → "success"
			width: 60,
			colorize: (key, text) => {
				calls.push(key);
				return text;
			},
		});
		expect(calls).toContain("success");
	});
});
