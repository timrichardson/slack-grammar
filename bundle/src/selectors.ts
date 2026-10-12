/**
 * All Slack DOM knowledge lives here (single point of breakage when Slack
 * updates). Everything feature-detected; callers handle null gracefully.
 */

export const SELECTORS = {
	composer: 'div[role="textbox"][data-qa="texty_input"]',
	sendButton: '[data-qa="texty_send_button"]',
} as const;

export function isComposer(el: EventTarget | null): HTMLElement | null {
	if (!(el instanceof HTMLElement)) return null;
	if (el.role === "textbox" && el.dataset.qa === "texty_input") return el;
	return el.closest<HTMLElement>(SELECTORS.composer);
}

export function findComposer(): HTMLElement | null {
	return document.querySelector<HTMLElement>(SELECTORS.composer);
}

/** A stable-enough anchor to position the widget: the composer's scroll container. */
export function composerAnchor(composer: HTMLElement): HTMLElement {
	return (
		composer.closest("[data-qa=" + '"message-pane"' + "]")?.parentElement ??
		composer.parentElement ??
		composer
	);
}

/** True when the caret sits inside a `code`/pre element of the composer. */
export function caretInCode(composer: HTMLElement): boolean {
	const sel = window.getSelection();
	if (!sel || !sel.rangeCount) return false;
	let node: Node | null = sel.anchorNode;
	while (node && node !== composer) {
		if (
			node instanceof Element &&
			(node.tagName === "CODE" || node.tagName === "PRE")
		)
			return true;
		node = node.parentElement;
	}
	return false;
}
