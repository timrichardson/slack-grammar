/**
 * The apply-fix path validated in Phase 0: native editing commands keep
 * Slack's draft state and the undo stack consistent. Async DOM reads must
 * wait a frame before trusting state.
 */

export function placeCaretEnd(el: HTMLElement): void {
	const sel = window.getSelection();
	if (!sel) return;
	const range = document.createRange();
	range.selectNodeContents(el);
	range.collapse(false);
	sel.removeAllRanges();
	sel.addRange(range);
}

/** Replace the whole composer content. Returns false when it would eat text. */
export function replaceComposerText(
	composer: HTMLElement,
	newText: string,
): boolean {
	if (!newText.trim()) return false; // never eat the text
	composer.focus();
	placeCaretEnd(composer);
	document.execCommand("selectAll");
	document.execCommand("insertText", false, newText);
	return true;
}

export function nextFrame(): Promise<void> {
	return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export async function composerTextAfterEdit(
	composer: HTMLElement,
): Promise<string> {
	await nextFrame();
	return composer.innerText;
}
