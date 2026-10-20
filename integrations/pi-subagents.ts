import {
	ASYNC_OBSERVATION_CHANNEL,
	MAX_OBSERVATION_ROWS,
	isAsyncOwnerId,
	isObservationText,
	type AsyncObservationAdapter,
	type AsyncRunObservation,
} from "../extensions/async-observation.js";
import type { ExternalRun, ExternalRunUpdate } from "pi-subagents/external-runs";
import type { BackgroundWorkItem } from "pi-subagents/background-work";

/** Inject only these public functions. Loading pi-subagents remains the caller's choice. */
export type PiSubagentsObservationApi = Pick<typeof import("pi-subagents/external-runs"),
	"registerExternalRun" | "updateExternalRun" | "unregisterExternalRun">
	& Pick<typeof import("pi-subagents/background-work"), "registerBackgroundWorkProvider">;

// Lifecycle ownership only; run state remains in Swival's map and artifacts.
const registrations = new WeakMap<PiSubagentsObservationApi["registerBackgroundWorkProvider"], () => void>();
const MAX_FLEET_ROWS = 20;

function validRow(row: AsyncRunObservation, owner: string): boolean {
	return row.ownerSessionId === owner && isObservationText(row.runId, 160)
		&& Number.isSafeInteger(row.startedAt) && row.startedAt >= 0
		&& row.startedAt <= 8_640_000_000_000_000
		&& (row.endedAt === undefined || (Number.isSafeInteger(row.endedAt)
			&& row.endedAt >= row.startedAt && row.endedAt <= 8_640_000_000_000_000));
}

/** Display and wait activity only: this adapter has no executor, result reader, or stop callback. */
export function createPiSubagentsAdapter(api: PiSubagentsObservationApi): AsyncObservationAdapter {
	return ({ owner, onDiagnostic }) => {
		registrations.get(api.registerBackgroundWorkProvider)?.();
		let active = true;
		let providerDispose: (() => void) | undefined;
		let waitItems: BackgroundWorkItem[] = [];
		const displayed = new Map<string, ExternalRun>();
		const diagnostics = new Set<string>();
		const diagnostic = (message: string) => {
			if (diagnostics.has(message)) return;
			diagnostics.add(message);
			try { onDiagnostic(message); } catch { /* Observation only. */ }
		};
		const unavailable = () => diagnostic("Swival observation adapter unavailable.");
		const current = () => active && registrations.get(api.registerBackgroundWorkProvider) === dispose;
		function dispose() {
			if (!active) return;
			active = false;
			waitItems = [];
			if (registrations.get(api.registerBackgroundWorkProvider) === dispose) {
				registrations.delete(api.registerBackgroundWorkProvider);
			}
			const releaseProvider = providerDispose;
			providerDispose = undefined;
			try { releaseProvider?.(); } catch { unavailable(); }
			const owned = [...displayed.values()];
			displayed.clear();
			for (const run of owned) {
				try { api.unregisterExternalRun(run.sessionId, run.id); } catch { unavailable(); }
			}
		}
		// This is the only translation from Swival UUID ownership to consumer session identity.
		const sessionId = owner.ownerSessionFile ?? owner.ownerSessionId;
		registrations.set(api.registerBackgroundWorkProvider, dispose);
		try {
			if (!isAsyncOwnerId(owner.ownerSessionId) || !isObservationText(sessionId, 4096)) {
				throw new Error("Invalid observation owner");
			}
			providerDispose = api.registerBackgroundWorkProvider({
				name: "pi-swival",
				wakeChannels: [ASYNC_OBSERVATION_CHANNEL],
				listActiveWork(context) {
					if (!current() || (context && context.sessionId !== sessionId)) return [];
					return waitItems.map((item) => ({ ...item }));
				},
			});
		} catch { unavailable(); dispose(); }
		return {
			update(rows) {
				if (!current()) return;
				try {
					const known = new Map<string, AsyncRunObservation>();
					for (const row of rows.slice(0, MAX_OBSERVATION_ROWS)) {
						if (!validRow(row, owner.ownerSessionId) || known.has(row.runId)) continue;
						if (row.state === "unknown") {
							diagnostic("Swival recovered activity is unknown; use explicit status or resume.");
							continue;
						}
						if (row.state === "running" || row.state === "completed" || row.state === "failed") {
							known.set(row.runId, row);
						}
					}
					// Deliver a displayed handle's terminal transition before live-first Fleet
					// selection can remove it. This does not enlarge either bounded projection.
					for (const [id, previous] of displayed) {
						const row = known.get(id);
						if (previous.state !== "running" || !row
							|| (row.state !== "completed" && row.state !== "failed")) continue;
						const patch: ExternalRunUpdate = { state: row.state, endedAt: row.endedAt };
						api.updateExternalRun(sessionId, id, patch);
						displayed.set(id, { ...previous, ...patch });
					}
					const sorted = [...known.values()].sort((left, right) =>
						Number(right.state === "running") - Number(left.state === "running")
						|| right.startedAt - left.startedAt || left.runId.localeCompare(right.runId));
					waitItems = sorted.filter((row) => row.state === "running")
						.map((row) => ({ id: row.runId, sessionId }));
					const fleet = sorted.slice(0, MAX_FLEET_ROWS);
					const wanted = new Set(fleet.map((row) => row.runId));
					for (const id of displayed.keys()) {
						if (wanted.has(id)) continue;
						api.unregisterExternalRun(sessionId, id);
						displayed.delete(id);
					}
					for (const row of fleet) {
						const run: ExternalRun = {
							id: row.runId, sessionId, source: "swival", label: "Swival async run",
							state: row.state as ExternalRun["state"], startedAt: row.startedAt,
							...(row.endedAt === undefined ? {} : { endedAt: row.endedAt }),
						};
						const previous = displayed.get(run.id);
						if (!previous) {
							api.registerExternalRun(run);
							displayed.set(run.id, run);
						} else if (previous.state !== run.state || previous.endedAt !== run.endedAt) {
							const patch: ExternalRunUpdate = { state: run.state, endedAt: run.endedAt };
							api.updateExternalRun(sessionId, run.id, patch);
							displayed.set(run.id, run);
						}
					}
				} catch { unavailable(); dispose(); }
			},
			dispose,
		};
	};
}
