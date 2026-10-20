import { createHash } from "node:crypto";

/** UUID ownership stays independent of any optional consumer's session identity. */
export interface AsyncOwner {
	readonly ownerSessionId: string;
	readonly ownerSessionFile?: string;
}

export interface AsyncRunObservation extends AsyncOwner {
	readonly runId: string;
	readonly agent: string;
	readonly startedAt: number;
	readonly state: "running" | "unknown" | "completed" | "failed";
	readonly endedAt?: number;
}

export const ASYNC_OBSERVATION_CHANNEL = "pi-swival:async-observation";
export const MAX_OBSERVATION_ROWS = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isAsyncOwnerId(value: unknown): value is string {
	return typeof value === "string" && value.length === 36 && UUID.test(value);
}

export function isObservationText(value: unknown, limit: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= limit
		&& value.trim() === value && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}

export function captureAsyncOwner(manager?: {
	getSessionId(): unknown;
	getSessionFile?(): unknown;
}): AsyncOwner | undefined {
	try {
		const ownerSessionId = manager?.getSessionId();
		if (!isAsyncOwnerId(ownerSessionId)) return undefined;
		let file: unknown;
		try { file = manager?.getSessionFile?.(); } catch { /* UUID ownership is still valid. */ }
		return Object.freeze({ ownerSessionId,
			...(isObservationText(file, 4096) ? { ownerSessionFile: file } : {}),
		});
	} catch { return undefined; }
}

export interface AsyncObservationRegistration {
	update(rows: readonly AsyncRunObservation[]): void;
	dispose(): void;
}

export interface AsyncObservationAdapterContext {
	owner: AsyncOwner;
	onDiagnostic(message: string): void;
}

export type AsyncObservationAdapter =
	(context: AsyncObservationAdapterContext) => AsyncObservationRegistration;

export interface AsyncObservation {
	refresh(): Promise<void>;
	dispose(): void;
}

/** Per-pass accounting shared by metadata, markers, reports and local terminals. */
export interface ObservationReadBudget {
	remaining: number;
	isCurrent(): boolean;
}
export class ObservationReadDeferred extends Error {}
export interface AsyncRecoveryItem {
	/** Opaque evidence identity; never contains artifact bodies. */
	key?: string;
	fingerprint?(): Promise<string | undefined>;
	read(budget: ObservationReadBudget): Promise<AsyncRunObservation | undefined>;
}
export interface AsyncRecoveryDirectory {
	read(): Promise<AsyncRecoveryItem | null>;
	close(): Promise<void>;
}
export interface AsyncRecoverySource {
	local(retainedRunIds: readonly string[]): readonly AsyncRecoveryItem[];
	open(): Promise<AsyncRecoveryDirectory>;
}
const MAX_SCAN_ENTRIES = 256;
const MAX_SCAN_BYTES = 4 * 1024 * 1024;
const newestObservation = (a: AsyncRunObservation, b: AsyncRunObservation) =>
	b.startedAt - a.startedAt || a.runId.localeCompare(b.runId);

/** Disposable sweep state; no filesystem or extension-entry dependency lives here.
 * Progress is promised only for a stable finite directory. Invalidated sweeps retain
 * validated rows until a subsequent complete sweep can replace them.
 */
