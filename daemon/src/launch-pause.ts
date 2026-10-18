/** PID-scoped launch inhibition while the reinjection helper quits Slack. */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	isPidAlive,
	readPid,
	readStateFile,
	stateDir,
	writeStateFile,
} from "./runtime.ts";

const REQUEST = "launch-pause.pid";
const ACK = "launch-paused";

export interface LaunchPauseState {
	readPid(name: string): number | null;
	readStateFile(name: string): string | null;
	writeStateFile(name: string, content: string): void;
	isPidAlive(pid: number): boolean;
}

const runtimeState: LaunchPauseState = {
	readPid,
	readStateFile,
	writeStateFile,
	isPidAlive,
};

export class LaunchPause {
	private pending = 0;

	constructor(
		private state: LaunchPauseState = runtimeState,
		private daemonPid = process.pid,
	) {}

	private requester(): number | null {
		const pid = this.state.readPid(REQUEST);
		return pid !== null && this.state.isPidAlive(pid) ? pid : null;
	}

	/** An acknowledgement means even a launch already in progress has settled. */
	acknowledge(): void {
		try {
			const pid = this.requester();
			if (pid === null || this.pending > 0) return;
			const token = `${pid}:${this.daemonPid}`;
			if (this.state.readStateFile(ACK) !== token)
				this.state.writeStateFile(ACK, token);
		} catch {
			// Fail closed: the helper must see an acknowledgement before quitting Slack.
		}
	}

	async launch<T>(launch: () => Promise<T>): Promise<T | undefined> {
		if (this.requester() !== null) {
			this.acknowledge();
			return undefined;
		}
		this.pending++;
		try {
			return await launch();
		} finally {
			this.pending--;
			this.acknowledge();
		}
	}
}

/** Exclusive ownership prevents concurrent helpers from resuming each other. */
export function requestLaunchPause(directory = stateDir): () => void {
	mkdirSync(directory, { recursive: true });
	const path = join(directory, REQUEST);
	const owner = String(process.pid);
	try {
		writeFileSync(path, owner, { flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		throw new Error(
			`reinjection lock already exists: ${path}; wait for the other helper, or remove this file if that helper is no longer running`,
		);
	}
	const release = () => {
		if (readFileSync(path, "utf8") === owner) rmSync(path);
	};
	try {
		// Never accept an acknowledgement left by an earlier helper with a reused PID.
		rmSync(join(directory, ACK), { force: true });
	} catch (error) {
		release();
		throw error;
	}
	return release;
}

export function launchPauseAcknowledged(
	requesterPid = process.pid,
	state: LaunchPauseState = runtimeState,
): boolean {
	const daemonPid = state.readPid("daemon.pid");
	return (
		daemonPid === null ||
		!state.isPidAlive(daemonPid) ||
		state.readStateFile(ACK) === `${requesterPid}:${daemonPid}`
	);
}
