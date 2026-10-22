import { expect, test } from "bun:test";
import { applyLog } from "./apply-log.ts";

const metadata = {
	version: "3.1.0",
	attempt: 1,
	diagnostic: {
		stage: "finish",
		outcome: "restored",
		beforeChars: 10,
		afterChars: 10,
		connected: true,
		focused: true,
		interrupted: false,
		empty: false,
		elapsedMs: 300,
	},
};

test("apply logs only allowlisted metadata, stripping text and arbitrary fields", () => {
	const result = applyLog({
		...metadata,
		text: "synthetic private text",
		diagnostic: {
			...metadata.diagnostic,
			original: "synthetic private text",
			error: "synthetic private text",
		},
	});
	expect(result).toMatchObject({
		event: "apply",
		version: "3.1.0",
		outcome: "restored",
	});
	expect(JSON.stringify(result)).not.toContain("synthetic private text");
});

test("malformed metadata cannot smuggle text into log enums/version", () => {
	for (const data of [
		null,
		{},
		{ ...metadata, version: "synthetic private text" },
		{ ...metadata, attempt: -1 },
		{
			...metadata,
			diagnostic: { ...metadata.diagnostic, stage: "synthetic private text" },
		},
		{
			...metadata,
			diagnostic: { ...metadata.diagnostic, outcome: "synthetic private text" },
		},
		{
			...metadata,
			diagnostic: {
				...metadata.diagnostic,
				interruptEvent: "synthetic private text",
			},
		},
		{
			...metadata,
			diagnostic: {
				...metadata.diagnostic,
				afterChars: "synthetic private text",
			},
		},
		{
			...metadata,
			diagnostic: { ...metadata.diagnostic, empty: "synthetic private text" },
		},
	]) {
		expect(applyLog(data)).toBeNull();
	}
});
