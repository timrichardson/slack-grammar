/** Runtime state: pid/port files under XDG_STATE_HOME/slack-grammar. */
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./config.ts";

export const stateDir = process.env.XDG_STATE_HOME
	? join(process.env.XDG_STATE_HOME, "slack-grammar")
	: join(process.env.HOME ?? "~", ".local", "state", "slack-grammar");

export function initStateDir(): void {
	if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
}

export function writeStateFile(name: string, content: string): void {
	initStateDir();
	writeFileSync(join(stateDir, name), content);
}

export function readStateFile(name: string): string | null {
	const p = join(stateDir, name);
	if (!existsSync(p)) return null;
	return readFileSync(p, "utf8");
}

export function removeStateFile(name: string): void {
	rmSync(join(stateDir, name), { force: true });
}

export function writePid(name: string, pid: number): void {
	writeStateFile(name, String(pid));
}

export function readPid(name: string): number | null {
	const v = readStateFile(name);
	const n = v ? Number.parseInt(v, 10) : Number.NaN;
	return Number.isInteger(n) ? n : null;
}

export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function bundlePath(): string {
	return join(repoRoot, "bundle", "dist", "slack-grammar-bundle.js");
}
