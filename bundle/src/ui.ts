/** Floating suggestion widget + status glyph. Shadow DOM: styles stay isolated
 * from Slack and vice versa. All text set via textContent (never innerHTML). */
import type { DiffSeg } from "./diff.ts";

export interface SuggestionActions {
	onApply(): void;
	onIgnore(): void;
	onDismiss(): void;
}

const CSS = `
:host { all: initial; }
.sgw {
	position: fixed; z-index: 2147483647;
	max-width: 480px; padding: 0;
	background: #1a1d21; color: #d1d2d3;
	border: 1px solid #54585e; border-radius: 8px;
	box-shadow: 0 8px 24px rgba(0,0,0,.5);
	font: 13px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif;
}
.sgw-header {
	display: flex; align-items: center; gap: 6px;
	padding: 6px 10px; font-size: 11px; color: #9aa0a6;
	border-bottom: 1px solid #35373b; letter-spacing: .3px;
}
.sgw-dot { width: 7px; height: 7px; border-radius: 50%; background: #2eb67d; }
.sgw-close {
	margin-left: auto; border: 0; background: none; color: #9aa0a6;
	font-size: 14px; cursor: pointer; padding: 0 4px;
}
.sgw-close:hover { color: #fff; }
.sgw-diff { padding: 8px 10px; max-height: 180px; overflow-y: auto; }
.sgw-actions { display: flex; gap: 8px; padding: 8px 10px; border-top: 1px solid #35373b; }
.sgw-actions button {
	font: 600 12px/1 -apple-system, sans-serif; padding: 6px 12px;
	border-radius: 4px; border: 1px solid #54585e; cursor: pointer;
}
.sgw-apply { background: #007a5a; border-color: #007a5a; color: #fff; }
.sgw-apply:hover { background: #148567; }
.sgw-ignore { background: transparent; color: #d1d2d3; }
.sgw-ignore:hover { border-color: #9aa0a6; }
.sgw-copy { background: transparent; color: #9aa0a6; margin-left: auto; }
.sgw-copy:hover { border-color: #9aa0a6; color: #d1d2d3; }
.sgw .del { color: #ff7d92; text-decoration: line-through; }
.sgw .ins { color: #7ddba3; font-weight: 600; }
.sgw-flash { padding: 10px; color: #7ddba3; }
.sgw-glyph {
	position: fixed; z-index: 2147483647; width: 9px; height: 9px; border-radius: 50%;
	box-shadow: 0 0 6px currentColor;
}
.sgw-glyph.checking { background: #4aa3ff; animation: sgpulse 1s ease-in-out infinite; }
.sgw-glyph.error { background: #ff5c77; }
.sgw-glyph.off { background: #9aa0a6; }
@keyframes sgpulse { 50% { opacity: .35; } }
`;

let host: HTMLDivElement | null = null;
let shadow: ShadowRoot | null = null;

function ensureShadow(): void {
	if (host?.isConnected) return;
	host?.remove();
	host = document.createElement("div");
	host.id = "slack-grammar-widget";
	shadow = host.attachShadow({ mode: "open" });
	const style = document.createElement("style");
	style.textContent = CSS;
	shadow.append(style);
	document.body.append(host);
}

function positionAbove(composer: HTMLElement, card: HTMLElement): void {
	const r = composer.getBoundingClientRect();
	const w = Math.min(480, r.width);
	const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
	card.style.left = `${left}px`;
	card.style.width = `${w}px`;
	// prefer above the composer; fall back to below when no room
	card.style.visibility = "hidden";
	card.classList.remove("sgw");
	card.style.top = "0px";
	const h = card.offsetHeight;
	if (r.top > h + 12) card.style.top = `${r.top - h - 8}px`;
	else
		card.style.top = `${Math.min(r.bottom + 8, window.innerHeight - h - 8)}px`;
	card.classList.add("sgw");
	card.style.visibility = "";
}

export function hideSuggestion(): void {
	if (shadow) shadow.querySelectorAll(".sgw").forEach((e) => e.remove());
	host?.remove();
	host = null;
	shadow = null;
}

