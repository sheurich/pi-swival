import { expect, it } from "vitest";
import { credentialPreflight, resolveCredentialPreflightRoute } from "../extensions/preflight.js";

it("does not disclose the GOOGLE_APPLICATION_CREDENTIALS path when the file is unreadable", async () => {
	const credentialPath = "/private/credentials/adc-do-not-leak-7f3c9e-secret.json";
	const result = await credentialPreflight({
		provider: "vertexai",
		env: { GOOGLE_APPLICATION_CREDENTIALS: credentialPath },
		fileSystem: { readFile: async () => { throw new Error("permission denied"); } },
	});

	expect(result.status).toBe("failure");
	expect(result.message).toContain("GOOGLE_APPLICATION_CREDENTIALS");
	expect(result.message).not.toContain(credentialPath);
});

it("does not disclose profile-list output details when profile routing cannot be resolved safely", async () => {
	const route = await resolveCredentialPreflightRoute({
		agent: {
			name: "swival",
			description: "test agent",
			systemPrompt: "",
			source: "bundled",
			filePath: "/agents/swival.md",
		},
		overrides: { profile: "private-profile" },
		cwd: "/repo/private-project",
		execFile: (_file, _args, _options, callback) => {
			callback(new Error("sensitive failure"), [
				"→ private-profile   vertexai   / gemini-2.5-pro  base=https://internal.example.test, reasoning=high",
			].join("\n"), "/Users/example/.config/swival/config.toml");
		},
	});

	expect(route.routingStatus).toBe("indeterminate");
	expect(route.message ?? "").not.toContain("gemini-2.5-pro");
	expect(route.message ?? "").not.toContain("https://internal.example.test");
	expect(route.message ?? "").not.toContain("config.toml");
	expect(route.message ?? "").not.toContain("private-profile");
});
