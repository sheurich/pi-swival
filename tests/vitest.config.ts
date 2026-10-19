import { configDefaults, defineConfig } from "vitest/config";

// Tests import from "../index.js" and "../agents.js", which in turn import
// pi packages. We rely on `npm install` here (vitest) plus symlinks set up
// by `./setup.sh` to wire @earendil-works/pi-* and typebox into
// `./node_modules/`. No aliases are needed once those symlinks exist.
export default defineConfig({
	test: {
		include: process.env.NATIVE_AGENTFS_INTEGRATION === "1" ? ["nativeAgentfs.test.ts"] : ["**/*.test.ts"],
		exclude: [...configDefaults.exclude, "**/.scratch/**",
			...(process.env.NATIVE_AGENTFS_INTEGRATION === "1" ? [] : ["**/nativeAgentfs.test.ts"])],
		environment: "node",
		watch: false,
		testTimeout: 5000,
	},
});
