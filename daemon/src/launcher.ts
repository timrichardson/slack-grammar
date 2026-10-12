/** Slack process discovery and launching with an ephemeral CDP port. */
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:net";

export const SLACK_BIN_CANDIDATES = ["/usr/bin/slack", "/usr/lib/slack/slack"];

export function findSlackBinary(): string | null {
	for (const p of SLACK_BIN_CANDIDATES) {
		try {
			readFileSync(p);
			return p;
		} catch {
			/* try next */
		}
	}
	return null;
}

/** True when a /proc cmdline string belongs to a Slack main process. */
export function isSlackCmdline(cmdline: string): boolean {
	// NB: Electron's self re-exec can leave the whole command line as one
	// argv element with spaces instead of NUL separators — split on both.
	const first = cmdline.split(/\0|\s+/)[0] ?? "";
	return first === "/usr/bin/slack" || first === "/usr/lib/slack/slack";
}

/** Scan /proc for any running Slack main process (avoids pgrep/pkill self-match bugs). */
export function isSlackRunning(): boolean {
	try {
		for (const pid of readdirSync("/proc")) {
			if (!/^\d+$/.test(pid)) continue;
			try {
				if (isSlackCmdline(readFileSync(`/proc/${pid}/cmdline`, "utf8")))
					return true;
			} catch {
				/* permission or race — skip */
			}
		}
	} catch {
		return false;
	}
	return false;
}

export async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.unref();
		srv.on("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			if (addr && typeof addr === "object") resolve(addr.port);
			else reject(new Error("no port"));
			srv.close();
		});
	});
}

export async function waitUntil(url: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const r = await fetch(url, { signal: AbortSignal.timeout(1000) });
			if (r.ok) return;
		} catch {
			/* retry */
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(`timeout waiting for ${url}`);
}

/** Launch Slack detached with the CDP flag; resolves once the CDP endpoint answers. */
export async function launchSlack(
	bin: string,
	port: number,
	log: (msg: string) => void,
): Promise<{ proc: ChildProcess; port: number }> {
	const proc = spawn(bin, [`--remote-debugging-port=${port}`], {
		detached: true,
		stdio: "ignore",
		env: process.env,
	});
	proc.unref();
	log(
		`launched slack pid=${proc.pid} with --remote-debugging-port=${port} (127.0.0.1 only)`,
	);
	await waitUntil(`http://127.0.0.1:${port}/json/version`, 30_000);
	return { proc, port };
}