export function createRecoveryScan(source: AsyncRecoverySource) {
	let epoch = 0;
	let disposed = false;
	let directory: AsyncRecoveryDirectory | undefined;
	let local: readonly AsyncRecoveryItem[] | undefined;
	let localIndex = 0;
	let unfinished: AsyncRecoveryItem | undefined;
	let localRows: AsyncRunObservation[] = [];
	let retained = new Set<string>();
	let reading: Promise<AsyncRecoveryItem | null> | undefined;
	let closing: Promise<void> | undefined;
	let recovered: AsyncRunObservation[] = [];
	let sweep: AsyncRunObservation[] = [];
	const cache = new Map<string, { row: AsyncRunObservation; fingerprint: string }>();
	// Visible rows can outlive cache eviction. Weak provenance retains no extra rows
	// or artifact bodies, but still lets deferred revalidation retire stale evidence.
	let rowEvidence = new WeakMap<AsyncRunObservation, { key: string; fingerprint: string | undefined }>();
	// Sweep summaries only drive polling cadence, never validation/cache equality.
	let evidence = createHash("sha256");
	let priorEvidence: string | undefined;
	let changed = false;
	const read = async (item: AsyncRecoveryItem, budget: ObservationReadBudget) => {
		if (!item.key || !item.fingerprint) return item.read(budget);
		const before = await item.fingerprint();
		if (!budget.isCurrent()) throw new ObservationReadDeferred();
		const cached = cache.get(item.key);
		const forget = (force = false) => {
			const keep = (row: AsyncRunObservation) => {
				const prior = rowEvidence.get(row);
				return !prior || prior.key !== item.key || (!force && prior.fingerprint === before
					&& (before !== undefined || (row.state !== "completed" && row.state !== "failed")));
			};
			if (cached || [...recovered, ...sweep, ...localRows].some((row) => !keep(row))) changed = true;
			cache.delete(item.key!);
			recovered = recovered.filter(keep); sweep = sweep.filter(keep); localRows = localRows.filter(keep);
		};
		const hit = cached && before !== undefined && cached.fingerprint === before;
		if (!hit) forget();
		const row = hit ? cached.row : await item.read(budget);
		if (!budget.isCurrent()) throw new ObservationReadDeferred();
		const after = await item.fingerprint();
		if (!budget.isCurrent()) throw new ObservationReadDeferred();
		if (before !== after) { forget(true); throw new ObservationReadDeferred(); }
		evidence.update(item.key).update("\0").update(before ?? "absent").update("\0");
		// Unavailable probes cannot authorize terminal evidence, even if both are
		// undefined. Omit rather than pin the sweep on an unverifiable artifact;
		// known local running rows remain publishable without a disk fingerprint.
		if (before === undefined && row && (row.state === "completed" || row.state === "failed")) return undefined;
		if (row) rowEvidence.set(row, { key: item.key, fingerprint: before });
		if (row && before !== undefined && (row.state === "completed" || row.state === "failed")) {
			if (!cache.has(item.key) && cache.size === MAX_OBSERVATION_ROWS) {
				const oldest = [...cache].sort((a, b) => newestObservation(a[1].row, b[1].row)).at(-1)!;
				if (newestObservation(row, oldest[1].row) >= 0) return row;
				cache.delete(oldest[0]);
			}
			cache.set(item.key, { row, fingerprint: before });
		}
		return row;
	};
	const close = () => {
		const current = directory; directory = undefined;
		if (!current) return closing;
		const pendingRead = reading;
		closing = (async () => {
			// Node refuses close during a pending Dir.read(). Retire immediately, but
			// release the descriptor only after that operation settles.
			await pendingRead?.catch(() => undefined);
			await current.close().catch(() => undefined);
		})();
		return closing;
	};
	const merge = (...groups: readonly AsyncRunObservation[][]) => {
		const rows = new Map<string, AsyncRunObservation>();
		for (const group of groups) for (const row of group) rows.set(row.runId, row);
		return [...rows.values()].sort(newestObservation).slice(0, MAX_OBSERVATION_ROWS);
	};
	const snapshot = () => {
		const priority = localRows.filter((row) => row.state === "running" || retained.has(row.runId));
		const ids = new Set(priority.map((row) => row.runId));
		const history = merge(recovered, sweep, localRows).filter((row) => !ids.has(row.runId));
		return Object.freeze([...priority, ...history].slice(0, MAX_OBSERVATION_ROWS));
	};
	return {
		invalidate() {
			epoch++; void close(); local = undefined; localIndex = 0; unfinished = undefined;
			recovered = merge(recovered, sweep); sweep = []; localRows = [];
		},
		dispose() {
			disposed = true; epoch++; void close(); local = undefined; unfinished = undefined;
			localRows = []; recovered = []; sweep = []; retained.clear(); cache.clear(); rowEvidence = new WeakMap();
			priorEvidence = undefined; evidence = createHash("sha256");
		},
		async pass(ids: readonly string[]) {
			const current = epoch;
			changed = false;
			const active = () => !disposed && current === epoch;
			const budget: ObservationReadBudget = { remaining: MAX_SCAN_BYTES, isCurrent: active };
			let complete = false;
			try {
				if (!local) { local = source.local(ids); retained = new Set(ids); localIndex = 0; localRows = []; sweep = []; evidence = createHash("sha256"); }
				while (active() && localIndex < local.length) {
					const row = await read(local[localIndex], budget);
					if (!active()) return { rows: snapshot(), complete: false };
					if (row) localRows.push(row);
					localIndex++;
				}
				if (!active()) return { rows: snapshot(), complete: false };
				if (!directory) {
					const opened = await source.open();
					if (!active()) { await opened.close().catch(() => undefined); return { rows: snapshot(), complete: false }; }
					directory = opened;
				}
				// Reading the next entry itself consumes the entry budget; never peek at #257.
				let entries = 0;
				while (active()) {
					if (!unfinished) {
						if (entries === MAX_SCAN_ENTRIES) break;
						reading = directory.read();
						const item = await reading; reading = undefined; entries++;
						if (!active()) { await closing; break; }
						if (!item) { complete = true; break; }
						unfinished = item;
					}
					const row = await read(unfinished, budget);
					if (!active()) break;
					if (row) sweep = merge(sweep, [row]);
					unfinished = undefined;
				}
				if (complete && active()) {
					await close();
					if (!active()) return { rows: snapshot(), complete: false };
					recovered = sweep; sweep = []; local = undefined;
					const summary = evidence.digest("hex");
					changed ||= priorEvidence !== undefined && summary !== priorEvidence;
					priorEvidence = summary;
				}
			} catch (error) {
				if (!active()) { await closing; return { rows: snapshot(), complete: false }; }
				if (!(error instanceof ObservationReadDeferred)) {
					await close();
					if (!active()) return { rows: snapshot(), complete: false };
					local = undefined; unfinished = undefined;
					recovered = merge(recovered, sweep); sweep = [];
					throw error;
				}
				// The unfinished local/disk item is retried, not classified as absent/failed.
			}
			return { rows: snapshot(), complete, changed };
		},
	};
}

