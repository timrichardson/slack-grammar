// slack-grammar injected bundle.
// Transport: CDP binding only (no network from Slack's page).
// UX: composer watcher + floating diff widget.

import { BUNDLE_VERSION } from "../../shared/bundle-version.ts";
import { type WatcherState, startWatcher } from "./composer.ts";
import { type CheckSettings, applyConfig } from "./rules.ts";

declare global {
	interface Window {
		__slackGrammar?: (payload: string) => void;
		__slackGrammarReceive?: (payload: string) => void;
		__sg?: {
			call(type: string, text?: string, data?: unknown): Promise<unknown>;
			connected: boolean;
			version?: string;
			watcher?: WatcherState;
		};
	}
}

interface ProtocolMessage {
	v: 1;
	id: string;
	type: string;
	data?: unknown;
	error?: string;
}

(() => {
	const w = window as Window & { __sgBundleVersion?: string };
	if (w.__sgBundleVersion === BUNDLE_VERSION) return; // same version: no double-inject
	w.__sgBundleVersion = BUNDLE_VERSION; // newer version: take over from an older bundle

	const pending = new Map<
		string,
		{ resolve: (v: unknown) => void; reject: (e: Error) => void }
	>();
	let seq = 0;

	window.__slackGrammarReceive = (payload: string) => {
		try {
			const m = JSON.parse(payload) as ProtocolMessage;
			const p = pending.get(m.id);
			if (!p) return;
			pending.delete(m.id);
			if (m.type === "error") p.reject(new Error(m.error ?? "daemon error"));
			else p.resolve(m.data);
		} catch {
			/* ignore malformed */
		}
	};

	const call = (
		type: string,
		text?: string,
		data?: unknown,
	): Promise<unknown> =>
		new Promise((resolve, reject) => {
			const id = `sg${++seq}`;
			pending.set(id, { resolve, reject });
			setTimeout(() => {
				if (pending.has(id)) {
					pending.delete(id);
					reject(new Error("slack-grammar: daemon timeout"));
				}
			}, 5000);
			window.__slackGrammar?.(JSON.stringify({ v: 1, id, type, text, data }));
		});

	const bridge: NonNullable<Window["__sg"]> = {
		call,
		connected: false,
		version: BUNDLE_VERSION,
	};
	window.__sg = bridge;

	call("hello")
		.then((data) => {
			bridge.connected = true;
			// daemon-provided config overrides bundle defaults
			try {
				applyConfig(
					(data as { config?: Partial<CheckSettings> } | undefined)?.config,
				);
			} catch {
				/* keep defaults */
			}
			// UX layer starts only once the daemon answered — fail soft, never break Slack
			try {
				bridge.watcher = startWatcher(bridge);
			} catch (e) {
				console.info(
					`[slack-grammar] watcher failed to start: ${(e as Error).message}`,
				);
			}
			console.info("[slack-grammar] bridge ready");
		})
		.catch((e: Error) =>
			console.info(`[slack-grammar] bridge offline: ${e.message}`),
		);
})();