function renderDiff(container: HTMLElement, segs: DiffSeg[]): void {
	container.textContent = "";
	for (const seg of segs) {
		if (seg.type === "same") {
			container.append(document.createTextNode(seg.text));
			continue;
		}
		if (!seg.text.trim()) continue; // whitespace-only edits are noise
		const span = document.createElement("span");
		span.className = seg.type;
		span.textContent = seg.text.trim();
		container.append(span, document.createTextNode(" "));
	}
}

/** Copy the corrected text; never throws — button label reflects the outcome. */
async function copyToClipboard(text: string, btn: HTMLButtonElement): Promise<void> {
	let ok = false;
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			ok = true;
		}
	} catch {
		/* fall through to the legacy path */
	}
	if (!ok) {
		try {
			const ta = document.createElement("textarea");
			ta.value = text;
			ta.setAttribute("readonly", "");
			ta.style.position = "fixed";
			ta.style.opacity = "0";
			document.body.append(ta);
			ta.select();
			ok = document.execCommand("copy");
			ta.remove();
		} catch {
			ok = false;
		}
	}
	btn.textContent = ok ? "Copied" : "Copy failed";
	btn.disabled = true;
	setTimeout(() => {
		btn.textContent = "Copy";
		btn.disabled = false;
	}, 1400);
}

export function showSuggestion(opts: {
	composer: HTMLElement;
	original: string;
	corrected: string;
	segs: DiffSeg[];
	actions: SuggestionActions;
}): void {
	hideSuggestion();
	ensureShadow();
	const root = shadow as ShadowRoot;

	const card = document.createElement("div");
	card.className = "sgw";

	const header = document.createElement("div");
	header.className = "sgw-header";
	const dot = document.createElement("span");
	dot.className = "sgw-dot";
	header.append(dot, document.createTextNode("slack-grammar suggests"));
	const close = document.createElement("button");
	close.className = "sgw-close";
	close.textContent = "×";
	close.addEventListener("click", opts.actions.onDismiss);
	header.append(close);

	const diff = document.createElement("div");
	diff.className = "sgw-diff";
	renderDiff(diff, opts.segs);

	const actions = document.createElement("div");
	actions.className = "sgw-actions";
	const apply = document.createElement("button");
	apply.className = "sgw-apply";
	apply.textContent = "Apply fix";
	const ignore = document.createElement("button");
	ignore.className = "sgw-ignore";
	ignore.textContent = "Ignore";
	const copy = document.createElement("button");
	copy.className = "sgw-copy";
	copy.title = "Copy corrected text";
	copy.textContent = "Copy";
	actions.append(apply, ignore, copy);

	card.append(header, diff, actions);
	root.append(card);
	positionAbove(opts.composer, card);

	// keep the composer focused so Ctrl+Z works right after Apply
	card.addEventListener("mousedown", (e) => {
		if (!(e.target instanceof HTMLButtonElement)) e.preventDefault();
	});
	apply.addEventListener("click", opts.actions.onApply);
	ignore.addEventListener("click", opts.actions.onIgnore);
	copy.addEventListener("click", () => void copyToClipboard(opts.corrected, copy));
	apply.focus({ preventScroll: true });
}

export function showAppliedFlash(composer: HTMLElement): void {
	hideSuggestion();
	ensureShadow();
	const card = document.createElement("div");
	card.className = "sgw";
	const flash = document.createElement("div");
	flash.className = "sgw-flash";
	flash.textContent = "✓ applied — Ctrl+Z to undo";
	card.append(flash);
	(shadow as ShadowRoot).append(card);
	positionAbove(composer, card);
	setTimeout(hideSuggestion, 1600);
}

let glyph: HTMLDivElement | null = null;

export function setStatus(
	status: "checking" | "error" | "off" | "idle",
	composer?: HTMLElement | null,
): void {
	if (status === "idle") {
		glyph?.remove();
		glyph = null;
		return;
	}
	if (!composer) return;
	if (!glyph?.isConnected) {
		glyph = document.createElement("div");
		document.body.append(glyph);
	}
	glyph.className = `sgw-glyph ${status}`;
	const r = composer.getBoundingClientRect();
	glyph.style.left = `${Math.min(r.right - 12, window.innerWidth - 14)}px`;
	glyph.style.top = `${Math.max(6, r.top - 12)}px`;
}
