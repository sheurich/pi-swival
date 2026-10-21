import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const adapterPath = path.join(packageRoot, "integrations/pi-subagents.ts");

it("semantically checks the adapter and rejects a malformed public API call", () => {
	const configPath = path.join(packageRoot, "tests/tsconfig.json");
	const config = ts.readConfigFile(configPath, ts.sys.readFile);
	expect(config.error).toBeUndefined();
	const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
	expect(parsed.errors).toEqual([]);
	expect(parsed.fileNames, "adapter must be a semantic typecheck root").toContain(adapterPath);
	const program = ts.createProgram(parsed.fileNames, parsed.options);
	expect(ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
	const source = fs.readFileSync(adapterPath, "utf8");
	const call = "api.updateExternalRun(sessionId, id, patch)";
	expect(source).toContain(call);
	const mutated = source.replace(call, "api.updateExternalRun(42, id, patch)");
	const host = ts.createCompilerHost(parsed.options);
	const readFile = host.readFile.bind(host);
	host.readFile = (file) => path.resolve(file) === adapterPath ? mutated : readFile(file);
	const broken = ts.createProgram(parsed.fileNames, parsed.options, host);
	const diagnostics = broken.getSemanticDiagnostics().filter((d) => d.file?.fileName === adapterPath);
	expect(diagnostics.some((d) => d.code === 2345
		&& ts.flattenDiagnosticMessageText(d.messageText, " ").includes("number"))).toBe(true);
}, 30000);

// The only real-consumer selector is this explicit test-time environment variable.
// No installation, package discovery, or fallback to another consumer is permitted.
const selectedConsumerRoot = process.env.PI_SWIVAL_TEST_CONSUMER_ROOT;
const selectedConsumerScript = String.raw`
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const packageRoot = process.argv[2];
const root = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(packageRoot, "tests/package.json"));
const ts = require("typescript");
const selected = process.env.PI_SWIVAL_TEST_CONSUMER_ROOT;
assert(selected && path.isAbsolute(selected), "Select an absolute consumer package root explicitly");
assert.equal(JSON.parse(fs.readFileSync(path.join(selected, "package.json"), "utf8")).name, "pi-subagents");
fs.mkdirSync(path.join(root, "node_modules"));
fs.symlinkSync(selected, path.join(root, "node_modules/pi-subagents"), "dir");
const subpaths = ["pi-subagents/external-runs", "pi-subagents/background-work"];
// Both resolvers use the selected package's public exports, never guessed private paths.
const declarations = Object.fromEntries(subpaths.map((name) => {
  const resolved = ts.resolveModuleName(name, fileURLToPath(import.meta.url), {
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  }, ts.sys).resolvedModule;
  assert(resolved && /\.d\.(?:ts|mts|cts)$/.test(resolved.resolvedFileName), "Missing exported declarations: " + name);
  return [name, [resolved.resolvedFileName]];
}));
const configPath = path.join(packageRoot, "tests/tsconfig.json");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
assert.equal(config.error, undefined);
const paths = Object.fromEntries(Object.entries(config.config.compilerOptions.paths)
  .map(([name, values]) => [name, values.map((value) => path.resolve(path.dirname(configPath), value))]));
// Override the portable test contract with the actual public declarations for this selection.
const temporaryConfig = path.join(root, "tsconfig.json");
fs.writeFileSync(temporaryConfig, JSON.stringify({
  extends: configPath,
  compilerOptions: {
    paths: { ...paths, ...declarations },
    typeRoots: [path.join(packageRoot, "tests/node_modules/@types")],
  },
  include: [path.join(packageRoot, "integrations/pi-subagents.ts")],
}));
const read = ts.readConfigFile(temporaryConfig, ts.sys.readFile);
assert.equal(read.error, undefined);
const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
assert.deepEqual(parsed.errors, []);
const program = ts.createProgram(parsed.fileNames, parsed.options);
assert(!program.getSourceFiles().some((file) => file.fileName.endsWith("piSubagentsPublicApi.d.ts")),
  "Real semantic gate must not load the portable contract");
const diagnostics = ts.getPreEmitDiagnostics(program);
assert.deepEqual(diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")), []);
console.log("selected consumer root: " + selected);
console.log("selected public declarations: " + JSON.stringify(declarations));
console.log("selected consumer: real exported-declaration semantic gate passed");
for (const relative of ["integrations/pi-subagents.ts", "extensions/async-observation.ts"]) {
  const output = path.join(root, relative.replace(/\.ts$/, ".js"));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, ts.transpileModule(fs.readFileSync(path.join(packageRoot, relative), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText);
}
fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
const external = await import(import.meta.resolve("pi-subagents/external-runs"));
const background = await import(import.meta.resolve("pi-subagents/background-work"));
const { createPiSubagentsAdapter } = await import("./integrations/pi-subagents.js");
const api = {
  registerExternalRun: external.registerExternalRun,
  updateExternalRun: external.updateExternalRun,
  unregisterExternalRun: external.unregisterExternalRun,
  registerBackgroundWorkProvider: background.registerBackgroundWorkProvider,
};
assert.equal(Object.keys(api).length, 4);
const ownerId = "11111111-1111-4111-8111-111111111111";
const foreignId = "22222222-2222-4222-8222-222222222222";
const sessionId = path.join(root, "synthetic-session.jsonl");
const owner = { ownerSessionId: ownerId, ownerSessionFile: sessionId };
const messages = [];
const adapter = createPiSubagentsAdapter(api);
const row = (state = "running", fields = {}) => ({
  runId: "swival-contract-run", ownerSessionId: ownerId, ownerSessionFile: sessionId,
  agent: "synthetic", startedAt: 1000, state, ...fields,
});
const runs = () => external.snapshotExternalRuns(sessionId);
const work = () => background.snapshotBackgroundWork(sessionId, 2000);
const first = adapter({ owner, onDiagnostic: (message) => messages.push(message) });
let second;
try {
  first.update([row(), row("running", { runId: "foreign", ownerSessionId: foreignId }),
    row("running", { runId: "legacy", ownerSessionId: undefined })]);
  assert.deepEqual(runs().map(({ id, state, sessionId: session, source }) => ({ id, state, session, source })),
    [{ id: "swival-contract-run", state: "running", session: sessionId, source: "swival" }]);
  assert.deepEqual(work().items.map(({ id, sessionId: session, provider }) => ({ id, session, provider })),
    [{ id: "swival-contract-run", session: sessionId, provider: "pi-swival" }]);
  assert.deepEqual(background.snapshotBackgroundWork(ownerId, 2000).items, []);
  for (const state of ["completed", "failed"]) {
    first.update([row("running")]);
    first.update([row(state, { endedAt: 2000, answer: "private synthetic answer" })]);
    assert.equal(runs()[0].state, state);
    assert.equal(runs()[0].endedAt, 2000);
    assert(!JSON.stringify(runs()).includes("private synthetic answer"));
    assert.deepEqual(work().items, []);
  }
  first.update([row("unknown")]);
  assert.deepEqual(runs(), []);
  assert.deepEqual(work().items, []);
  assert(messages.some((message) => /unknown/i.test(message)));
  first.update([row()]);
  second = adapter({ owner, onDiagnostic: (message) => messages.push(message) });
  second.update([row()]);
  first.update([row("failed")]);
  first.dispose(); first.dispose();
  assert.equal(runs()[0].state, "running");
  assert.equal(work().items.length, 1);
  assert.deepEqual(work().providers, ["pi-swival"]);
  second.dispose(); second.dispose();
  assert.deepEqual(runs(), []);
  assert.deepEqual(work(), { providers: [], items: [] });
  assert(!messages.some((message) => /unavailable/i.test(message)));
} finally {
  first.dispose(); second?.dispose();
}
const memory = adapter({ owner: { ownerSessionId: ownerId }, onDiagnostic: assert.fail });
try {
  memory.update([row("running", { ownerSessionFile: undefined })]);
  assert.equal(external.snapshotExternalRuns(ownerId)[0].sessionId, ownerId);
  assert.equal(background.snapshotBackgroundWork(ownerId, 2000).items.length, 1);
} finally { memory.dispose(); }
assert.deepEqual(external.snapshotExternalRuns(ownerId), []);
assert.deepEqual(background.snapshotBackgroundWork(ownerId, 2000), { providers: [], items: [] });
console.log("selected consumer: public runtime running/terminal/unknown/ownership/replacement/cleanup gate passed");
`;

it.skipIf(selectedConsumerRoot === undefined)("optional selected consumer: public runtime and real semantic gate", () => {
	expect(path.isAbsolute(selectedConsumerRoot!), "PI_SWIVAL_TEST_CONSUMER_ROOT must be absolute").toBe(true);
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "swival-selected-consumer-"));
	try {
		const script = path.join(root, "gate.mjs");
		fs.writeFileSync(script, selectedConsumerScript);
		for (const dir of ["home", "agent", "tmp"]) fs.mkdirSync(path.join(root, dir));
		const result = spawnSync(process.execPath, [script, packageRoot], {
			cwd: root, shell: false, timeout: 60000, maxBuffer: 1024 * 1024, encoding: "utf8",
			env: {
				HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"),
				PI_CODING_AGENT_DIR: path.join(root, "agent"), PI_OFFLINE: "1",
				TMPDIR: path.join(root, "tmp"), TMP: path.join(root, "tmp"), TEMP: path.join(root, "tmp"),
				XDG_CONFIG_HOME: path.join(root, "home/.config"),
				XDG_CACHE_HOME: path.join(root, "home/.cache"),
				XDG_DATA_HOME: path.join(root, "home/.local/share"),
				PI_SWIVAL_TEST_CONSUMER_ROOT: selectedConsumerRoot!,
			},
		});
		expect(result.error, `${result.stdout}\n${result.stderr}`).toBeUndefined();
		expect(result.signal, `${result.stdout}\n${result.stderr}`).toBeNull();
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(result.stdout).toContain("real exported-declaration semantic gate passed");
		expect(result.stdout).toContain("public runtime running/terminal/unknown/ownership/replacement/cleanup gate passed");
		console.info(result.stdout.trim());
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}, 65000);

