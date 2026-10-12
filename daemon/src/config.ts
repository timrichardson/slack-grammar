import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";

export const repoRoot = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);

export interface Config {
	llm: {
		llamaBinDir: string;
		modelPath: string;
		host: string;
		port: number;
		ngl: number;
		ctx: number;
		flashAttn: boolean;
		vkDevice: number | null; // null = let Vulkan pick (device 0)
		extraArgs: string[];
		startupTimeoutMs: number;
	};
	gateway: {
		host: string;
		port: number;
		timeoutMs: number;
		cacheTtlMs: number;
		cacheMax: number;
	};
	check: {
		minWords: number;
		maxChars: number;
		maxDiffRatio: number;
		maxDiffTokens: number;
	};
}

export function defaultConfig(): Config {
	return {
		llm: {
			llamaBinDir: join(repoRoot, "vendor", "llama-b11559"),
			modelPath: join(repoRoot, "models", "Qwen3-4B-Instruct-2507-Q4_K_M.gguf"),
			host: "127.0.0.1",
			port: 8080,
			ngl: 99,
			ctx: 4096,
			flashAttn: true,
			vkDevice: null,
			extraArgs: [],
			startupTimeoutMs: 120_000,
		},
		gateway: {
			host: "127.0.0.1",
			port: 8765,
			timeoutMs: 3000,
			cacheTtlMs: 10 * 60_000,
			cacheMax: 200,
		},
		check: {
			minWords: 3,
			maxChars: 4000,
			maxDiffRatio: 0.4,
			maxDiffTokens: 8,
		},
	};
}

function deepMerge<T>(base: T, patch: unknown): T {
	if (patch === undefined || patch === null) return base;
	if (typeof base !== "object" || base === null || Array.isArray(base))
		return patch as T;
	const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
		out[k] = deepMerge((base as Record<string, unknown>)[k], v);
	}
	return out as T;
}

export function loadConfig(path?: string): Config {
	const p =
		path ??
		process.env.SLACK_GRAMMAR_CONFIG ??
		join(process.env.HOME ?? "~", ".config", "slack-grammar", "config.toml");
	if (!existsSync(p)) return defaultConfig();
	const merged = deepMerge(defaultConfig(), parse(readFileSync(p, "utf8")));
	return merged as Config;
}
