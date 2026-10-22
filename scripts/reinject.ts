#!/usr/bin/env bun
/** Safely restart Slack through the grammar-checker daemon. */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { CdpConnection } from "../daemon/src/cdp.ts";
import { loadConfig, repoRoot } from "../daemon/src/config.ts";
import {
	launchPauseAcknowledged,
	requestLaunchPause,
} from "../daemon/src/launch-pause.ts";
import { isSlackCmdline } from "../daemon/src/launcher.ts";
import { isPidAlive, readPid, readStateFile } from "../daemon/src/runtime.ts";
import { BUNDLE_VERSION } from "../shared/bundle-version.ts";

const HELP = `Restart Slack with the local grammar checker injected.

Usage: bun run reinject [--yes]
  --yes       skip confirmation (save drafts and finish calls first)
  --help      show this help

Rebuilds the bundle, gracefully stops Slack, restarts the daemon, and verifies
the checker connection. Never force-kills Slack or edits composer contents.`;

export function parseArgs(args: string[]): { yes: boolean; help: boolean } {
	for (const arg of args) {
		if (!["--yes", "--help", "-h"].includes(arg)) {
			throw new Error(`unknown argument: ${arg}; use --help`);
		}
	}
	return {
		yes: args.includes("--yes"),
		help: args.includes("--help") || args.includes("-h"),
	};
}

export function isSlackMainCmdline(cmdline: string): boolean {
	return (
		isSlackCmdline(cmdline) &&
		!cmdline.split(/\0|\s+/).some((arg) => arg.startsWith("--type="))
	);
}

function slackPids(mainOnly = true): number[] {
	const pids: number[] = [];
	for (const entry of readdirSync("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		try {
			if (statSync(`/proc/${entry}`).uid !== process.getuid?.()) continue;
			const cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8");
			if (mainOnly ? isSlackMainCmdline(cmdline) : isSlackCmdline(cmdline)) {
				pids.push(Number(entry));
			}
		} catch {
			// Process exited, or belongs to another user.
		}
	}
	return pids;
}

async function command(args: string[]): Promise<boolean> {
	try {
		const child = Bun.spawn(args, {
			cwd: repoRoot,
			stdin: "ignore",
			stdout: "inherit",
			stderr: "inherit",
		});
		return (await child.exited) === 0;
	} catch {
		return false;
	}
}

async function serviceState(): Promise<string | null> {
	try {
		const child = Bun.spawn(
			[
				"systemctl",
				"--user",
				"show",
				"--property=ActiveState",
				"--value",
				"slack-grammar.service",
			],
			{ stdin: "ignore", stdout: "pipe", stderr: "ignore" },
		);
		const [output, code] = await Promise.all([
			new Response(child.stdout).text(),
			child.exited,
		]);
		return code === 0 ? output.trim() : null;
	} catch {
		return null; // systemd is optional for detached-daemon installations.
	}
}

export function serviceManaged(state: string | null): boolean {
	if (state === null || state === "inactive" || state === "failed")
		return false;
	if (
		[
			"active",
			"activating",
			"deactivating",
			"reloading",
			"refreshing",
		].includes(state)
	)
		return true;
	throw new Error(`unexpected systemd service state: ${state}`);
}

export interface RestartSteps {
	serviceState(): Promise<string | null>;
	pauseLaunches(): () => void;
	waitUntilPaused(): Promise<void>;
	quitSlack(): Promise<void>;
	stopDaemon(managed: boolean): Promise<void>;
	startDaemon(managed: boolean): Promise<void>;
}

/** Keep inhibition in place until both the daemon and pending service jobs stop. */
export async function restartSlack(steps: RestartSteps): Promise<void> {
	const managed = serviceManaged(await steps.serviceState());
	const resume = steps.pauseLaunches();
	try {
		await steps.waitUntilPaused();
		await steps.quitSlack();
		await steps.stopDaemon(managed);
	} finally {
		resume();
	}
	await steps.startDaemon(managed);
}

async function required(args: string[]): Promise<void> {
	if (!(await command(args)))
		throw new Error(`command failed: ${args.join(" ")}`);
}

async function waitFor(
	check: () => boolean | Promise<boolean>,
	ms: number,
	failure: string,
): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (await check()) return;
		await Bun.sleep(500);
	}
	throw new Error(failure);
}

