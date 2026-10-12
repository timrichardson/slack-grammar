// slack-grammar injected bundle — Phase 2: transport layer.
// Talks to the daemon exclusively through the CDP binding (no network).
// Phase 3 layers the composer watcher + diff UI on top of __sg.call().

declare global {
	interface Window {
		__slackGrammar?: (payload: string) => void;
		__slackGrammarReceive?: (payload: string) => void;
		__sg?: SgBridge;
	}
}

interface ProtocolMessage {
	v: 1;
	id: string;
	type: string;
	data?: unknown;
	error?: string;
}

interface SgBridge {
	call(type: string, text?: string): Promise<unknown>;
	connected: boolean;
}

(() => {
	if (window.__sg) return; // double-injection guard (new document + manual eval)

	const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
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

	const call = (type: string, text?: string): Promise<unknown> =>
		new Promise((resolve, reject) => {
			const id = `sg${++seq}`;
			pending.set(id, { resolve, reject });
			// timeout: never leave the UI hanging if the daemon is gone
			setTimeout(() => {
				if (pending.has(id)) {
					pending.delete(id);
					reject(new Error("slack-grammar: daemon timeout"));
				}
			}, 5000);
			window.__slackGrammar?.(JSON.stringify({ v: 1, id, type, text }));
		});

	const bridge: SgBridge = {
		call,
		connected: false,
	};
	window.__sg = bridge;

	// announce ourselves; proves the full binding round-trip on every page load
	call("hello")
		.then(() => {
			bridge.connected = true;
			console.info("[slack-grammar] bridge ready");
		})
		.catch((e: Error) => console.info(`[slack-grammar] bridge offline: ${e.message}`));
})();