/** A disposable projection, not a run registry. Only explicit control actions retrieve results. */
export function createAsyncObservation(options: {
	owner: AsyncOwner;
	adapter?: AsyncObservationAdapter;
	readLocalSnapshot?(retainedRunIds: readonly string[]): readonly AsyncRunObservation[];
	readSnapshot?(retainedRunIds: readonly string[]): Promise<readonly AsyncRunObservation[]>;
	recovery?: AsyncRecoverySource;
	subscribe(callback: () => void): () => void;
	emitWake(data: { ownerSessionId: string; runId: string; state?: AsyncRunObservation["state"] }): void;
	onDiagnostic?(message: string): void;
}): AsyncObservation {
	const scan = options.recovery ? createRecoveryScan(options.recovery) : undefined;
	let disposed = false;
	let registration: AsyncObservationRegistration | undefined;
	let unsubscribe: (() => void) | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let pending: Promise<void> | undefined;
	let dirty = false;
	let generation = 0;
	let publishedRows: readonly AsyncRunObservation[] = [];
	let previous = new Map<string, AsyncRunObservation["state"]>();
	let unavailable = false;
	let delay = 1000;
	let priorSnapshot = "";
	const diagnostic = () => {
		if (unavailable) return;
		unavailable = true;
		try { options.onDiagnostic?.("Async observation unavailable."); } catch { /* Observation only. */ }
	};
	const releaseAdapter = () => {
		const current = registration;
		registration = undefined;
		try { current?.dispose(); } catch { diagnostic(); }
	};
	try {
		registration = options.adapter?.({ owner: options.owner, onDiagnostic: diagnostic });
	} catch { diagnostic(); }

	const schedule = (continuation = false) => {
		if (disposed || timer) return;
		timer = setTimeout(() => {
			timer = undefined;
			if (!continuation) delay = Math.min(delay * 2, 30000);
			void refresh(false);
		}, continuation ? 1000 : delay);
		timer.unref?.();
	};
	function publish(snapshot: readonly AsyncRunObservation[]): void {
		if (disposed) return;
		const rows = Object.freeze(snapshot.filter((row) =>
			row.ownerSessionId === options.owner.ownerSessionId).slice(0, MAX_OBSERVATION_ROWS));
		publishedRows = rows;
		try { registration?.update(rows); } catch { diagnostic(); releaseAdapter(); }
		if (disposed) return;
		const next = new Map(rows.map((row) => [row.runId, row.state]));
		const transitions: Array<[string, AsyncRunObservation["state"] | undefined]> =
			[...next].filter(([id, state]) => previous.get(id) !== state);
		for (const id of previous.keys()) if (!next.has(id)) transitions.push([id, undefined]);
		previous = next;
		for (const [runId, state] of transitions) {
			if (disposed) return;
			try { options.emitWake({ ownerSessionId: options.owner.ownerSessionId, runId, state }); }
			catch { diagnostic(); }
		}
	}
	const retainedRunIds = () => publishedRows.filter((row) => row.state === "running").map((row) => row.runId);
	function publishLocal(): void {
		try {
			if (options.readLocalSnapshot) {
				const local = options.readLocalSnapshot(retainedRunIds());
				const live = new Set(local.map((row) => row.runId));
				publish([...local, ...publishedRows.filter((row) =>
					row.state !== "running" && !live.has(row.runId))]);
			}
		} catch { diagnostic(); }
	}
	async function reconcile(): Promise<void> {
		// Coalesce changes during an artifact read; defer further changes to the next bounded poll.
		for (let pass = 0; pass < 2 && !disposed; pass++) {
			dirty = false;
			const currentGeneration = generation;
			try {
				const page = scan ? await scan.pass(retainedRunIds()) : undefined;
				let snapshot = page?.rows ?? await options.readSnapshot!(retainedRunIds());
				if (disposed) return;
				if (currentGeneration !== generation) { dirty = true; continue; }
				if (page && !page.complete) {
					// An incomplete local-validation prefix is not evidence that the other
					// selected handles disappeared. Keep their synchronous hold rows until
					// validation reaches them; validated rows always replace those holds.
					const validated = new Set(snapshot.map((row) => row.runId));
					const retained = new Set(retainedRunIds());
					const held = options.readLocalSnapshot?.([...retained]) ?? [];
					// Newly validated transitions precede already-delivered history, so
					// a live overflow hold cannot truncate the last terminal at the cap.
					snapshot = [...held.filter((row) => !validated.has(row.runId)),
						...snapshot.filter((row) => retained.has(row.runId)),
						...snapshot.filter((row) => !retained.has(row.runId))].slice(0, MAX_OBSERVATION_ROWS);
				}
				const signature = JSON.stringify(snapshot);
				if (page?.changed || signature !== priorSnapshot) delay = 1000;
				priorSnapshot = signature;
				const live = options.readLocalSnapshot?.([]) ?? [];
				if (live.length && !snapshot.some((row) => row.state === "running")) {
					// A full batch of exiting selected handles must not transiently announce
					// idle while an overflow handle remains live. Deliver every terminal in
					// bounded batches with a proven live row, then refill normally.
					publish([...snapshot.slice(0, MAX_OBSERVATION_ROWS - 1), live[0]]);
					if (snapshot.length === MAX_OBSERVATION_ROWS) {
						publish([...snapshot.slice(MAX_OBSERVATION_ROWS - 1), ...live].slice(0, MAX_OBSERVATION_ROWS));
					}
				} else publish(snapshot);

				// Terminal transitions have now reached the adapter. Refill live slots immediately.
				publishLocal();
				if (timer) { clearTimeout(timer); timer = undefined; }
				if (page && !page.complete) schedule(true);
				else if (publishedRows.some((row) => row.state === "running" || row.state === "unknown")) schedule();
			} catch { diagnostic(); schedule(true); }
			if (!dirty) break;
		}
		if (dirty) schedule(true);
	}
	function refresh(reset = true): Promise<void> {
		if (disposed) return Promise.resolve();
		generation++;
		if (reset) delay = 1000;
		if (timer) { clearTimeout(timer); timer = undefined; }
		// Local handles are proven synchronously; artifact I/O must not delay their publication.
		publishLocal();
		if (disposed) return Promise.resolve();
		if (pending) { if (reset) scan?.invalidate(); dirty = true; return pending; }
		pending = reconcile().finally(() => { pending = undefined; });
		return pending;
	}
	try { unsubscribe = options.subscribe(() => { if (!disposed) { scan?.invalidate(); void refresh(); } }); }
	catch { diagnostic(); }
	return {
		refresh,
		dispose() {
			if (disposed) return;
			disposed = true;
			scan?.dispose();
			if (timer) { clearTimeout(timer); timer = undefined; }
			try { unsubscribe?.(); } catch { diagnostic(); }
			unsubscribe = undefined;
			releaseAdapter();
			publishedRows = [];
			priorSnapshot = "";
			previous.clear();
		},
	};
}
