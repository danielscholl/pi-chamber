// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import * as fs from "node:fs";
// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import * as os from "node:os";
// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import * as path from "node:path";

import {
	discoverProcedures,
	findWorkflow,
	groupBySource,
	parseArgs,
	resolveCommandFile,
	resolveProceduresPaths,
} from "./core.ts";

function tmp(prefix = "pi-procedures-core-"): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("resolveProceduresPaths", () => {
	test("composes the four canonical discovery roots in precedence order", () => {
		const cwd = "/repo";
		const home = "/Users/me";
		const bundled = "/abs/bundled";
		const paths = resolveProceduresPaths({ cwd, homeDir: home, bundledDir: bundled });

		expect(paths.rootDir).toBe("/repo/.pi/procedures");
		expect(paths.runsDir).toBe("/repo/.pi/procedures/runs");
		expect(paths.discoveryRoots.map((r) => r.dir)).toEqual([
			"/abs/bundled",
			"/Users/me/.pi/procedures",
			"/repo/.pi/procedures",
			"/repo/.archon/workflows",
		]);
		expect(paths.discoveryRoots.map((r) => r.source)).toEqual([
			"bundled",
			"global",
			"project",
			"project",
		]);
	});

	test("commandRoots include both .pi/commands and .archon/commands", () => {
		const paths = resolveProceduresPaths({ cwd: "/r", homeDir: "/h" });
		expect(paths.commandRoots).toEqual(["/r/.pi/commands", "/r/.archon/commands"]);
	});
});

describe("discoverProcedures + findWorkflow + groupBySource", () => {
	test("finds workflows across roots and groups them by source", () => {
		const cwd = tmp("pi-cwd-");
		const home = tmp("pi-home-");
		const bundled = tmp("pi-bundled-");

		// project workflow
		fs.mkdirSync(path.join(cwd, ".pi", "procedures"), { recursive: true });
		fs.writeFileSync(
			path.join(cwd, ".pi", "procedures", "deploy.yaml"),
			"name: deploy\ndescription: ship it\nnodes:\n  - id: a\n    bash: echo go\n",
		);
		// global workflow
		fs.mkdirSync(path.join(home, ".pi", "procedures"), { recursive: true });
		fs.writeFileSync(
			path.join(home, ".pi", "procedures", "lint.yaml"),
			"name: lint\ndescription: format check\nnodes:\n  - id: a\n    bash: echo lint\n",
		);
		// bundled workflow
		fs.writeFileSync(
			path.join(bundled, "hello.yaml"),
			"name: hello\ndescription: smoke\nnodes:\n  - id: a\n    prompt: hi\n",
		);

		const paths = resolveProceduresPaths({ cwd, homeDir: home, bundledDir: bundled });
		const discovery = discoverProcedures(paths);
		const names = discovery.workflows.map((w) => w.workflow.name).sort();
		expect(names).toEqual(["deploy", "hello", "lint"]);

		const groups = groupBySource(discovery);
		expect(groups.bundled.map((w) => w.workflow.name)).toEqual(["hello"]);
		expect(groups.global.map((w) => w.workflow.name)).toEqual(["lint"]);
		expect(groups.project.map((w) => w.workflow.name)).toEqual(["deploy"]);
	});

	test("project root overrides bundled with same name", () => {
		const cwd = tmp("pi-cwd-");
		const bundled = tmp("pi-bundled-");
		fs.writeFileSync(
			path.join(bundled, "hello.yaml"),
			"name: hello\ndescription: bundled\nnodes:\n  - id: a\n    prompt: hi\n",
		);
		fs.mkdirSync(path.join(cwd, ".pi", "procedures"), { recursive: true });
		fs.writeFileSync(
			path.join(cwd, ".pi", "procedures", "hello.yaml"),
			"name: hello\ndescription: project-override\nnodes:\n  - id: a\n    prompt: hi\n",
		);
		const paths = resolveProceduresPaths({
			cwd,
			homeDir: tmp("pi-home-"),
			bundledDir: bundled,
		});
		const discovery = discoverProcedures(paths);
		const found = findWorkflow(discovery, "hello");
		expect(found?.workflow.description).toBe("project-override");
		expect(found?.source).toBe("project");
	});

	test(".archon/workflows is also discovered as a project root", () => {
		const cwd = tmp("pi-cwd-");
		fs.mkdirSync(path.join(cwd, ".archon", "workflows"), { recursive: true });
		fs.writeFileSync(
			path.join(cwd, ".archon", "workflows", "from-archon.yaml"),
			"name: from-archon\ndescription: zero-config archon reuse\nnodes:\n  - id: a\n    prompt: hi\n",
		);
		const paths = resolveProceduresPaths({
			cwd,
			homeDir: tmp("pi-home-"),
			bundledDir: tmp("pi-bundled-"),
		});
		const found = findWorkflow(discoverProcedures(paths), "from-archon");
		expect(found).toBeDefined();
		expect(found?.source).toBe("project");
	});
});

