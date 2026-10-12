import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { findSlackBinary, isSlackRunning } from "./launcher.ts";
import {
	bundlePath,
	initStateDir,
	isPidAlive,
	readPid,
	readStateFile,
	writeStateFile,
} from "./runtime.ts";

const log = (e: Record<string, unknown>) =>
	console.log(JSON.stringify({ ts: new Date().toISOString(), ...e }));

const HELP = `slack-grammar daemon

usage: slack-grammar <command>
  start      run the daemon in the foreground (llama + gateway + Slack injection)
  launch     make sure the daemon is running and Slack is launched through it
  stop       stop the daemon (Slack keeps running)
  status     show daemon/gateway/injector status as JSON
  doctor     environment health check
  install-desktop-entry  add a launcher entry that routes Slack through the daemon
`;

async function cmdStart(): Promise<void> {
	const cfg = loadConfig();
	const app = await runApp(cfg, log);
	process.on("SIGINT", () => void app.stop());
	process.on("SIGTERM", () => void app.stop());
}

async function cmdLaunch(): Promise<void> {
	const cfg = loadConfig();
	// 1. daemon running?
	try {
		const r = await fetch(
			`http://${cfg.gateway.host}:${cfg.gateway.port}/health`,
			{ signal: AbortSignal.timeout(1000) },
		);
		if (!r.ok) throw new Error("unhealthy");
	} catch {
		// start detached: setsid so it survives this CLI call; logs go to the state dir
		const { openSync } = await import("node:fs");
		const { join: j } = await import("node:path");
		initStateDir();
		const logFd = openSync(
			j(
				process.env.XDG_STATE_HOME ?? `${process.env.HOME}/.local/state`,
				"slack-grammar",
				"daemon.log",
			),
			"a",
		);
		spawn(process.execPath, [join(import.meta.dir, "main.ts"), "start"], {
			detached: true,
			stdio: ["ignore", logFd, logFd],
			env: process.env,
		}).unref();
		// wait for gateway
		const deadline = Date.now() + 60_000;
		while (Date.now() < deadline) {
			try {
				const r = await fetch(
					`http://${cfg.gateway.host}:${cfg.gateway.port}/health`,
					{
						signal: AbortSignal.timeout(1000),
					},
				);
				if (r.ok) break;
			} catch {
				/* retry */
			}
			await new Promise((r) => setTimeout(r, 500));
		}
	}
	// 2. request Slack launch (daemon picks it up; skips if Slack already injected)
	initStateDir();
	writeStateFile("launch-requested", String(Date.now()));
	console.log("daemon notified — Slack will launch through slack-grammar");
}

async function cmdStop(): Promise<void> {
	const pid = readPid("daemon.pid");
	if (pid === null || !isPidAlive(pid)) {
		console.log("daemon not running");
		return;
	}
	process.kill(pid, "SIGTERM");
	console.log(`daemon (pid ${pid}) stopping; Slack keeps running`);
}

async function cmdStatus(): Promise<void> {
	const pid = readPid("daemon.pid");
	const daemonAlive = pid !== null && isPidAlive(pid);
	const cdpPort = readStateFile("cdp.port");
	let gatewayOk = false;
	try {
		const cfg = loadConfig();
		const r = await fetch(
			`http://${cfg.gateway.host}:${cfg.gateway.port}/health`,
			{
				signal: AbortSignal.timeout(1000),
			},
		);
		gatewayOk = r.ok;
	} catch {
		/* down */
	}
	let cdpOk = false;
	if (cdpPort) {
		try {
			const r = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, {
				signal: AbortSignal.timeout(1000),
			});
			cdpOk = r.ok;
		} catch {
			/* down */
		}
	}
	console.log(
		JSON.stringify(
			{
				daemon: { pid, running: daemonAlive },
				gateway: { running: gatewayOk },
				slack: {
					running: isSlackRunning(),
					cdpPort: cdpPort ? Number(cdpPort) : null,
					cdpOk,
				},
			},
			null,
			2,
		),
	);
}

async function cmdDoctor(): Promise<number> {
	const cfg = loadConfig();
	const checks: { name: string; ok: boolean; detail: string }[] = [];

	const vulkan = spawn("vulkaninfo", ["--summary"], { stdio: "pipe" });
	const vulkanOut = await new Promise<string>((resolve) => {
		let out = "";
		vulkan.stdout.on("data", (d) => {
			out += d;
		});
		vulkan.on("close", () => resolve(out));
		vulkan.on("error", () => resolve(""));
	});
	const gpus = [...vulkanOut.matchAll(/deviceName\s+=\s+(.+)/g)].map(
		(m) => m[1]?.trim() ?? "",
	);
	checks.push({
		name: "vulkan",
		ok: gpus.length > 0,
		detail: gpus.join(" | ") || "no Vulkan devices",
	});

	checks.push({
		name: "llama-server binary",
		ok: existsSync(join(cfg.llm.llamaBinDir, "llama-server")),
		detail: cfg.llm.llamaBinDir,
	});
	checks.push({
		name: "model file",
		ok: existsSync(cfg.llm.modelPath),
		detail: cfg.llm.modelPath,
	});

	const { LlmClient } = await import("./llm.ts");
	const llm = new LlmClient(
		`http://${cfg.llm.host}:${cfg.llm.port}`,
		cfg.gateway.timeoutMs,
	);
	checks.push({
		name: "llama-server health",
		ok: await llm.health(),
		detail: `http://${cfg.llm.host}:${cfg.llm.port}`,
	});

	checks.push({
		name: "bundle built",
		ok: existsSync(bundlePath()),
		detail: bundlePath(),
	});

	const bin = findSlackBinary();
	checks.push({
		name: "slack binary",
		ok: bin !== null,
		detail: bin ?? "not found",
	});
	checks.push({
		name: "slack running",
		ok: true,
		detail: isSlackRunning() ? "yes" : "no (daemon can launch it)",
	});

	for (const c of checks)
		console.log(`${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
	const failed = checks.filter((c) => !c.ok).length;
	console.log(failed === 0 ? "doctor: OK" : `doctor: ${failed} problem(s)`);
	return failed === 0 ? 0 : 1;
}

async function cmdInstallDesktopEntry(): Promise<void> {
	const { writeFileSync, mkdirSync } = await import("node:fs");
	const home = process.env.HOME;
	if (!home) throw new Error("no HOME");
	const dir = join(home, ".local", "share", "applications");
	mkdirSync(dir, { recursive: true });
	const bun = process.execPath;
	const entry = `[Desktop Entry]
Name=Slack (slack-grammar)
Comment=Slack with local grammar checking
Exec=${bun} run ${join(import.meta.dir, "main.ts")} launch
Type=Application
Icon=slack
Categories=Network;InstantMessaging;
Terminal=false
`;
	const p = join(dir, "slack-grammar.desktop");
	writeFileSync(p, entry);
	console.log(`wrote ${p}`);
	console.log(
		"note: launch it instead of the normal Slack entry to get injection",
	);
}

const cmd = process.argv[2] ?? "help";
if (cmd === "start") await cmdStart();
else if (cmd === "launch") await cmdLaunch();
else if (cmd === "stop") await cmdStop();
else if (cmd === "status") await cmdStatus();
else if (cmd === "doctor") process.exit(await cmdDoctor());
else if (cmd === "install-desktop-entry") await cmdInstallDesktopEntry();
else console.log(HELP);
