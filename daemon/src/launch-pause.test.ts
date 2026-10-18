import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	LaunchPause,
	type LaunchPauseState,
	launchPauseAcknowledged,
	requestLaunchPause,
} from "./launch-pause.ts";

function fixture() {
	const files = new Map<string, string>([["daemon.pid", "100"]]);
	const live = new Set([100, 200]);
	const state: LaunchPauseState = {
		readPid: (name) => {
			const value = files.get(name);
			return value === undefined ? null : Number(value);
		},
		readStateFile: (name) => files.get(name) ?? null,
		writeStateFile: (name, value) => {
			files.set(name, value);
		},
		isPidAlive: (pid) => live.has(pid),
	};
	return { files, live, state, gate: new LaunchPause(state, 100) };
}

test("acknowledged pause blocks every launch attempt until released", async () => {
	const { files, state, gate } = fixture();
	files.set("launch-pause.pid", "200");
	gate.acknowledge();
	expect(launchPauseAcknowledged(200, state)).toBe(true);
	let launches = 0;
	const launch = async () => ++launches;
	expect(await gate.launch(launch)).toBeUndefined();
	expect(await gate.launch(launch)).toBeUndefined();
	expect(launches).toBe(0);
	files.delete("launch-pause.pid");
	expect(await gate.launch(launch)).toBe(1);
});

test("pause waits for an in-flight launch to settle before acknowledging", async () => {
	const { files, state, gate } = fixture();
	let finish = () => {};
	const launch = gate.launch(
		() =>
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
	);
	files.set("launch-pause.pid", "200");
	gate.acknowledge();
	expect(launchPauseAcknowledged(200, state)).toBe(false);
	finish();
	await launch;
	expect(launchPauseAcknowledged(200, state)).toBe(true);
});

test("a failed in-flight launch also acknowledges the waiting helper", async () => {
	const { files, state, gate } = fixture();
	let fail = (_error: Error) => {};
	const launch = gate.launch(
		() =>
			new Promise<void>((_resolve, reject) => {
				fail = reject;
			}),
	);
	files.set("launch-pause.pid", "200");
	fail(new Error("synthetic launch failure"));
	await expect(launch).rejects.toThrow("synthetic launch failure");
	expect(launchPauseAcknowledged(200, state)).toBe(true);
});

test("a dead helper does not indefinitely inhibit Slack launching", async () => {
	const { files, live, gate } = fixture();
	files.set("launch-pause.pid", "200");
	live.delete(200);
	expect(await gate.launch(async () => "launched")).toBe("launched");
});

test("a restarting daemon must acknowledge with its own PID", () => {
	const { files, live, state, gate } = fixture();
	files.set("launch-pause.pid", "200");
	gate.acknowledge();
	live.add(101);
	files.set("daemon.pid", "101");
	expect(launchPauseAcknowledged(200, state)).toBe(false);
	new LaunchPause(state, 101).acknowledge();
	expect(launchPauseAcknowledged(200, state)).toBe(true);
});

test("no acknowledgement is needed when no daemon is alive", () => {
	const { files, live, state } = fixture();
	live.delete(100);
	expect(launchPauseAcknowledged(200, state)).toBe(true);
	files.delete("daemon.pid");
	expect(launchPauseAcknowledged(200, state)).toBe(true);
});

test("helpers acquire exclusively and discard stale acknowledgements", () => {
	const directory = mkdtempSync(join(tmpdir(), "slack-grammar-pause-"));
	try {
		writeFileSync(join(directory, "launch-paused"), `${process.pid}:100`);
		const release = requestLaunchPause(directory);
		expect(readFileSync(join(directory, "launch-pause.pid"), "utf8")).toBe(
			String(process.pid),
		);
		expect(() => readFileSync(join(directory, "launch-paused"))).toThrow();
		expect(() => requestLaunchPause(directory)).toThrow(
			"reinjection lock already exists",
		);
		release();
		requestLaunchPause(directory)();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