const adapterModule = await import("../integrations/pi-subagents.js").catch(() => ({} as any));
const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const FILE = "/synthetic/session.jsonl";

// A public-contract fixture. No private consumer registry access is needed.
function consumer() {
	const runs = new Map<string, any>();
	let provider: any;
	const key = (session: string, id: string) => `${session}\0${id}`;
	const api = {
		registerExternalRun: vi.fn((run: any) => {
			if (runs.has(key(run.sessionId, run.id))) throw new Error("duplicate");
			if (runs.size >= 100) throw new Error("capacity");
			runs.set(key(run.sessionId, run.id), { ...run }); return { ...run };
		}),
		updateExternalRun: vi.fn((session: string, id: string, patch: any) => {
			const previous = runs.get(key(session, id)); if (!previous) throw new Error("missing");
			const next = { ...previous, ...patch }; runs.set(key(session, id), next); return { ...next };
		}),
		unregisterExternalRun: vi.fn((session: string, id: string) => runs.delete(key(session, id))),
		registerBackgroundWorkProvider: vi.fn((value: any) => {
			provider = value; return () => { if (provider === value) provider = undefined; };
		}),
	};
	return { api, runs, provider: () => provider };
}

function row(state = "running", fields: Record<string, unknown> = {}) {
	return { runId: "swival-run-1000-abcd", ownerSessionId: OWNER, ownerSessionFile: FILE,
		agent: "test", startedAt: 1000, state, ...fields };
}

