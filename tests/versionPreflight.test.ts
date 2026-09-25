import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	compareSemver,
	evaluateSwivalVersion,
	parseSemver,
	preflightSwivalVersion,
	RECOMMENDED_SWIVAL_VERSION,
	MIN_COMPATIBLE_SWIVAL_VERSION,
	resetSwivalVersionCache,
} from "../extensions/index.js";

describe("version preflight semantics", () => {
	beforeEach(() => {
		resetSwivalVersionCache();
	});

	afterEach(() => {
		resetSwivalVersionCache();
	});

	it("parses valid semver strings and noisy CLI output", () => {
		expect(parseSemver("1.0.44")).toEqual([1, 0, 44]);
		expect(parseSemver("v1.0.40")).toEqual([1, 0, 40]);
		expect(parseSemver("1.0.44-alpha.1")).toEqual([1, 0, 44]);
		expect(parseSemver("swival 1.0.44")).toEqual([1, 0, 44]);
		expect(parseSemver("swival v1.0.40")).toEqual([1, 0, 40]);
		expect(parseSemver("warning: deprecation\n0.9.0")).toEqual([0, 9, 0]);
		expect(parseSemver("not-a-version")).toBeNull();
	});

	it("evaluates noisy CLI output correctly", () => {
		expect(evaluateSwivalVersion("swival 0.9.0").isIncompatible).toBe(true);
		expect(evaluateSwivalVersion("warn: check\nswival 1.0.44").isOutdated).toBe(true);
		expect(evaluateSwivalVersion("warn: check\nswival 1.0.44").isIncompatible).toBe(false);
		expect(evaluateSwivalVersion("swival 1.0.45").isOutdated).toBe(false);
	});

	it("compares semver correctly", () => {
		expect(compareSemver("1.0.44", "1.0.40")).toBeGreaterThan(0);
		expect(compareSemver("1.0.40", "1.0.44")).toBeLessThan(0);
		expect(compareSemver("1.0.44", "1.0.44")).toBe(0);
		expect(compareSemver("2.0.0", "1.99.99")).toBeGreaterThan(0);
	});

	it("treats version 1.0.45 as up to date", () => {
		const check = evaluateSwivalVersion("1.0.45");
		expect(check.isOutdated).toBe(false);
		expect(check.isIncompatible).toBe(false);
		expect(check.advisoryMessage).toBeUndefined();
		expect(check.errorMessage).toBeUndefined();
	});

	it("treats version 1.0.44 as outdated but advisory (not incompatible)", () => {
		const check = evaluateSwivalVersion("1.0.44");
		expect(check.isOutdated).toBe(true);
		expect(check.isIncompatible).toBe(false);
		expect(check.advisoryMessage).toContain("uv tool upgrade swival");
		expect(check.advisoryMessage).toContain(RECOMMENDED_SWIVAL_VERSION);
		expect(check.errorMessage).toBeUndefined();
	});

	it("treats version below minCompatibleVersion (1.0.40) as incompatible", () => {
		const check = evaluateSwivalVersion("1.0.40");
		expect(check.isOutdated).toBe(true);
		expect(check.isIncompatible).toBe(true);
		expect(check.errorMessage).toContain(MIN_COMPATIBLE_SWIVAL_VERSION);
		expect(check.errorMessage).toContain("uv tool upgrade swival");
	});

	it("handles missing/undefined version gracefully", () => {
		const check = evaluateSwivalVersion(undefined);
		expect(check.isOutdated).toBe(false);
		expect(check.isIncompatible).toBe(false);
	});

	it("caches version probe and re-evaluates when cache is cleared", async () => {
		let callCount = 0;
		const mockExec = async () => {
			callCount++;
			return "1.0.45";
		};

		const check1 = await preflightSwivalVersion(mockExec);
		const check2 = await preflightSwivalVersion(mockExec);
		expect(callCount).toBe(1);
		expect(check1.isOutdated).toBe(false);
		expect(check2.isOutdated).toBe(false);

		resetSwivalVersionCache();
		await preflightSwivalVersion(mockExec);
		expect(callCount).toBe(2);
	});
});