describe("parseArgs", () => {
	test("empty input → picker", () => {
		expect(parseArgs("")).toEqual({ mode: "picker" });
		expect(parseArgs(undefined)).toEqual({ mode: "picker" });
		expect(parseArgs("   ")).toEqual({ mode: "picker" });
	});

	test("'list' is recognized", () => {
		expect(parseArgs("list")).toEqual({ mode: "list" });
	});

	test("'show <name>' captures name", () => {
		expect(parseArgs("show triage")).toEqual({ mode: "show", name: "triage" });
	});

	test("'show' without name is an error", () => {
		const result = parseArgs("show");
		expect(result.mode).toBe("error");
	});

	test("'run <name>' with positional args", () => {
		const result = parseArgs("run triage 123 high");
		expect(result).toEqual({ mode: "run", name: "triage", runArgs: ["123", "high"], strict: false });
	});

	test("'run <name> --strict' captures the strict flag without polluting args", () => {
		const result = parseArgs("run triage --strict 123");
		expect(result).toEqual({ mode: "run", name: "triage", runArgs: ["123"], strict: true });
	});

	test("'run' without name is an error", () => {
		expect(parseArgs("run").mode).toBe("error");
	});

	test("'status' optionally captures a run id", () => {
		expect(parseArgs("status")).toEqual({ mode: "status", runId: undefined });
		expect(parseArgs("status 20260504-150000-abcdef")).toEqual({
			mode: "status",
			runId: "20260504-150000-abcdef",
		});
	});

	test("'halt' optionally captures a run id", () => {
		expect(parseArgs("halt")).toEqual({ mode: "halt", runId: undefined });
		expect(parseArgs("halt some-id")).toEqual({ mode: "halt", runId: "some-id" });
	});

	test("quoted multi-word args are kept whole", () => {
		const result = parseArgs('run greet "Hello world" extra');
		if (result.mode !== "run") throw new Error("expected run");
		expect(result.runArgs).toEqual(["Hello world", "extra"]);
	});

	test("unknown subcommand returns error", () => {
		expect(parseArgs("teleport").mode).toBe("error");
	});
});

describe("resolveCommandFile", () => {
	test("finds .md file under .pi/commands first", () => {
		const cwd = tmp();
		fs.mkdirSync(path.join(cwd, ".pi", "commands"), { recursive: true });
		fs.writeFileSync(path.join(cwd, ".pi", "commands", "lint.md"), "# lint");
		const file = resolveCommandFile(
			[path.join(cwd, ".pi", "commands"), path.join(cwd, ".archon", "commands")],
			"lint",
		);
		expect(file).toBe(path.join(cwd, ".pi", "commands", "lint.md"));
	});

	test("falls back to .archon/commands when not in .pi", () => {
		const cwd = tmp();
		fs.mkdirSync(path.join(cwd, ".archon", "commands"), { recursive: true });
		fs.writeFileSync(path.join(cwd, ".archon", "commands", "deploy.md"), "# deploy");
		const file = resolveCommandFile(
			[path.join(cwd, ".pi", "commands"), path.join(cwd, ".archon", "commands")],
			"deploy",
		);
		expect(file).toBe(path.join(cwd, ".archon", "commands", "deploy.md"));
	});

	test("returns null when not found", () => {
		expect(resolveCommandFile(["/nope"], "missing")).toBeNull();
	});
});
