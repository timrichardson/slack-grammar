/** Allowlisted metadata only. Never include drafts, DOM, hashes or exceptions. */
export const APPLY_STAGES = [
	"snapshot",
	"insert",
	"verify",
	"undo",
	"restore",
	"finish",
] as const;
export const APPLY_OUTCOMES = [
	"applied",
	"unchanged",
	"restored",
	"interrupted",
	"failed",
] as const;
export const APPLY_INTERRUPTS = [
	"input",
	"beforeinput",
	"compositionstart",
	"keydown",
	"pointerdown",
	"paste",
	"cut",
	"drop",
	"click",
] as const;
export type ApplyOutcome = (typeof APPLY_OUTCOMES)[number];
export interface ApplyDiagnostic {
	stage: (typeof APPLY_STAGES)[number];
	outcome?: ApplyOutcome;
	beforeChars: number;
	afterChars: number;
	connected: boolean;
	focused: boolean;
	interrupted: boolean;
	interruptEvent?: (typeof APPLY_INTERRUPTS)[number];
	empty: boolean;
	elapsedMs: number;
}

/** Reconstruct instead of spreading untrusted renderer data into durable logs. */
export function parseApplyDiagnostic(value: unknown): ApplyDiagnostic | null {
	if (!value || typeof value !== "object") return null;
	const v = value as Record<string, unknown>;
	if (!APPLY_STAGES.includes(v.stage as ApplyDiagnostic["stage"])) return null;
	if (
		v.outcome !== undefined &&
		!APPLY_OUTCOMES.includes(v.outcome as ApplyOutcome)
	)
		return null;
	if (
		v.interruptEvent !== undefined &&
		!APPLY_INTERRUPTS.includes(
			v.interruptEvent as (typeof APPLY_INTERRUPTS)[number],
		)
	)
		return null;
	for (const key of ["beforeChars", "afterChars", "elapsedMs"])
		if (!Number.isSafeInteger(v[key]) || (v[key] as number) < 0) return null;
	for (const key of ["connected", "focused", "interrupted", "empty"])
		if (typeof v[key] !== "boolean") return null;
	return {
		stage: v.stage as ApplyDiagnostic["stage"],
		outcome: v.outcome as ApplyOutcome | undefined,
		beforeChars: v.beforeChars as number,
		afterChars: v.afterChars as number,
		connected: v.connected as boolean,
		focused: v.focused as boolean,
		interrupted: v.interrupted as boolean,
		interruptEvent: v.interruptEvent as ApplyDiagnostic["interruptEvent"],
		empty: v.empty as boolean,
		elapsedMs: v.elapsedMs as number,
	};
}
