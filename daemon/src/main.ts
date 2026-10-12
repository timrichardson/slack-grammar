import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { Checker, startGateway } from "./gateway.ts";
import { LlmClient, ensureLlamaServer } from "./llm.ts";

const log = (e: Record<string, unknown>) =>
	console.log(JSON.stringify({ ts: new Date().toISOString(), ...e }));

async function doctor(): Promise<number> {
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

	const llm = new LlmClient(
		`http://${cfg.llm.host}:${cfg.llm.port}`,
		cfg.gateway.timeoutMs,
	);
	checks.push({
		name: "llama-server health",
		ok: await llm.health(),
		detail: `http://${cfg.llm.host}:${cfg.llm.port}`,
	});

	let gatewayOk = false;
	try {
		const r = await fetch(
			`http://${cfg.gateway.host}:${cfg.gateway.port}/health`,
			{
				signal: AbortSignal.timeout(1000),
			},
		);
		gatewayOk = r.ok;
	} catch {
		/* not running */
	}
	checks.push({
		name: "gateway health",
		ok: gatewayOk,
		detail: gatewayOk
			? `http://${cfg.gateway.host}:${cfg.gateway.port} (running)`
			: `http://${cfg.gateway.host}:${cfg.gateway.port} (not running — normal unless daemon started)`,
	});

	for (const c of checks)
		console.log(`${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
	const failed = checks.filter(
		(c) => !c.ok && c.name !== "gateway health",
	).length;
	console.log(failed === 0 ? "doctor: OK" : `doctor: ${failed} problem(s)`);
	return failed === 0 ? 0 : 1;
}

async function start(): Promise<void> {
	const cfg = loadConfig();
	let llamaProc = null;
	try {
		llamaProc = await ensureLlamaServer(cfg, (msg) =>
			log({ event: "llama", msg }),
		);
	} catch (e) {
		log({ event: "llama", level: "error", msg: String(e) });
		process.exit(1);
	}

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

	const shutdown = () => {
		log({ event: "shutdown" });
		server.stop(true);
		llamaProc?.kill("SIGTERM");
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

const cmd = process.argv[2] ?? "start";
if (cmd === "doctor") process.exit(await doctor());
else if (cmd === "start") await start();
else {
	console.error("usage: slack-grammar [start|doctor]");
	process.exit(2);
}
