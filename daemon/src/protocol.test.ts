import { expect, test } from "bun:test";
import {
	PROTOCOL_VERSION,
	makeError,
	makeResponse,
	parseRequest,
} from "./protocol.ts";

test("parseRequest accepts valid v1 messages and rejects junk", () => {
	expect(
		parseRequest(JSON.stringify({ v: 1, id: "a1", type: "check", text: "hi" })),
	).toEqual({
		v: 1,
		id: "a1",
		type: "check",
		text: "hi",
	});
	expect(parseRequest("not json")).toBeNull();
	expect(
		parseRequest(JSON.stringify({ v: 2, id: "a1", type: "check" })),
	).toBeNull();
	expect(
		parseRequest(JSON.stringify({ v: 1, id: 5, type: "check" })),
	).toBeNull();
});

test("responses echo the request id", () => {
	const req = { v: PROTOCOL_VERSION, id: "b2", type: "ping" } as const;
	expect(makeResponse(req, "pong")).toEqual({
		v: 1,
		id: "b2",
		type: "pong",
		data: undefined,
	});
	expect(makeError(req, "boom")).toMatchObject({
		id: "b2",
		type: "error",
		error: "boom",
	});
});
