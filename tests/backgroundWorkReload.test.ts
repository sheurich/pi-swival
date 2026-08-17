import { expect, test } from "vitest";
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function textOf(result: any): string {
  return (result?.content ?? []).map((part: any) => part?.text ?? "").join("\n");
}

function findRunArtifactDirectory(artifactRoot: string): string | undefined {
  if (!fs.existsSync(artifactRoot)) return undefined;
  return fs.readdirSync(artifactRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(artifactRoot, entry.name))
    .find((directory) => fs.existsSync(path.join(directory, "run-meta.json")));
}

async function pollUntil(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

test("post-reload subagent_wait sees active pi-swival work", async () => {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-background-reload-"));
  const agentDir = path.join(root, "agent");
  const artifactRoot = path.join(root, "artifacts");
  const bin = path.join(root, "bin");
  const release = path.join(root, "release");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(artifactRoot, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });

  const old = {
    artifactRoot: process.env.PI_SWIVAL_ARTIFACT_ROOT,
    noPreflight: process.env.PI_SWIVAL_NO_PREFLIGHT,
    path: process.env.PATH,
    release: process.env.PI_SWIVAL_TEST_RELEASE_FILE,
  };
  const swival = path.join(bin, "swival");
  fs.writeFileSync(swival, `#!/bin/sh
report=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--report" ]; then report="$2"; shift 2; else shift; fi
done
while [ ! -f "$PI_SWIVAL_TEST_RELEASE_FILE" ]; do sleep 0.02; done
mkdir -p "$(dirname "$report")"
printf '%s\n' '{"version":1,"result":{"outcome":"success","answer":"ok"},"stats":{"review_rounds":0}}' > "$report"
printf 'ok\n'
`);
  fs.chmodSync(swival, 0o755);
  process.env.PI_SWIVAL_ARTIFACT_ROOT = artifactRoot;
  process.env.PI_SWIVAL_NO_PREFLIGHT = "1";
  process.env.PI_SWIVAL_TEST_RELEASE_FILE = release;
  process.env.PATH = `${bin}${path.delimiter}${old.path ?? ""}`;

  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let runArtifactDirectory: string | undefined;
  try {
    const settingsManager = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({
      cwd: repoRoot,
      agentDir,
      settingsManager,
      eventBus: createEventBus(),
      additionalExtensionPaths: [
        path.join(import.meta.dirname, "node_modules", "pi-subagents", "index.ts"),
        path.join(repoRoot, "extensions", "index.ts"),
      ],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();

    ({ session } = await createAgentSession({
      cwd: repoRoot,
      agentDir,
      resourceLoader: loader,
      settingsManager,
      sessionManager: SessionManager.create(repoRoot, path.join(root, "sessions")),
      builtinTools: [],
    }));
    await session.bindExtensions({ mode: "json", shutdownHandler: () => {} });

    expect(loader.getExtensions().errors).toEqual([]);
    expect(session.agent.state.tools.map((tool: any) => tool.name)).toEqual(
      expect.arrayContaining(["swival-subagent", "subagent_wait"]),
    );

    await session.reload();

    const subagent = session.agent.state.tools.find((tool: any) => tool.name === "swival-subagent");
    const wait = session.agent.state.tools.find((tool: any) => tool.name === "subagent_wait");
    expect(subagent).toBeDefined();
    expect(wait).toBeDefined();

    const signal = new AbortController().signal;
    const started = await subagent!.execute(
      "start-background-work",
      { agent: "self-review-worker", task: "hold", async: true, agentScope: "user" },
      signal,
      () => {},
    );
    expect(textOf(started)).toContain("Async swival run started.");
    const runId = textOf(started).match(/runId:\s*(\S+)/)?.[1];
    expect(runId).toBeDefined();
    runArtifactDirectory = path.join(artifactRoot, runId!);

    setTimeout(() => fs.writeFileSync(release, "go"), 1000);
    const waited = await wait!.execute(
      "wait-background-work",
      { all: true, timeoutMs: 4000 },
      signal,
      () => {},
    );
    expect(textOf(waited)).toMatch(/provider item\(s\)/);
  } finally {
    if (!fs.existsSync(release)) fs.writeFileSync(release, "go");
    await pollUntil(() => {
      const directory = runArtifactDirectory ?? findRunArtifactDirectory(artifactRoot);
      return Boolean(directory && fs.existsSync(path.join(directory, "completed.json")));
    });
    session?.dispose();
    if (old.artifactRoot === undefined) delete process.env.PI_SWIVAL_ARTIFACT_ROOT;
    else process.env.PI_SWIVAL_ARTIFACT_ROOT = old.artifactRoot;
    if (old.noPreflight === undefined) delete process.env.PI_SWIVAL_NO_PREFLIGHT;
    else process.env.PI_SWIVAL_NO_PREFLIGHT = old.noPreflight;
    if (old.release === undefined) delete process.env.PI_SWIVAL_TEST_RELEASE_FILE;
    else process.env.PI_SWIVAL_TEST_RELEASE_FILE = old.release;
    if (old.path === undefined) delete process.env.PATH;
    else process.env.PATH = old.path;
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 10000);