async function injectionReady(): Promise<boolean> {
	const port = Number(readStateFile("cdp.port"));
	if (!Number.isInteger(port) || port <= 0 || port > 65535) return false;
	try {
		const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
			signal: AbortSignal.timeout(1000),
		});
		const pages = (await response.json()) as {
			type: string;
			webSocketDebuggerUrl?: string;
		}[];
		for (const page of pages) {
			if (page.type !== "page" || !page.webSocketDebuggerUrl) continue;
			const url = new URL(page.webSocketDebuggerUrl);
			if (
				url.protocol !== "ws:" ||
				url.hostname !== "127.0.0.1" ||
				Number(url.port) !== port
			)
				continue;
			const conn = new CdpConnection(url.href);
			// A read-only probe: no DOM, drafts, channel names, or message text are read.
			const probe = async () => {
				await conn.connect();
				const result = (await conn.send("Runtime.evaluate", {
					expression: `Boolean(window.__sg?.connected && window.__sg?.watcher?.enabled && window.__sg?.version === ${JSON.stringify(BUNDLE_VERSION)})`,
					returnByValue: true,
				})) as { result?: { value?: boolean } };
				return result.result?.value === true;
			};
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				if (
					await Promise.race([
						probe().finally(() => conn.close()),
						new Promise<boolean>((resolve) => {
							timer = setTimeout(() => resolve(false), 2000);
						}),
					])
				)
					return true;
			} finally {
				clearTimeout(timer);
				conn.close();
			}
		}
	} catch {
		// Slack may still be starting or navigating.
	}
	return false;
}

export async function main(args: string[]): Promise<void> {
	const options = parseArgs(args);
	if (options.help) {
		console.log(HELP);
		return;
	}
	if (!options.yes) {
		if (!process.stdin.isTTY || !process.stdout.isTTY) {
			throw new Error(
				"confirmation requires a terminal; use --yes only after saving drafts and finishing calls",
			);
		}
		const prompt = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		try {
			const answer = await prompt.question(
				"Save drafts and finish calls. Restart Slack with grammar checking? [y/N] ",
			);
			if (!/^y(es)?$/i.test(answer.trim())) {
				console.log("Cancelled; Slack was not changed.");
				return;
			}
		} finally {
			prompt.close();
		}
	}

	const cli = [process.execPath, join(repoRoot, "daemon/src/main.ts")];
	const cfg = loadConfig();
	// Build before interrupting Slack, so missing dependencies are harmless.
	await required([process.execPath, "run", "build:bundle"]);
	await restartSlack({
		serviceState,
		pauseLaunches: requestLaunchPause,
		waitUntilPaused: () => {
			console.log("Waiting for the daemon to pause Slack launches…");
			return waitFor(
				launchPauseAcknowledged,
				cfg.llm.startupTimeoutMs + 35_000,
				"daemon did not acknowledge the launch pause; Slack was not asked to quit. For an older daemon, quit Slack manually and stop the daemon/service before rerunning.",
			);
		},
		async quitSlack() {
			// Quit Slack first: systemd's default KillMode kills service children.
			console.log("Asking Slack to quit gracefully…");
			for (const pid of slackPids()) {
				try {
					process.kill(pid, "SIGTERM");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
				}
			}
			await waitFor(
				() => slackPids(false).length === 0,
				20_000,
				"Slack did not quit; no force-kill attempted. Quit Slack manually, then rerun this script.",
			);
		},
		async stopDaemon(managed) {
			if (managed)
				await required([
					"systemctl",
					"--user",
					"stop",
					"slack-grammar.service",
				]);
			else await required([...cli, "stop"]);
			await waitFor(
				() => {
					const pid = readPid("daemon.pid");
					return pid === null || !isPidAlive(pid);
				},
				15_000,
				"daemon did not stop; no new daemon was launched",
			);
		},
		async startDaemon(managed) {
			if (managed) {
				// Give a long-lived user manager the current graphical-session environment.
				const names = [
					"DISPLAY",
					"WAYLAND_DISPLAY",
					"XAUTHORITY",
					"XDG_RUNTIME_DIR",
					"DBUS_SESSION_BUS_ADDRESS",
				].filter((name) => process.env[name]);
				if (names.length)
					await required([
						"systemctl",
						"--user",
						"import-environment",
						...names,
					]);
				await required([
					"systemctl",
					"--user",
					"start",
					"slack-grammar.service",
				]);
				// Do not let `launch` race service startup and spawn a second daemon.
				await waitFor(
					async () => {
						try {
							const response = await fetch(
								`http://${cfg.gateway.host}:${cfg.gateway.port}/health`,
								{
									signal: AbortSignal.timeout(1000),
								},
							);
							return response.ok;
						} catch {
							return false;
						}
					},
					60_000,
					"systemd daemon did not become healthy; check `journalctl --user -u slack-grammar.service`",
				);
			}
			await required([...cli, "launch"]);
		},
	});
	console.log("Waiting for Slack and the grammar checker…");
	await waitFor(
		injectionReady,
		60_000,
		"Could not verify injection. Slack was not force-killed. Check `bun run doctor` and the daemon logs.",
	);
	console.log(`Slack grammar checker ${BUNDLE_VERSION} injected and enabled.`);
}

if (import.meta.main) {
	try {
		await main(process.argv.slice(2));
	} catch (error) {
		console.error(`error: ${(error as Error).message}`);
		process.exitCode = 1;
	}
}
