// Portable test contract supplied for the public 0.78.0 API.
// This fixture is not evidence from an installed consumer; runtime tests stay synthetic.
declare module "pi-subagents/external-runs" {
	export type ExternalRunState = "queued" | "running" | "completed" | "failed" | "stopped";
	export interface ExternalRun {
		id: string;
		sessionId: string;
		source: string;
		label: string;
		state: ExternalRunState;
		startedAt: number;
		updatedAt?: number;
		endedAt?: number;
		currentAction?: string;
		preview?: string;
		reportPath?: string;
		transcriptPath?: string;
	}
	export type ExternalRunUpdate = Partial<Omit<ExternalRun, "id" | "sessionId" | "source">>;
	export function registerExternalRun(input: ExternalRun): ExternalRun;
	export function updateExternalRun(sessionId: string, id: string, update: ExternalRunUpdate): ExternalRun;
	export function unregisterExternalRun(sessionId: string, id: string): boolean;
	export function snapshotExternalRuns(sessionId: string, options?: {
		onMalformedRecord?: (message: string) => void;
		ignoreMalformed?: boolean;
	}): readonly ExternalRun[];
}

declare module "pi-subagents/background-work" {
	export interface BackgroundWorkItem { id: string; sessionId: string }
	export interface BackgroundWorkListContext { sessionId: string; nowMs: number }
	export interface BackgroundWorkReconcileContext { sessionId: string; nowMs: number }
	export interface BackgroundWorkProvider {
		name: string;
		listActiveWork(context?: BackgroundWorkListContext): readonly BackgroundWorkItem[];
		wakeChannels?: readonly string[];
		reconcile?(context: BackgroundWorkReconcileContext): void;
	}
	export function registerBackgroundWorkProvider(provider: BackgroundWorkProvider): () => void;
	export function snapshotBackgroundWork(sessionId: string, nowMs?: number): {
		providers: readonly string[];
		items: readonly (BackgroundWorkItem & { provider: string })[];
	};
}
