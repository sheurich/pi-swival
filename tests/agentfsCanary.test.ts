import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { nativeTestPython as python } from "./nativePython.js";

const canary = path.resolve(import.meta.dirname, "../scripts/agentfs-integration-test.sh");
const harness = String.raw`
import os, pathlib, signal, subprocess, sys, tempfile
text=pathlib.Path(sys.argv[1]).read_text(encoding='utf-8')
marker='if ! python3 - "$base" "$native_session" <<\'PY\'\n'
source=text.split(marker,1)[1].split('\nPY\nthen',1)[0]
mode=sys.argv[2]; expected=int(sys.argv[3]); calls=[]
class FakePopen:
    def __init__(self, argv, **_kwargs): self.argv=argv; self.pid=424242; self.returncode=None
    def __enter__(self): return self
    def __exit__(self, *_args): return False
    def wait(self, timeout=None):
        assert timeout == 30
        if mode == 'normal':
            snapshot,evidence=self.argv[-3:-1]
            pathlib.Path(snapshot,'code.py').write_text('snapshot-changed')
            pathlib.Path(evidence,'result.txt').write_text('preserved')
            self.returncode=0
            return 0
        if mode == 'interrupted-reaped': self.returncode=0
        if mode.startswith('interrupted'): raise KeyboardInterrupt
        raise subprocess.TimeoutExpired(self.argv, timeout)
    def poll(self): raise AssertionError('poll must not authorize a numeric process group')
subprocess.Popen=FakePopen
os.killpg=lambda pid, sig: calls.append((pid,sig))
root=tempfile.mkdtemp(); sys.argv=['canary-fragment',root,'mock-session']
try:
    exec(compile(source,'agentfs-canary-fragment','exec'),globals())
except (subprocess.TimeoutExpired,KeyboardInterrupt):
    pass
assert calls == [(424242,signal.SIGKILL)] * expected, calls
`;

describe("AgentFS canary process-group ownership", () => {
	it.each([
		["normal", 0], ["timeout", 1], ["interrupted-live", 1], ["interrupted-reaped", 0],
	])("signals only a live unreaped owned group after %s", (mode, expected) => {
		const result = spawnSync(python, ["-I", "-B", "-c", harness, canary, mode, String(expected)],
			{ timeout: 5000, maxBuffer: 32 * 1024, encoding: "utf8" });
		expect(result.status, result.stderr || result.stdout).toBe(0);
	});
});
