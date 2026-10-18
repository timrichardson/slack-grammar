import { describe, expect, test } from "bun:test";
import {
	LaunchPause,
	type LaunchPauseState,
} from "../daemon/src/launch-pause.ts";
import {
	type RestartSteps,
	isSlackMainCmdline,
	main,
	parseArgs,
	restartSlack,
	serviceManaged,
} from "./reinject.ts";

describe("reinject script", () => {
	test("requires confirmation by default and accepts explicit flags", () => {
		expect(parseArgs([])).toEqual({ yes: false, help: false });
		expect(parseArgs(["--yes"])).toEqual({ yes: true, help: false });
		expect(parseArgs(["--help"])).toEqual({ yes: false, help: true });
		expect(parseArgs(["-h"])).toEqual({ yes: false, help: true });
		expect(() => parseArgs(["--force"])).toThrow("unknown argument");
	});

	test("only targets Slack main processes, including Electron self re-exec", () => {
		expect(isSlackMainCmdline("/usr/lib/slack/slack\0")).toBe(true);
		expect(
			isSlackMainCmdline("/usr/bin/slack --remote-debugging-port=12345"),
		).toBe(true);
		expect(isSlackMainCmdline("/usr/lib/slack/slack\0--type=renderer\0")).toBe(
			false,
		);
		expect(isSlackMainCmdline("/usr/lib/slack/slack --type=zygote")).toBe(
			false,
		);
		expect(isSlackMainCmdline("/usr/bin/bash\0slack\0")).toBe(false);
		expect(isSlackMainCmdline("/other/slack\0")).toBe(false);
	});

	test("refuses noninteractive restart without --yes before any side effects", async () => {
		if (!process.stdin.isTTY || !process.stdout.isTTY) {
			await expect(main([])).rejects.toThrow(
				"confirmation requires a terminal",
			);
		}
	});

	test("preserves ownership of services awaiting an automatic restart", () => {
		for (const state of ["active", "activating", "deactivating", "reloading"])
			expect(serviceManaged(state)).toBe(true);
		for (const state of ["inactive", "failed", null])
			expect(serviceManaged(state)).toBe(false);
		expect(() => serviceManaged("unknown")).toThrow(
			"unexpected systemd service state",
		);
	});
});

function restartFixture(serviceState: string | null = "inactive") {
	const events: string[] = [];
	const files = new Map<string, string>();
	let launches = 0;
	const state: LaunchPauseState = {
		readPid: (name) => (files.has(name) ? Number(files.get(name)) : null),
		readStateFile: (name) => files.get(name) ?? null,
		writeStateFile: (name, value) => {
			files.set(name, value);
		},
		isPidAlive: () => true,
	};
	const gate = new LaunchPause(state, 100);
	const supervise = () => gate.launch(async () => ++launches);
	const steps: RestartSteps = {
		serviceState: async () => serviceState,
		pauseLaunches: () => {
			events.push("pause");
			files.set("launch-pause.pid", "200");
			return () => {
				events.push("resume");
				files.delete("launch-pause.pid");
			};
		},
		waitUntilPaused: async () => {
			gate.acknowledge();
			expect(files.get("launch-paused")).toBe("200:100");
			events.push("acknowledged");
		},
		quitSlack: async () => {
			events.push("quit");
			// Reproduce a supervisor tick immediately after external Slack exits.
			await supervise();
			expect(launches).toBe(0);
		},
		stopDaemon: async (managed) => {
			events.push(managed ? "stop-service" : "stop-detached");
			await supervise();
			expect(launches).toBe(0);
		},
		startDaemon: async (managed) => {
			events.push(managed ? "start-service" : "start-detached");
			await supervise();
			expect(launches).toBe(1);
		},
	};
	return { steps, events, files };
}

test("external Slack cannot be relaunched during a detached restart", async () => {
	const { steps, events } = restartFixture();
	await restartSlack(steps);
	expect(events).toEqual([
		"pause",
		"acknowledged",
		"quit",
		"stop-detached",
		"resume",
		"start-detached",
	]);
});

test("an auto-restarting service is stopped and restarted through systemd", async () => {
	const { steps, events } = restartFixture("activating");
	await restartSlack(steps);
	expect(events).toEqual([
		"pause",
		"acknowledged",
		"quit",
		"stop-service",
		"resume",
		"start-service",
	]);
});

test("a missing pause acknowledgement leaves Slack untouched and releases the pause", async () => {
	const { steps, events, files } = restartFixture();
	steps.waitUntilPaused = async () => {
		throw new Error("no acknowledgement");
	};
	await expect(restartSlack(steps)).rejects.toThrow("no acknowledgement");
	expect(events).toEqual(["pause", "resume"]);
	expect(files.has("launch-pause.pid")).toBe(false);
});

test("Slack quit timeout resumes supervision without stopping the service", async () => {
	const { steps, events, files } = restartFixture("active");
	steps.quitSlack = async () => {
		throw new Error("Slack did not quit");
	};
	await expect(restartSlack(steps)).rejects.toThrow("Slack did not quit");
	expect(events).toEqual(["pause", "acknowledged", "resume"]);
	expect(files.has("launch-pause.pid")).toBe(false);
});

test("daemon stop failure releases the pause without launching another daemon", async () => {
	const { steps, events } = restartFixture("activating");
	steps.stopDaemon = async () => {
		throw new Error("stop failed");
	};
	await expect(restartSlack(steps)).rejects.toThrow("stop failed");
	expect(events).toEqual(["pause", "acknowledged", "quit", "resume"]);
});
