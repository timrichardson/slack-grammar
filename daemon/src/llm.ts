import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { ChatMessage } from "./prompt.ts";

export interface ChatResult {
	content: string;
	promptTokens?: number;
	completionTokens?: number;
}

/** Thin OpenAI-compatible client for llama-server. */
export class LlmClient {
	constructor(
		private base: string,
		private timeoutMs: number,
	) {}

	async health(): Promise<boolean> {
		try {
			const r = await fetch(`${this.base}/health`, {
				signal: AbortSignal.timeout(1000),
			});
			return r.ok;
		} catch {
			return false;
		}
	}

	async chat(
		messages: ChatMessage[],
		maxTokens: number,
		signal?: AbortSignal,
	): Promise<ChatResult> {
		const res = await fetch(`${this.base}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				messages,
				temperature: 0,
				max_tokens: maxTokens,
				cache_prompt: true, // llama-server: reuse KV for shared few-shot prefix
				// Qwen3+/Qwen3.5 think by default; without this their output lands in
				// reasoning_content and content comes back empty. Templates without
				// this variable simply ignore it.
				chat_template_kwargs: { enable_thinking: false },
			}),
			signal: signal ?? AbortSignal.timeout(this.timeoutMs),
		});
		if (!res.ok) throw new Error(`llama-server HTTP ${res.status}`);
		const j = (await res.json()) as {
			choices?: { message?: { content?: string } }[];
			usage?: { prompt_tokens?: number; completion_tokens?: number };
		};
		return {
			content: (j.choices?.[0]?.message?.content ?? "").trim(),
			promptTokens: j.usage?.prompt_tokens,
			completionTokens: j.usage?.completion_tokens,
		};
	}
}

/** Spawn llama-server if nothing healthy is listening; reuse if there is (dev mode). */
export async function ensureLlamaServer(
	cfg: Config,
	log: (msg: string) => void,
): Promise<ChildProcess | null> {
	const base = `http://${cfg.llm.host}:${cfg.llm.port}`;
	const client = new LlmClient(base, cfg.gateway.timeoutMs);
	if (await client.health()) {
		log(`llama-server already healthy at ${base} (reusing)`);
		return null;
	}

	const bin = join(cfg.llm.llamaBinDir, "llama-server");
	if (!existsSync(bin))
		throw new Error(
			`llama-server not found at ${bin} — run scripts/install-llama.sh`,
		);
	if (!existsSync(cfg.llm.modelPath))
		throw new Error(
			`model not found at ${cfg.llm.modelPath} — run scripts/pull-model.sh`,
		);

	const args = [
		"-m",
		cfg.llm.modelPath,
		"-ngl",
		String(cfg.llm.ngl),
		"-c",
		String(cfg.llm.ctx),
		"--host",
		cfg.llm.host,
		"--port",
		String(cfg.llm.port),
	];
	if (cfg.llm.flashAttn) args.push("-fa", "1");
	args.push(...cfg.llm.extraArgs);

	log(
		`starting llama-server on ${base} (${join(cfg.llm.modelPath.split("/").pop() ?? "")})`,
	);
	const proc = spawn(bin, args, {
		env: {
			...process.env,
			LD_LIBRARY_PATH: cfg.llm.llamaBinDir,
			...(cfg.llm.vkDevice !== null
				? { GGML_VK_VISIBLE_DEVICES: String(cfg.llm.vkDevice) }
				: {}),
		},
		stdio: ["ignore", "ignore", "inherit"],
	});

	const deadline = Date.now() + cfg.llm.startupTimeoutMs;
	while (Date.now() < deadline) {
		if (proc.exitCode !== null)
			throw new Error(`llama-server exited with code ${proc.exitCode}`);
		if (await client.health()) {
			log("llama-server healthy");
			return proc;
		}
		await new Promise((r) => setTimeout(r, 300));
	}
	proc.kill("SIGTERM");
	throw new Error("llama-server did not become healthy in time");
}
