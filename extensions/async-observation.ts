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

/** A disposable projection, not a run registry. Only explicit control actions retrieve results. */
export function createAsyncObservation(options: {
	owner: AsyncOwner;
	adapter?: AsyncObservationAdapter;
	readLocalSnapshot?(): readonly AsyncRunObservation[];
	readSnapshot(): Promise<readonly AsyncRunObservation[]>;
	subscribe(callback: () => void): () => void;
	emitWake(data: { ownerSessionId: string; runId: string; state?: AsyncRunObservation["state"] }): void;
	onDiagnostic?(message: string): void;
}): AsyncObservation {
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

	const schedule = () => {
		if (disposed || timer) return;
		timer = setTimeout(() => { timer = undefined; void refresh(); }, 1000);
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
		if (rows.some((row) => row.state === "running" || row.state === "unknown")) schedule();
	}
	async function reconcile(): Promise<void> {
		// Coalesce changes during an artifact read; defer further changes to the next bounded poll.
		for (let pass = 0; pass < 2 && !disposed; pass++) {
			dirty = false;
			const currentGeneration = generation;
			try {
				const snapshot = await options.readSnapshot();
				if (disposed) return;
				if (currentGeneration !== generation) { dirty = true; continue; }
				publish(snapshot);
			} catch { diagnostic(); schedule(); }
			if (!dirty) break;
		}
		if (dirty) schedule();
	}
	function refresh(): Promise<void> {
		if (disposed) return Promise.resolve();
		generation++;
		// Local handles are proven synchronously; artifact I/O must not delay their publication.
		try {
			if (options.readLocalSnapshot) {
				const local = options.readLocalSnapshot();
				const live = new Set(local.map((row) => row.runId));
				publish([...local, ...publishedRows.filter((row) =>
					row.state !== "running" && !live.has(row.runId))]);
			}
		} catch { diagnostic(); }
		if (disposed) return Promise.resolve();
		if (pending) { dirty = true; return pending; }
		if (timer) { clearTimeout(timer); timer = undefined; }
		pending = reconcile().finally(() => { pending = undefined; });
		return pending;
	}
	try { unsubscribe = options.subscribe(() => { if (!disposed) void refresh(); }); }
	catch { diagnostic(); }
	return {
		refresh,
		dispose() {
			if (disposed) return;
			disposed = true;
			if (timer) { clearTimeout(timer); timer = undefined; }
			try { unsubscribe?.(); } catch { diagnostic(); }
			unsubscribe = undefined;
			releaseAdapter();
			publishedRows = [];
			previous.clear();
		},
	};
}
