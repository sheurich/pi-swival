import { describe, expect, it, vi } from "vitest";
import { assertNativeCredentialLifetime, bridgeNativeCredentials, buildNativeAuditArgs, nativeEnvironment, nativePreflightEnvironment, parseNativePreflight, parseNativeRoute, type NativeRoute } from "../extensions/native-audit.js";

const route = (provider: string): NativeRoute => ({
	version: 2, runtime: { swival: "1.9.3", litellm: "1.106.6" }, provider, model: "concrete-model",
	endpoint: provider === "bedrock" ? "us-east-2" : null, profile: null, reasoningEffort: "high", options: {},
	selection: { profileSource: null, explicitFields: [] }, reportIdentity: { provider, model: "concrete-model" },
	...(provider === "geap" ? { project: "synthetic-project", location: "global" } : {}),
});
const now = Date.UTC(2030, 0, 1);
const session = { AccessKeyId: "synthetic-access", SecretAccessKey: "synthetic-secret", SessionToken: "synthetic-session", Expiration: new Date(now + 3600_000).toISOString() };

describe("native cloud credential boundary (offline)", () => {
	it.each(["bedrock", "geap"])("round-trips %s metadata without credential fields", (provider) => {
		const r = route(provider);
		expect(parseNativeRoute(r)).toEqual(r);
		expect(parseNativePreflight(JSON.stringify(r), true).route).toEqual(r);
		const args = buildNativeAuditArgs("/snapshot", r, { all: true, paths: [], workers: 1, patchMaxTurns: 6 });
		if (provider === "geap") expect(args).toEqual(expect.arrayContaining(["--gcp-project", "synthetic-project", "--location", "global"]));
		expect(args).not.toContain("--aws-profile"); expect(args).not.toContain("--add-dir");
	});
	it("rejects cross-route metadata and custom Bedrock endpoints", () => {
		for (const r of [{ ...route("anthropic"), project: "other", location: "global" }, { ...route("bedrock"), endpoint: "https://elsewhere.invalid" }, { ...route("geap"), project: undefined }, { ...route("geap"), endpoint: "https://elsewhere.invalid" }]) expect(() => parseNativeRoute(r)).toThrow(/preflight/);
	});
	it("keeps profile selection as non-route metadata for drift comparison", () => {
		const pre = parseNativePreflight(JSON.stringify({ ...route("bedrock"), awsProfile: "selected" }), true);
		expect(pre.awsProfile).toBe("selected"); expect(pre.route).not.toHaveProperty("awsProfile");
	});
	it("configured AWS identity outranks complete ambient keys", async () => {
		const env = { AWS_ACCESS_KEY_ID: "ambient", AWS_SECRET_ACCESS_KEY: "ambient", AWS_SESSION_TOKEN: "ambient" };
		const exec = vi.fn(async () => JSON.stringify(session));
		const deadline = await bridgeNativeCredentials(route("bedrock"), "selected", env, 900_000, exec, () => now);
		expect(exec).toHaveBeenCalledExactlyOnceWith("aws", ["configure", "export-credentials", "--profile", "selected", "--format", "process"]);
		expect(env.AWS_ACCESS_KEY_ID).toBe(session.AccessKeyId);
		expect(deadline.bedrockExpirationMs).toBe(now + 3600_000);
		expect(() => assertNativeCredentialLifetime(deadline, 900_000, now + 2800_000)).toThrow(/no fallback/);
	});
	it("exports default AWS session only when no complete env session is selected", async () => {
		const exec = vi.fn(async () => JSON.stringify(session));
		await bridgeNativeCredentials(route("bedrock"), undefined, {}, 900_000, exec, () => now);
		expect(exec).toHaveBeenCalledWith("aws", ["configure", "export-credentials", "--format", "process"]);
		exec.mockClear();
		await bridgeNativeCredentials(route("bedrock"), undefined, { AWS_ACCESS_KEY_ID: "access", AWS_SECRET_ACCESS_KEY: "secret", AWS_SESSION_TOKEN: "session" }, 900_000, exec, () => now);
		expect(exec).not.toHaveBeenCalled();
	});
	it.each([{}, { ...session, SessionToken: undefined }, { ...session, Expiration: new Date(now + 1000).toISOString() }, { ...session, AccessKeyId: "bad\nvalue" }])("rejects invalid or insufficient-lifetime AWS session without disclosure", async (credentials) => {
		await expect(bridgeNativeCredentials(route("bedrock"), "selected", {}, 900_000, async () => JSON.stringify(credentials), () => now)).rejects.toThrow(/credential is unavailable; no fallback/);
	});
	it("uses ADC only, never falls back to a gcloud account", async () => {
		const exec = vi.fn(async () => { throw new Error("private diagnostic"); });
		await expect(bridgeNativeCredentials(route("geap"), undefined, {}, 900_000, exec, () => now)).rejects.toThrow(/credential is unavailable/);
		expect(exec).toHaveBeenCalledExactlyOnceWith("gcloud", ["auth", "application-default", "print-access-token"]);
	});
	it("bounds Vertex token use without claiming cached-token lifetime", async () => {
		const env: NodeJS.ProcessEnv = {};
		const d = await bridgeNativeCredentials(route("geap"), undefined, env, 900_000, async () => "synthetic-token\n", () => now);
		expect(env.GOOGLE_OAUTH_ACCESS_TOKEN).toBe("synthetic-token");
		expect(d.vertexNotAfterSec).toBe(now / 1000 + 3300);
		expect(() => assertNativeCredentialLifetime(d, 1000, now + 3300_000)).toThrow(/no fallback/);
	});
	it.each(["bedrock", "geap", "anthropic", "openrouter"])("forwards only %s credentials and disables SDK fallbacks", (provider) => {
		const input = { HOME: "/synthetic/home", XDG_CONFIG_HOME: "/synthetic/config", AWS_ACCESS_KEY_ID: "secret-access", AWS_SECRET_ACCESS_KEY: "secret-key", AWS_SESSION_TOKEN: "secret-session", GOOGLE_OAUTH_ACCESS_TOKEN: "secret-google", ANTHROPIC_API_KEY: "secret-anthropic", OPENROUTER_API_KEY: "secret-openrouter", AWS_PROFILE: "host-profile", VERTEXAI_CREDENTIALS: "host-json", GOOGLE_APPLICATION_CREDENTIALS: "/host/adc" };
		const env = nativeEnvironment(input, "/trusted/bin", provider, "/trusted/shim");
		expect(env.AWS_PROFILE).toBeUndefined(); expect(env.VERTEXAI_CREDENTIALS).toBeUndefined();
		if (provider === "bedrock") expect(env).toMatchObject({ AWS_ACCESS_KEY_ID: "secret-access", AWS_EC2_METADATA_DISABLED: "true", AWS_CONFIG_FILE: "/dev/null", AWS_SHARED_CREDENTIALS_FILE: "/dev/null", PYTHONPATH: "/trusted/shim", PI_SWIVAL_SHIM_REQUIRED: "1" });
		else expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
		if (provider === "geap") expect(env).toMatchObject({ GOOGLE_OAUTH_ACCESS_TOKEN: "secret-google", GOOGLE_APPLICATION_CREDENTIALS: "/dev/null", PI_SWIVAL_SHIM_REQUIRED: "1", PYTHONDONTWRITEBYTECODE: "1" });
		else expect(env.GOOGLE_OAUTH_ACCESS_TOKEN).toBeUndefined();
		const markers = nativePreflightEnvironment(input, "/trusted/bin");
		expect(markers.AWS_PROFILE).toBe("present"); expect(markers.GOOGLE_APPLICATION_CREDENTIALS).toBe("present");
		expect(JSON.stringify(markers)).not.toContain("secret-");
	});
});
