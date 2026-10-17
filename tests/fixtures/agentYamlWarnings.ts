import { vi } from "vitest";

export const yamlWarningFixtures = [
	{ label: "warning-only", suffix: "" },
	{ label: "warning-plus-error", suffix: "\nbroken: [" },
].map(({ label, suffix }) => ({
	label,
	frontmatter: "name: swival\ndescription: rejected override\n" +
		"private: !unrecognized C1_RAW_YAML C1_COMMAND /private/C1_PATH" + suffix,
}));

/** Pass-through capture stays local to sequential tests in isolated Vitest workers. */
export async function captureAgentYamlWarnings<T>(run: () => T | Promise<T>) {
	const emit = vi.spyOn(process, "emitWarning");
	const stderr = vi.spyOn(process.stderr, "write");
	const warningEvents: string[] = [];
	const onWarning = (warning: Error) => warningEvents.push(warning.message);
	process.on("warning", onWarning);
	try {
		const result = await run();
		await new Promise((resolve) => setImmediate(resolve));
		return {
			result,
			emitted: emit.mock.calls.map(([warning]) => String(warning)).join("\n"),
			stderr: stderr.mock.calls.map(([chunk]) => String(chunk)).join(""),
			warningEvents,
		};
	} finally {
		// Node emits warnings on a later tick, including when run() throws.
		await new Promise((resolve) => setImmediate(resolve));
		process.off("warning", onWarning);
		stderr.mockRestore();
		emit.mockRestore();
	}
}
