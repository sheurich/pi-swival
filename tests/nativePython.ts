import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const nativeTestPython = process.env.NATIVE_TEST_PYTHON ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".venv/bin/python");
if (!fs.existsSync(nativeTestPython)) {
	throw new Error("Native audit tests require pinned Swival 1.0.46. Run ./tests/setup.sh directly before npm test.");
}
