import type { ChildProcess } from "node:child_process";
import { CdpConnection, Injector, loadBundleSource } from "./cdp.ts";
/** App orchestration: llama-server + gateway + Slack launcher + CDP injector. */
import type { Config } from "./config.ts";
import { Checker, startGateway } from "./gateway.ts";
import {
	findSlackBinary,
	freePort,
	isSlackRunning,
	launchSlack,
	shouldRespawnSlack,
	waitUntil,
} from "./launcher.ts";
import { LlmClient, ensureLlamaServer } from "./llm.ts";
import { type Request, makeError, makeResponse } from "./protocol.ts";
import {
	initStateDir,
	readPid,
	readStateFile,
	removeStateFile,
	writePid,
	writeStateFile,
} from "./runtime.ts";

export interface AppStatus {
	running: boolean;
	gatewayPort: number;
	cdpPort: number | null;
	targets: number;
	slack: "launched-by-daemon" | "external" | "stopped";
	restarts: number;
}

export interface AppHandle {
	status(): AppStatus;
	stop(): Promise<void>;
}

export async function runApp(
	cfg: Config,
	log: (e: Record<string, unknown>) => void,
): Promise<AppHandle> {
	initStateDir();
	writePid("daemon.pid", process.pid);
	writeStateFile("gateway.port", String(cfg.gateway.port));

	// LLM + gateway
	const llamaProc: ChildProcess | null = await ensureLlamaServer(cfg, (msg) =>
		log({ event: "llama", msg }),
	);
	const llm = new LlmClient(
		`http://${cfg.llm.host}:${cfg.llm.port}`,
		cfg.gateway.timeoutMs,
	);
	const checker = new Checker(cfg, llm, (e) => log(e));
	const server = startGateway(cfg, checker);
	log({
		event: "gateway",
		msg: `listening on http://${cfg.gateway.host}:${cfg.gateway.port}`,
	});

	// Injector supervision
	let running = true;
	let slackOwned = false;
	let slackProc: ChildProcess | null = null;
	let cdpPort: number | null = null;
	let targets = 0;
	let restarts = 0;
	let conn: CdpConnection | null = null;
	let injector: Injector | null = null;
	let disconnectedResolve: (() => void) | null = null;

	const status = (): AppStatus => ({
		running,
		gatewayPort: cfg.gateway.port,
		cdpPort,
		targets,
		slack: slackOwned
			? "launched-by-daemon"
			: isSlackRunning()
				? "external"
				: "stopped",
		restarts,
	});

	async function onRequest(sessionId: string, req: Request): Promise<void> {
		const respondVia = injector?.respond.bind(injector, sessionId);
		if (!respondVia) return;
		try {
			if (req.type === "hello") {
				await respondVia(
					makeResponse(req, "hello-ok", {
						targets: injector?.targetCount ?? 0,
						config: {
							debounceMs: cfg.check.debounceMs,
							minWords: cfg.check.minWords,
						},
					}),
				);
			} else if (req.type === "ping") {
				await respondVia(makeResponse(req, "pong"));
			} else if (req.type === "check") {
				if (typeof req.text !== "string") {
					await respondVia(makeError(req, "text required"));
					return;
				}
				const result = await checker.check(req.text);
				await respondVia(makeResponse(req, "check-ok", result));
			} else {
				await respondVia(makeError(req, `unknown type: ${req.type}`));
			}
		} catch (e) {
			await respondVia(makeError(req, String(e))).catch(() => undefined);
		}
	}

	async function ensureSlack(): Promise<boolean> {
		const requested = readStateFile("launch-requested") !== null;
		if (requested) removeStateFile("launch-requested");
		if (isSlackRunning() && slackOwned && cdpPort) {
			try {
				await waitUntil(`http://127.0.0.1:${cdpPort}/json/version`, 1000);
				return true;
			} catch {
				return false; // slack alive but our endpoint gone — treat as disconnect
			}
		}
		if (isSlackRunning() && !slackOwned) {
			// A Slack we didn't spawn: adopt it if it still has our debug port
			// (daemon restarted while Slack kept running), else wait it out.
			const portFromFile = Number(readStateFile("cdp.port"));
			if (Number.isInteger(portFromFile) && portFromFile > 0) {
				try {
					await waitUntil(
						`http://127.0.0.1:${portFromFile}/json/version`,
						1000,
					);
					slackOwned = true;
					cdpPort = portFromFile;
					log({
						event: "slack",
						msg: `adopted running slack on CDP port ${portFromFile}`,
					});
					return true;
				} catch {
					return false; // external slack without our port
				}
			}
			return false;
		}
		if (slackOwned && !isSlackRunning()) {
			// Our Slack is gone. Distinguish a deliberate quit from a crash:
			// only abnormal exits of a process we spawned get crash-restarts.
			const spawned = slackProc !== null;
			const exitCode = slackProc?.exitCode ?? null;
			const signal = slackProc?.signalCode ?? null;
			slackProc = null;
			cdpPort = null;
			removeStateFile("cdp.port"); // avoid stale-port confusion later
			if (!shouldRespawnSlack(spawned, exitCode, signal)) {
				slackOwned = false;
				log({
					event: "slack",
					msg: spawned
						? "slack exited cleanly (user quit) — not respawning; use `slack-grammar launch`"
						: "adopted slack exited — not respawning; use `slack-grammar launch`",
				});
				return false;
			}
			log({
				event: "slack",
				msg: `slack exited abnormally (exit=${exitCode ?? "null"} signal=${signal ?? "none"}) — crash restart follows`,
			});
			// fall through: the restart budget below still applies
		}
		if (!requested && !slackOwned && restarts > 0) return false; // parked after giving up
		if (!requested && slackOwned && restarts >= 3) return false; // crashed too often — park
		const bin = findSlackBinary();
		if (!bin) {
			log({ event: "slack", level: "error", msg: "slack binary not found" });
			return false;
		}
		const port = await freePort();
		const { proc } = await launchSlack(bin, port, (msg) =>
			log({ event: "slack", msg }),
		);
		slackProc = proc;
		slackOwned = true;
		cdpPort = port;
		writeStateFile("cdp.port", String(port));
		if (requested) restarts = 0;
		else restarts++;
		return true;
	}

	async function supervise(): Promise<void> {
		const bundle = loadBundleSource();
		let backoffMs = 1000;
		while (running) {
			try {
				if (!(await ensureSlack())) {
					await sleep(2000);
					continue;
				}
				const version = (await (
					await fetch(`http://127.0.0.1:${cdpPort}/json/version`)
				).json()) as {
					webSocketDebuggerUrl: string;
				};
				conn = new CdpConnection(version.webSocketDebuggerUrl);
				await conn.connect();
				injector = new Injector(conn, bundle, {
					onRequest: (sid, req) => void onRequest(sid, req),
					onLog: (msg) => log({ event: "injector", msg }),
					onTargetAttached: () => {
						targets = injector?.targetCount ?? 0;
					},
					onTargetDetached: () => {
						targets = injector?.targetCount ?? 0;
					},
					onDisconnected: () => {
						disconnectedResolve?.();
					},
				});
				await injector.start();
				targets = injector.targetCount;
				backoffMs = 1000;
				log({
					event: "injector",
					msg: `connected to slack CDP (targets: ${targets})`,
				});
				await new Promise<void>((resolve) => {
					disconnectedResolve = resolve;
				});
				disconnectedResolve = null;
				injector.stop();
				conn.close();
				injector = null;
				conn = null;
				targets = 0;
				log({ event: "injector", msg: "disconnected from slack CDP" });
			} catch (e) {
				log({ event: "injector", level: "error", msg: String(e) });
			}
			await sleep(backoffMs);
			backoffMs = Math.min(backoffMs * 2, 10_000);
		}
	}

	const supervisePromise = supervise();

	return {
		status,
		async stop(): Promise<void> {
			running = false;
			disconnectedResolve?.();
			injector?.stop();
			conn?.close();
			server.stop(true);
			await supervisePromise.catch(() => undefined);
			// only remove our own pid file (a newer daemon may have taken over)
			if (readPid("daemon.pid") === process.pid) removeStateFile("daemon.pid");
			if (slackOwned && slackProc?.pid) {
				// leave Slack running: user keeps chatting, injection resumes on next launch
				log({ event: "shutdown", msg: "daemon stopped; slack left running" });
			}
			void llamaProc;
			process.exit(0);
		},
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
