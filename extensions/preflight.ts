import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { execFile as nodeExecFile } from "node:child_process";

export type PreflightStatus = "pass" | "failure" | "indeterminate";
export type PreflightProvider = "bedrock" | "chatgpt" | "vertexai" | "geap" | "generic" | "lmstudio" | "llamacpp" | "unknown";

export interface PreflightResult {
	status: PreflightStatus;
	provider: string;
	message?: string;
}

export interface CredentialPreflightInput {
	provider?: string;
	baseUrl?: string;
	env?: Readonly<Record<string, string | undefined>>;
	homeDir?: string;
	nowMs?: number;
	timeoutMs?: number;
	fileSystem?: CredentialFileSystem;
	execFile?: ExecFile;
	connect?: TcpConnect;
}

export interface CredentialFileSystem {
	readFile(file: string, encoding: "utf8"): Promise<string>;
}

export interface ExecFile {
	(file: string, args: string[], options: { timeout: number; maxBuffer: number }, callback: (error: Error | null, stdout: string, stderr: string) => void): void;
}

export interface TcpConnect {
	(url: string, timeoutMs: number): Promise<boolean>;
}

const realFs: CredentialFileSystem = {
	readFile: (file, encoding) => fs.promises.readFile(file, encoding),
};

const realExecFile: ExecFile = (file, args, options, callback) => {
	nodeExecFile(file, args, options, (error, stdout, stderr) => callback(error, stdout, stderr));
};

function tcpConnect(url: string, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		let parsed: URL;
		try { parsed = new URL(url); } catch { resolve(false); return; }
		const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
		const socket = net.createConnection({ host: parsed.hostname, port });
		let finished = false;
		const done = (ok: boolean) => {
			if (finished) return;
			finished = true;
			socket.destroy();
			resolve(ok);
		};
		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));
		socket.setTimeout(timeoutMs, () => done(false));
	});
}

function providerName(provider: string | undefined): PreflightProvider {
	const value = (provider ?? "").toLowerCase();
	if (value === "bedrock" || value === "chatgpt" || value === "vertexai" || value === "geap" || value === "generic" || value === "lmstudio" || value === "llamacpp") return value;
	return "unknown";
}

function failure(provider: string, missing: string, fix: string): PreflightResult {
	return { status: "failure", provider, message: `${provider} credential preflight failed: ${missing}. Fix: ${fix}` };
}

function indeterminate(provider: string): PreflightResult {
	return { status: "indeterminate", provider, message: `${provider} credential preflight is indeterminate; dispatch was not blocked.` };
}

function execCheck(
	execFile: ExecFile,
	file: string,
	args: string[],
	timeoutMs: number,
): Promise<"pass" | "failure" | "indeterminate"> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (status: "pass" | "failure" | "indeterminate") => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(status);
		};
		const timer = setTimeout(() => finish("indeterminate"), timeoutMs);
		try {
			execFile(file, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 }, (error) => {
				if (!error) finish("pass");
				else if ((error as NodeJS.ErrnoException).code === "ENOENT") finish("indeterminate");
				else finish("failure");
			});
		} catch {
			finish("indeterminate");
		}
	});
}

/**
 * Verify the AWS credential chain. `sts get-caller-identity` returns identity
 * metadata only, never a credential, so its output is safe to inspect.
 */
async function checkBedrock(input: CredentialPreflightInput, provider: string): Promise<PreflightResult> {
	const status = await execCheck(input.execFile ?? realExecFile, "aws", ["sts", "get-caller-identity", "--output", "json"], input.timeoutMs ?? 1500);
	if (status === "pass") return { status: "pass", provider };
	if (status === "indeterminate") return indeterminate(provider);
	return failure(provider, "the AWS credential chain is missing or expired", "`aws sso login` (or configure valid AWS credentials) and retry");
}

