/**
 * Conformance test: every vendored Archon default workflow must parse cleanly
 * against pi-chamber's schema.
 *
 * If this test starts failing, Archon shipped a schema change we don't honor
 * yet. Re-sync `procedures/schema/` per the procedure in
 * `procedures/schema/ARCHON_VERSION.md`.
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

const FIXTURES_DIR = path.join(import.meta.dir, "test-fixtures", "archon-defaults");

const fixtures = fs
	.readdirSync(FIXTURES_DIR)
	.filter((f) => f.endsWith(".yaml"))
	.sort();

describe("Archon defaults conformance", () => {
	test("at least one fixture exists (sanity)", () => {
		expect(fixtures.length).toBeGreaterThan(0);
	});

	for (const file of fixtures) {
		test(`parses ${file}`, () => {
			const filePath = path.join(FIXTURES_DIR, file);
			const content = fs.readFileSync(filePath, "utf-8");
			const result = parseWorkflow(content, file);
			if (result.error) {
				throw new Error(
					`Conformance regression: ${file} failed to parse — ${result.error.error}\n` +
						`If Archon shipped a schema change, re-sync per procedures/schema/ARCHON_VERSION.md.`,
				);
			}
			expect(result.workflow).not.toBeNull();
			expect(result.workflow?.nodes.length).toBeGreaterThan(0);
		});
	}
});
