/** Binding protocol v1 — messages between the injected bundle and the daemon. */

export const BINDING_NAME = "__slackGrammar";
export const RECEIVE_FN = "__slackGrammarReceive";
export const PROTOCOL_VERSION = 1;

export type RequestType = "hello" | "ping" | "check" | "apply-diagnostic";
export type ResponseType =
	| "hello-ok"
	| "pong"
	| "check-ok"
	| "diagnostic-ok"
	| "error";

export interface Request {
	v: 1;
	id: string;
	type: RequestType;
	text?: string;
	data?: unknown;
}

export interface Response {
	v: 1;
	id: string;
	type: ResponseType;
	data?: unknown;
	error?: string;
}

export function makeResponse(
	req: Request,
	type: ResponseType,
	data?: unknown,
): Response {
	return { v: 1, id: req.id, type, data };
}

export function makeError(req: Request, error: string): Response {
	return { v: 1, id: req.id, type: "error", error };
}

export function parseRequest(payload: string): Request | null {
	try {
		const m = JSON.parse(payload) as Request;
		if (
			m?.v === PROTOCOL_VERSION &&
			typeof m.id === "string" &&
			typeof m.type === "string"
		)
			return m;
	} catch {
		/* not for us */
	}
	return null;
}