async function checkChatgpt(input: CredentialPreflightInput, provider: string): Promise<PreflightResult> {
	const env = input.env ?? process.env;
	const home = input.homeDir ?? os.homedir();
	const dir = env.CHATGPT_TOKEN_DIR ?? path.join(home, ".config", "litellm", "chatgpt");
	let raw: string;
	try { raw = await (input.fileSystem ?? realFs).readFile(path.join(dir, "auth.json"), "utf8"); } catch { return failure(provider, "ChatGPT OAuth auth.json is missing", "run `swival --provider chatgpt` once interactively and complete the device-code sign-in, then retry"); }
	try {
		const auth: unknown = JSON.parse(raw);
		if (!auth || typeof auth !== "object") return failure(provider, "ChatGPT OAuth auth.json is invalid", "run `swival --provider chatgpt` once interactively and complete the device-code sign-in, then retry");
		const record = auth as Record<string, unknown>;
		const access = typeof record.access_token === "string" && record.access_token.length > 0;
		const refresh = typeof record.refresh_token === "string" && record.refresh_token.length > 0;
		if (!access || !refresh) return failure(provider, "ChatGPT OAuth access and refresh tokens are missing", "run `swival --provider chatgpt` once interactively and complete the device-code sign-in, then retry");
		const expiresAt = Number(record.expires_at);
		if (!Number.isFinite(expiresAt)) return indeterminate(provider);
		// litellm stores the JWT `exp` claim, so seconds, but tolerate milliseconds.
		const expiryMs = expiresAt < 10_000_000_000 ? expiresAt * 1000 : expiresAt;
		if (expiryMs <= (input.nowMs ?? Date.now())) return failure(provider, "ChatGPT OAuth access token is expired", "run `swival --provider chatgpt` once interactively to refresh the sign-in, then retry");
		return { status: "pass", provider };
	} catch { return indeterminate(provider); }
}

/**
 * Check for Google application default credentials without ever materialising a
 * token. `gcloud auth application-default print-access-token` would prove
 * validity, but it writes a live credential to stdout, so this inspects the
 * credential artifacts instead and accepts presence as the local signal.
 *
 * A missing GOOGLE_APPLICATION_CREDENTIALS target is a definite
 * misconfiguration. Finding nothing at all is indeterminate rather than a
 * failure, because a GCE or Cloud Run host resolves ADC from the metadata
 * server with no local file.
 */
async function checkAdc(input: CredentialPreflightInput, provider: string): Promise<PreflightResult> {
	const env = input.env ?? process.env;
	const home = input.homeDir ?? os.homedir();
	const fileSystem = input.fileSystem ?? realFs;
	const explicit = env.GOOGLE_APPLICATION_CREDENTIALS;
	if (explicit) {
		try {
			await fileSystem.readFile(explicit, "utf8");
			return { status: "pass", provider };
		} catch {
			return failure(provider, "GOOGLE_APPLICATION_CREDENTIALS points at an unreadable file", "correct the path or run `gcloud auth application-default login` and retry");
		}
	}
	try {
		await fileSystem.readFile(path.join(home, ".config", "gcloud", "application_default_credentials.json"), "utf8");
		return { status: "pass", provider };
	} catch {
		return indeterminate(provider);
	}
}

export async function credentialPreflight(input: CredentialPreflightInput): Promise<PreflightResult> {
	const provider = providerName(input.provider);
	if (provider === "unknown") return { status: "pass", provider: input.provider ?? "unknown" };
	try {
		if (provider === "bedrock") return await checkBedrock(input, provider);
		if (provider === "chatgpt") return await checkChatgpt(input, provider);
		if (provider === "vertexai" || provider === "geap") return await checkAdc(input, provider);
		const baseUrl = input.baseUrl;
		if (!baseUrl) return indeterminate(provider);
		const accepts = await (input.connect ?? tcpConnect)(baseUrl, input.timeoutMs ?? 1500);
		return accepts ? { status: "pass", provider } : failure(provider, "the configured base URL refused a TCP connection", "start the local provider and retry");
	} catch {
		return indeterminate(provider);
	}
}
