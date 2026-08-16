import { expect, it } from "vitest";
import { credentialPreflight } from "../extensions/preflight.js";

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
