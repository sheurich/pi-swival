import { expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ANTHROPIC_OAUTH_SHIM_DIR } from "../extensions/contracts.js";
import { resolveSwivalEvidenceEnv } from "../extensions/child-env.js";

it.each([
	{ args: ["--sandbox", "agentfs"], project: "", global: "", granted: true },
	{ args: ["--sandbox=builtin"], project: 'sandbox="agentfs"', global: "", granted: false },
	{ args: [], project: 'sandbox="agentfs"', global: 'sandbox="nono"', granted: true },
	{ args: [], project: "", global: 'sandbox="agentfs"', granted: true },
	{ args: ["--profile", "chosen"], project: '[profiles.chosen]\nsandbox="agentfs"', global: "", granted: false },
	{ args: ["--sandbox", "agentfs", "--network=none"], project: "", global: "", granted: false },
	{ args: ["--sandbox", "agentfs"], project: 'network="none"', global: "", granted: false },
	{ args: [], project: 'sandbox="agentfs"', global: 'network="none"', granted: false },
	{ args: ["--network", "provider-only"], project: 'sandbox="agentfs"', global: 'network="none"', granted: true },
	{ args: ["--", "--sandbox", "agentfs"], project: "", global: "", granted: false },
	{ args: [], project: "", global: 'sandbox="agentfs"', emptyProject: true, granted: true },
	{ args: [], project: 'sandbox="agentfs"', global: 'network="none"', symlinked: true, granted: false },
	{ args: [], project: "", global: 'sandbox="agentfs"', symlinked: true, granted: true },
	// Unrelated plain quoted keys stay inert; quoted or escaped spellings of the queried key fail closed.
	{ args: ["--sandbox", "agentfs"], project: "", global: '"provider" = "chatgpt"\nmodel = "gpt-offline"', granted: true },
	{ args: [], project: '"provider" = "chatgpt"\nsandbox = "agentfs"', global: "", granted: true },
	{ args: [], project: "'provider' = 'chatgpt'\nsandbox = \"agentfs\"", global: "", granted: true },
	{ args: [], project: "", global: '"provider" = "chatgpt"\nsandbox = "agentfs"', granted: true },
	{ args: [], project: '"sandbox" = "agentfs"', global: "", granted: false },
	{ args: [], project: '"\\u0073andbox" = "agentfs"', global: "", granted: false },
	{ args: ["--sandbox", "agentfs"], project: '"network" = "full"', global: "", granted: false },
	{ args: ["--sandbox", "agentfs"], project: '"stray"\nnetwork = "full"', global: "", granted: false },
	{ args: ["--sandbox", "agentfs"], project: '"a".b = "c"\nnetwork = "full"', global: "", granted: false },
	// Multiline strings can hide a header or a key line from the line-oriented reader.
	{ args: ["--sandbox", "agentfs"], project: 'system_prompt = """\n[notes]\n"""\nnetwork = "none"', global: "", granted: false },
	{ args: ["--sandbox", "agentfs"], project: "system_prompt = '''\n[notes]\n'''\nnetwork = \"none\"", global: "", granted: false },
	{ args: ["--sandbox", "agentfs"], project: 'sandbox = "agentfs" # """\nnetwork = "full"', global: "", granted: false },
	{ args: [], project: 'sandbox = "agentfs"\n[profiles.x]\nnote = """inert"""', global: "", granted: false },
	{ args: ["--sandbox", "agentfs"], project: '"note" = """\nnetwork = "none"\n"""', global: "", granted: false },
	{ args: ["--sandbox", "agentfs"], project: '"note" = "unclosed\nnetwork = "full"', global: "", granted: false },
	// A multiline array continuation opening on `[` is array content, not a table header.
	{ args: ["--sandbox", "agentfs"], project: 'commands = [\n  []\n]\nnetwork = "none"', global: "", granted: false },
	{ args: ["--sandbox", "agentfs"], project: 'commands = [\n  [1],\n]\nnetwork = "provider-only"', global: "", granted: true },
	{ args: [], project: 'commands = [\n  "sandbox = \\"builtin\\"",\n]\nsandbox = "agentfs"', global: "", granted: true },
	{ args: ["--sandbox", "agentfs"], project: 'extra = { a = [\n  []\n] }\nnetwork = "none"', global: "", granted: false },
	{ args: ["--sandbox", "agentfs"], project: 'profiles.p.network = "none"', global: "", granted: false },
	{ args: ["--sandbox", "agentfs"], project: 'commands = [\n]]\nnetwork = "full"', global: "", granted: false },
	{ args: ["--sandbox", "agentfs"], project: 'commands = [\n] stray\nnetwork = "full"', global: "", granted: false },
])("resolves only effective AgentFS evidence grants: %j", ({ args, project, global, emptyProject, symlinked, granted }) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "swival-evidence-env-"));
	try {
		const cwd = path.join(root, "cwd"), base = path.join(cwd, "base"), xdg = path.join(root, "xdg");
		fs.mkdirSync(base, { recursive: true });
		fs.mkdirSync(path.join(xdg, "swival"), { recursive: true });
		for (const [file, content] of [[path.join(base, "swival.toml"), project], [path.join(xdg, "swival/config.toml"), global]]) {
			if (!content && !emptyProject) continue;
			fs.writeFileSync(symlinked ? `${file}.target` : file, content);
			if (symlinked) fs.symlinkSync(`${file}.target`, file);
		}
		const env = { XDG_CONFIG_HOME: xdg, PYTHONPATH: ["/other", ANTHROPIC_OAUTH_SHIM_DIR].join(path.delimiter) };
		const evidence = path.join(root, "evidence");
		const result = resolveSwivalEvidenceEnv(["--base-dir", "base", ...args], evidence, env, root, cwd);
		expect(result).toEqual(granted ? { ...env, PI_SWIVAL_EVIDENCE_DIR: evidence, PYTHONDONTWRITEBYTECODE: "1",
			PYTHONPATH: [ANTHROPIC_OAUTH_SHIM_DIR, "/other"].join(path.delimiter) } : undefined);
		expect(env).not.toHaveProperty("PI_SWIVAL_EVIDENCE_DIR");
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});
