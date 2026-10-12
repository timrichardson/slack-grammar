import { expect, test } from "bun:test";
import {
	CHECK_RULES,
	type CheckState,
	normalizeForCompare,
	skipReason,
} from "./rules.ts";

const state = (): CheckState => ({ ignored: new Set<string>() });

test("empty, short, unchanged and ignored texts are skipped", () => {
	const s = state();
	expect(skipReason("", s)).toBe("empty");
	expect(skipReason("\n", s)).toBe("empty");
	expect(skipReason("hi there", s)).toBe("too-short");
	expect(skipReason("me too", s)).toBe("too-short");
	const long = "this is a long enough message";
	s.lastChecked = normalizeForCompare(long);
	expect(skipReason(long, s)).toBe("unchanged");
	s.ignored.add(normalizeForCompare(long));
	expect(skipReason(long, s)).toBe("ignored");
});

test("commands are skipped", () => {
	const s = state();
	expect(skipReason("/remind me to deploy at 3", s)).toBe("slash-command");
	expect(skipReason("heads up team:", s)).toBe("command");
});

test("open code fences are skipped, closed ones pass", () => {
	const s = state();
	expect(skipReason("look at this:\n```\nconst x = 1", s)).toBe(
		"open-code-fence",
	);
	expect(skipReason("look:\n```\nconst x = 1\n```\npls review", s)).toBeNull();
});

test("normal messages pass with min words", () => {
	const s = state();
	expect(skipReason("we was thinking about the launch", s)).toBeNull();
	expect(CHECK_RULES.minWords).toBeGreaterThanOrEqual(3);
});
