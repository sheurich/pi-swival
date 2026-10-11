// Repeatable Pi1.0.4 registered handler gate. Run only in the fixed disposable guest.
import fs from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createJiti } from "/srv/native-verification/pi/node_modules/jiti/lib/jiti.mjs";
import { createEventBus } from "/srv/native-verification/pi/node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js";
import {
  createExtensionRuntime, loadExtensionFromFactory,
} from "/srv/native-verification/pi/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

const root = "/srv/native-verification";
const source = fs.realpathSync(process.env.PI_SWIVAL_TEST_SOURCE);
const mode = process.argv[2];
const began = Date.now();
if (!["normal", "temp", "cancel", "parent-loss", "startup", "payload-failure", "wrapper-kill", "propagation"].includes(mode)) {
  throw new Error("Unsupported fixed offline scenario");
}
const fixture = mode === "temp" ? "/tmp/native-bwrap-fixture/source" : `${root}/bwrap-fixture/source`;
const python = mode === "temp" ? "/tmp/native-bwrap-runtime/bin/python" : `${root}/offline-runtime/bin/python`;
if (mode === "startup") process.env.PATH = `${root}/without-bwrap`;
if (mode === "wrapper-kill") {
  const spawn = childProcess.spawn;
  childProcess.spawn = (...args) => {
    const child = spawn(...args);
    if (String(args[1]?.[0]).endsWith("native-audit-runner.cjs")) {
      child.on("message", (message) => {
        if (message.type !== "native-started") return;
        const timer = setInterval(() => {
          const runs = `${root}/handler-${mode}`;
          if (fs.readdirSync(runs).some((run) =>
            fs.existsSync(path.join(runs, run, "evidence", "boundary-canary.json")) &&
            fs.statSync(path.join(runs, run, "evidence", "boundary-canary.json")).mtimeMs >= began)) {
            clearInterval(timer); child.kill("SIGKILL");
          }
        }, 20);
      });
    }
    return child;
  };
  syncBuiltinESMExports();
}
const jiti = createJiti(import.meta.url, { moduleCache: false });
const factory = await jiti.import(`${source}/extensions/index.ts`, { default: true });
const extension = await loadExtensionFromFactory(
  (api) => factory(api, { artifactRoot: `${root}/handler-${mode}`, nativePython: python,
    nativeMaxTimeoutMs: 10000, trustProjectAgents: false }),
  fixture, createEventBus(), createExtensionRuntime(), `${source}/extensions/index.ts`,
);
const tool = extension.tools.get("swival-subagent")?.definition;
if (!tool) throw new Error("Actual native handler was not registered");
const controller = new AbortController();
const timer = mode === "cancel" ? setInterval(() => {
  const runs = `${root}/handler-${mode}`;
  if (fs.existsSync(runs) && fs.readdirSync(runs).some((run) =>
    fs.existsSync(path.join(runs, run, "evidence", "boundary-canary.json")) &&
            fs.statSync(path.join(runs, run, "evidence", "boundary-canary.json")).mtimeMs >= began)) controller.abort();
}, 20) : undefined;
const keepAlive = mode === "parent-loss" ? setTimeout(() => process.exit(2), 12000) : undefined;
try {
  const result = await tool.execute(`offline-bwrap-${mode}`, {
    audit: { paths: ["src"], all: true, workers: 1, patchMaxTurns: 3 },
    async: mode === "parent-loss", modelOverride: "offline-model", providerOverride: "lmstudio",
    timeoutMs: 8000,
  }, controller.signal, undefined, { cwd: fixture });
  if (mode === "parent-loss") {
    if (result.isError) throw new Error(result.content[0].text);
    console.log(JSON.stringify({ mode, started: true }));
  } else {
    fs.writeFileSync(`${root}/result-${mode}.json`, JSON.stringify(result));
    console.log(JSON.stringify({ mode, isError: result.isError ?? false,
      artifactDir: result.details?.results?.[0]?.artifactDir,
      status: result.details?.results?.[0]?.nativeAudit?.status,
      error: result.content?.[0]?.text }));
    if ((["normal", "temp", "propagation"].includes(mode)) === !!result.isError) process.exitCode = 1;
  }
} finally {
  clearInterval(timer);
  if (mode !== "parent-loss") clearTimeout(keepAlive);
}
