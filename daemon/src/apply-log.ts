import { parseApplyDiagnostic } from "../../shared/apply-diagnostic.ts";

/** Explicit allowlist: never log the request, arbitrary data or renderer errors. */
export function applyLog(data: unknown): Record<string, unknown> | null {
	if (!data || typeof data !== "object") return null;
	const v = data as Record<string, unknown>;
	if (
		typeof v.version !== "string" ||
		!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v.version)
	)
		return null;
	if (!Number.isSafeInteger(v.attempt) || (v.attempt as number) < 1)
		return null;
	const diagnostic = parseApplyDiagnostic(v.diagnostic);
	return diagnostic
		? { event: "apply", version: v.version, attempt: v.attempt, ...diagnostic }
		: null;
}
