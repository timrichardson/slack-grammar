import { expect, test } from "bun:test";
import { isSlackCmdline, shouldRespawnSlack } from "./launcher.ts";

test("detects NUL-separated cmdlines (normal exec)", () => {
	expect(
		isSlackCmdline("/usr/lib/slack/slack\0--remote-debugging-port=9222\0"),
	).toBe(true);
	expect(isSlackCmdline("/usr/bin/slack\0\0")).toBe(true);
});

test("detects space-joined cmdlines (Electron re-exec quirk, seen live)", () => {
	expect(
		isSlackCmdline("/usr/lib/slack/slack --remote-debugging-port=44359\0"),
	).toBe(true);
});

test("rejects non-slack processes", () => {
	expect(isSlackCmdline("/usr/lib/slack/slack --type=zygote\0")).toBe(true); // main-ish path but child type — path match is intended
	expect(isSlackCmdline("/usr/lib/slack/chrome_crashpad_handler\0")).toBe(
		false,
	);
	expect(isSlackCmdline("/home/tim/.bun/bin/bun\0run\0daemon\0")).toBe(false);
	expect(isSlackCmdline("")).toBe(false);
});

test("clean quit (exit 0) is not respawned", () => {
	expect(shouldRespawnSlack(true, 0, null)).toBe(false);
});

test("polite signals (TERM/INT) are treated as a user quit, not a crash", () => {
	expect(shouldRespawnSlack(true, null, "SIGTERM")).toBe(false);
	expect(shouldRespawnSlack(true, null, "SIGINT")).toBe(false);
});

test("abnormal exits of spawned slack are crash-restarted", () => {
	expect(shouldRespawnSlack(true, 1, null)).toBe(true); // non-zero exit code
	expect(shouldRespawnSlack(true, null, "SIGSEGV")).toBe(true); // hard crash
	expect(shouldRespawnSlack(true, null, "SIGKILL")).toBe(true);
});

test("adopted (not spawned) slack is never respawned", () => {
	expect(shouldRespawnSlack(false, null, null)).toBe(false);
	expect(shouldRespawnSlack(false, 1, null)).toBe(false);
});
