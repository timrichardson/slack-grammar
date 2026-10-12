/**
 * CDP connection + injector: attaches to every page target in Slack, injects
 * the bundle on every new document, and routes binding messages both ways.
 * Handles reconnects with backoff; callers own Slack process lifecycle.
 */
import { existsSync, readFileSync } from "node:fs";
import {
	BINDING_NAME,
	RECEIVE_FN,
	type Request,
	type Response,
	makeResponse,
	parseRequest,
} from "./protocol.ts";
import { bundlePath } from "./runtime.ts";

interface CdpEvent {
	method: string;
	params: Record<string, unknown>;
	sessionId?: string;
}

interface CdpIncoming {
	id?: number;
	result?: unknown;
	error?: { message: string };
	method?: string;
	params?: Record<string, unknown>;
	sessionId?: string;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class CdpConnection {
	private ws: WebSocket | null = null;
	private nextId = 0;
	private pending = new Map<number, Pending>();
	private handlers = new Set<(e: CdpEvent) => void>();
	open = false;

	constructor(private browserWsUrl: string) {}

	onEvent(handler: (e: CdpEvent) => void): () => void {
		this.handlers.add(handler);
		return () => this.handlers.delete(handler);
	}

	async connect(): Promise<void> {
		const ws = new WebSocket(this.browserWsUrl);
		ws.onmessage = (ev: MessageEvent) =>
			this.dispatch(JSON.parse(String(ev.data)));
		ws.onclose = () => {
			this.open = false;
			for (const p of this.pending.values())
				p.reject(new Error("cdp: connection closed"));
			this.pending.clear();
			for (const h of [...this.handlers])
				h({ method: "__disconnected", params: {} });
		};
		await new Promise<void>((resolve, reject) => {
			ws.onopen = () => resolve();
			ws.onerror = () =>
				reject(new Error(`cdp: cannot open ${this.browserWsUrl}`));
		});
		this.ws = ws;
		this.open = true;
	}

	close(): void {
		this.open = false;
		this.ws?.close();
		this.ws = null;
	}

	private dispatch(msg: CdpIncoming): void {
		if (msg.id !== undefined && this.pending.has(msg.id)) {
			const p = this.pending.get(msg.id) as Pending;
			this.pending.delete(msg.id);
			if (msg.error) p.reject(new Error(`cdp: ${msg.error.message}`));
			else p.resolve(msg.result);
			return;
		}
		if (msg.method) {
			const e: CdpEvent = {
				method: msg.method,
				params: msg.params ?? {},
				sessionId: msg.sessionId,
			};
			for (const h of [...this.handlers]) h(e);
		}
	}

	send(
		method: string,
		params: Record<string, unknown> = {},
		sessionId?: string,
	): Promise<unknown> {
		if (!this.open) return Promise.reject(new Error("cdp: not connected"));
		const id = ++this.nextId;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			const payload: Record<string, unknown> = { id, method, params };
			if (sessionId) payload.sessionId = sessionId;
			(this.ws as WebSocket).send(JSON.stringify(payload));
		});
	}
}

export interface InjectorEvents {
	onTargetAttached?: (sessionId: string, targetUrl: string) => void;
	onTargetDetached?: (sessionId: string) => void;
	onRequest?: (sessionId: string, request: Request) => void;
	onDisconnected?: () => void;
	onLog?: (msg: string) => void;
}

export class Injector {
	private targets = new Map<string, string>(); // sessionId -> targetUrl
	private offEvent: (() => void) | null = null;

	constructor(
		private conn: CdpConnection,
		private bundleSource: string,
		private events: InjectorEvents = {},
	) {}

	/** Auto-attach to all current and future page targets. */
	async start(): Promise<void> {
		this.offEvent = this.conn.onEvent((e) => this.handleEvent(e));
		await this.conn.send("Target.setAutoAttach", {
			autoAttach: true,
			waitForDebuggerOnStart: false,
			flatten: true,
			filter: [{ type: "page" }],
		});
	}

	stop(): void {
		this.offEvent?.();
		this.offEvent = null;
		this.targets.clear();
	}

	get targetCount(): number {
		return this.targets.size;
	}

	/** Push a response down to a specific target's bundle. */
	async respond(sessionId: string, response: Response): Promise<void> {
		const expr = `window.${RECEIVE_FN} && window.${RECEIVE_FN}(${JSON.stringify(JSON.stringify(response))})`;
		await this.conn
			.send(
				"Runtime.evaluate",
				{ expression: expr, returnByValue: true },
				sessionId,
			)
			.catch((e) => this.events.onLog?.(`respond failed: ${e.message}`));
	}

	private async handleEvent(e: CdpEvent): Promise<void> {
		if (e.method === "Target.attachedToTarget") {
			const { sessionId, targetInfo } = e.params as {
				sessionId: string;
				targetInfo: { url?: string };
			};
			if (this.targets.has(sessionId)) return;
			this.targets.set(sessionId, targetInfo?.url ?? "");
			this.events.onLog?.(`target attached: ${targetInfo?.url ?? "(no url)"}`);
			this.events.onTargetAttached?.(sessionId, targetInfo?.url ?? "");
			try {
				await this.conn.send("Page.enable", {}, sessionId);
				await this.conn.send("Runtime.enable", {}, sessionId);
				await this.conn.send(
					"Page.addScriptToEvaluateOnNewDocument",
					{ source: this.bundleSource },
					sessionId,
				);
				await this.conn.send(
					"Runtime.addBinding",
					{ name: BINDING_NAME },
					sessionId,
				);
				// For pages already loaded, evaluate now (bundle self-guards against double-injection).
				await this.conn
					.send(
						"Runtime.evaluate",
						{ expression: this.bundleSource, returnByValue: true },
						sessionId,
					)
					.catch(() => undefined);
			} catch (err) {
				this.events.onLog?.(`session setup failed: ${(err as Error).message}`);
				this.targets.delete(sessionId);
			}
			return;
		}
		if (e.method === "Target.detachedFromTarget") {
			const { sessionId } = e.params as { sessionId: string };
			if (this.targets.delete(sessionId))
				this.events.onTargetDetached?.(sessionId);
			return;
		}
		if (e.method === "Runtime.bindingCalled") {
			const { name, payload } = e.params as { name: string; payload: string };
			if (name !== BINDING_NAME || !e.sessionId) return;
			const req = parseRequest(payload);
			if (req) this.events.onRequest?.(e.sessionId, req);
			else if (e.sessionId)
				this.respond(
					e.sessionId,
					makeResponse({ v: 1, id: "?", type: "ping" }, "error", "bad request"),
				);
		}
		if (e.method === "__disconnected") {
			this.targets.clear();
			this.events.onDisconnected?.();
		}
	}
}

export function loadBundleSource(): string {
	const p = bundlePath();
	if (!existsSync(p))
		throw new Error(`bundle not built: ${p} — run bun run build:bundle`);
	return readFileSync(p, "utf8");
}