function start(api: any, owner = { ownerSessionId: OWNER, ownerSessionFile: FILE }) {
	expect(adapterModule.createPiSubagentsAdapter).toBeTypeOf("function");
	const adapter = adapterModule.createPiSubagentsAdapter(api);
	const diagnostic = vi.fn();
	const registration = adapter({ owner, onDiagnostic: diagnostic });
	return { adapter, registration, diagnostic };
}

describe("optional pi-subagents public adapter", () => {
	it("keeps the runtime boundary to four injected functions without consumer imports", () => {
		const source = fs.readFileSync(new URL("../integrations/pi-subagents.ts", import.meta.url), "utf8");
		const emitted = ts.transpileModule(source, {
			compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
		}).outputText;
		const tree = ts.createSourceFile("adapter.js", emitted, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
		const imports: string[] = [];
		const injected = new Set<string>();
		const visit = (node: ts.Node) => {
			if (ts.isImportDeclaration(node)) imports.push((node.moduleSpecifier as ts.StringLiteral).text);
			if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
				|| (ts.isIdentifier(node.expression) && ["require", "eval"].includes(node.expression.text)))) {
				throw new Error("Adapter must not dynamically load a consumer or execute code");
			}
			if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)
				&& node.expression.text === "api") injected.add(node.name.text);
			ts.forEachChild(node, visit);
		};
		visit(tree);
		expect(imports).toEqual(["../extensions/async-observation.js"]);
		expect([...injected].sort()).toEqual([
			"registerBackgroundWorkProvider", "registerExternalRun", "unregisterExternalRun", "updateExternalRun",
		]);
	});
	it("does not register before a session uses the explicit adapter", () => {
		const c = consumer();
		expect(adapterModule.createPiSubagentsAdapter).toBeTypeOf("function");
		adapterModule.createPiSubagentsAdapter(c.api);
		for (const fn of Object.values(c.api)) expect(fn).not.toHaveBeenCalled();
	});

	it("projects the consumer session file while keeping UUID ownership authoritative", () => {
		const c = consumer(); const { registration } = start(c.api);
		registration.update([row(), row("running", { runId: "foreign", ownerSessionId: OTHER }),
			row("running", { runId: "legacy", ownerSessionId: undefined })]);
		expect([...c.runs.values()]).toMatchObject([{ sessionId: FILE, state: "running", source: "swival" }]);
		expect(c.provider().listActiveWork({ sessionId: FILE, nowMs: 1000 })).toMatchObject([{ sessionId: FILE }]);
		expect(c.provider().listActiveWork({ sessionId: OWNER, nowMs: 1000 })).toEqual([]);
		expect(c.provider().wakeChannels).toEqual(["pi-swival:async-observation"]);
		expect(c.provider()).not.toHaveProperty("stop");
		registration.dispose();
	});

	it("falls back to UUID for an in-memory consumer session", () => {
		const c = consumer(); const { registration } = start(c.api, { ownerSessionId: OWNER } as any);
		registration.update([row("running", { ownerSessionFile: undefined })]);
		expect([...c.runs.values()][0].sessionId).toBe(OWNER);
		registration.dispose();
	});

	it("does not fabricate a consumer state for unknown recovered activity", () => {
		const c = consumer(); const { registration, diagnostic } = start(c.api);
		registration.update([row("unknown")]);
		expect(c.runs.size).toBe(0); expect(c.provider().listActiveWork()).toEqual([]);
		expect(diagnostic).toHaveBeenCalledWith(expect.stringMatching(/unknown/i));
		registration.update([row("completed")]);
		expect([...c.runs.values()]).toMatchObject([{ state: "completed" }]);
		registration.dispose();
	});

	it("updates display-only terminal states and removes wait activity without returning output", () => {
		const c = consumer(); const { registration } = start(c.api);
		registration.update([row()]); const initial = c.provider().listActiveWork();
		registration.update([row("failed", { endedAt: 2000, answer: "private answer" })]);
		expect(initial).toHaveLength(1); expect(c.provider().listActiveWork()).toEqual([]);
		expect([...c.runs.values()]).toMatchObject([{ state: "failed" }]);
		expect(JSON.stringify([...c.runs.values()])).not.toContain("private answer");
		expect(c.api.updateExternalRun).toHaveBeenCalledTimes(1);
		registration.dispose();
	});

	it("keeps synchronous provider reads cached and returns independent arrays", () => {
		const c = consumer(); const { registration } = start(c.api);
		registration.update([row()]);
		const first = c.provider().listActiveWork(); first[0].id = "mutated"; first.pop();
		expect(c.provider().listActiveWork()).toHaveLength(1);
		expect(c.provider().listActiveWork()[0].id).not.toBe("mutated");
		for (let i = 0; i < 50; i++) c.provider().listActiveWork({ sessionId: FILE, nowMs: i });
		expect(c.api.registerExternalRun).toHaveBeenCalledTimes(1);
		expect(c.api.updateExternalRun).not.toHaveBeenCalled();
		registration.dispose();
	});

	it("bounds Fleet rows separately from background wait items", () => {
		const c = consumer(); const { registration } = start(c.api);
		registration.update(Array.from({ length: 110 }, (_, i) => row("running", { runId: `run-${i}` })));
		expect(c.runs.size).toBeLessThanOrEqual(20);
		expect(c.provider().listActiveWork()).toHaveLength(100);
		registration.dispose(); expect(c.runs.size).toBe(0);
	});

	it.each(["completed", "failed"])("delivers %s before a displayed run leaves a full live Fleet", (state) => {
		const c = consumer(); const { registration } = start(c.api);
		const live = Array.from({ length: 100 }, (_, i) => row("running", { runId: `live-${i}`, startedAt: 2000 + i }));
		registration.update(live);
		const selected = live.at(-1)!;
		c.api.updateExternalRun.mockClear(); c.api.unregisterExternalRun.mockClear();
		registration.update([{ ...selected, state }, ...live.slice(0, -1)]);
		expect(c.api.updateExternalRun).toHaveBeenCalledWith(FILE, selected.runId, expect.objectContaining({ state }));
		expect(c.api.updateExternalRun.mock.invocationCallOrder[0]).toBeLessThan(c.api.unregisterExternalRun.mock.invocationCallOrder[0]);
		expect(c.provider().listActiveWork()).toHaveLength(99);
		expect(c.runs.size).toBe(20); registration.dispose();
	});

	it("rolls back partial display registration when a public API fails", () => {
		const c = consumer(); const { registration, diagnostic } = start(c.api);
		let calls = 0;
		c.api.registerExternalRun.mockImplementation((run) => {
			if (++calls === 2) throw new Error("private error text");
			c.runs.set(`${run.sessionId}\0${run.id}`, run); return run;
		});
		registration.update([row(), row("running", { runId: "second" })]);
		expect(c.runs.size).toBe(0); expect(c.provider()).toBeUndefined();
		expect(diagnostic).toHaveBeenCalledWith(expect.stringMatching(/unavailable/i));
		expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("private error text");
		registration.dispose();
	});

	it("reports a provider registration failure without leaving display rows", () => {
		const c = consumer();
		c.api.registerBackgroundWorkProvider.mockImplementation(() => { throw new Error("capacity"); });
		const { registration, diagnostic } = start(c.api);
		registration.update([row()]);
		expect(c.runs.size).toBe(0);
		expect(diagnostic).toHaveBeenCalledWith(expect.stringMatching(/unavailable/i));
		registration.dispose();
	});

	it("retires old callbacks and prevents old cleanup from deleting replacement registrations", () => {
		const c = consumer(); const first = start(c.api);
		first.registration.update([row()]); const stale = c.provider();
		const second = start(c.api); second.registration.update([row()]);
		const current = c.provider();
		first.registration.update([row("failed")]); first.registration.dispose(); first.registration.dispose();
		expect(c.provider()).toBe(current);
		expect(c.runs.size).toBe(1);
		expect(stale.listActiveWork()).toEqual([]);
		expect([...c.runs.values()][0].state).toBe("running");
		second.registration.dispose(); expect(c.runs.size).toBe(0); expect(c.provider()).toBeUndefined();
	});

	it("filters malformed rows and duplicate identities before public registration", () => {
		const c = consumer(); const { registration } = start(c.api);
		registration.update([row(), row(), row("running", { runId: "bad\nidentity" }),
			row("running", { runId: "bad-time", startedAt: -1 }),
			row("running", { runId: "x".repeat(5000) })]);
		expect(c.runs.size).toBe(1); expect(c.provider().listActiveWork()).toHaveLength(1);
		registration.dispose();
	});

	it("completes all teardown steps even when public callbacks throw", () => {
		const c = consumer();
		const providerDispose = vi.fn(() => { throw new Error("private failure"); });
		c.api.registerBackgroundWorkProvider.mockReturnValue(providerDispose);
		const { registration, diagnostic } = start(c.api);
		registration.update([row(), row("running", { runId: "second" })]);
		c.api.unregisterExternalRun.mockImplementation(() => { throw new Error("private failure"); });
		expect(() => { registration.dispose(); registration.dispose(); }).not.toThrow();
		expect(c.api.unregisterExternalRun).toHaveBeenCalledTimes(2);
		expect(providerDispose).toHaveBeenCalledOnce();
		expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("private failure");
	});

	it("wait cancellation has no execution control and leaves the active snapshot intact", () => {
		const c = consumer(); const { registration } = start(c.api);
		registration.update([row()]);
		const abort = new AbortController(); abort.abort();
		expect(c.provider().listActiveWork()).toHaveLength(1);
		expect(Object.keys(c.provider()).sort()).toEqual(["listActiveWork", "name", "wakeChannels"]);
		registration.dispose();
	});
});
