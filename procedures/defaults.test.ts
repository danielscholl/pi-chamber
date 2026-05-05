/**
 * Bundled defaults sanity test: every YAML in `procedures/defaults/` must
 * parse cleanly through pi-chamber's own loader (i.e. not just Archon's
 * vendored schema, but our adapted loader with its provider/strict checks).
 *
 * If you add a default workflow, add a one-line assertion here so future
 * refactors of the loader / schema can't silently break our shipped examples.
 */

// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import * as fs from "node:fs";
// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import * as path from "node:path";

import { parseWorkflow } from "./loader.ts";

const DEFAULTS_DIR = path.join(import.meta.dir, "defaults");

const defaults = fs
	.readdirSync(DEFAULTS_DIR)
	.filter((f) => f.endsWith(".yaml"))
	.sort();

describe("bundled defaults", () => {
	test("ships at least the documented Phase 1 examples", () => {
		expect(defaults).toContain("hello-world.yaml");
		expect(defaults).toContain("status-report.yaml");
		expect(defaults).toContain("classify-changes.yaml");
	});

	for (const file of defaults) {
		test(`parses ${file} without errors or warnings`, () => {
			const content = fs.readFileSync(path.join(DEFAULTS_DIR, file), "utf-8");
			const result = parseWorkflow(content, file);
			if (result.error) {
				throw new Error(`bundled default ${file} failed to parse: ${result.error.error}`);
			}
			expect(result.workflow).not.toBeNull();
			// Bundled defaults are the public face — they should NOT trip any
			// Phase 1 ignored-capability warnings (those are for user workflows
			// authored elsewhere). If this assertion ever fails, simplify the
			// default rather than suppressing the check.
			expect(result.warnings).toEqual([]);
		});
	}
});
