/**
 * Native editing commands keep Slack's draft state and undo history in sync.
 * Never trust their return value alone: Slack can reconcile the DOM later.
 */
import {
	APPLY_INTERRUPTS,
	type ApplyDiagnostic,
	type ApplyOutcome,
} from "../../shared/apply-diagnostic.ts";

const applyingComposers = new WeakSet<HTMLElement>();

export function placeCaretEnd(el: HTMLElement): void {
	const sel = el.ownerDocument.getSelection();
	if (!sel) return;
	const range = el.ownerDocument.createRange();
	range.selectNodeContents(el);
	range.collapse(false);
	sel.removeAllRanges();
	sel.addRange(range);
}

export type ApplyResult = ApplyOutcome;

function sameText(a: string, b: string): boolean {
	// Quill keeps an editor-final newline; CRLF and LF are equivalent here.
	return (
		a.replace(/\r\n?/g, "\n").trimEnd() === b.replace(/\r\n?/g, "\n").trimEnd()
	);
}

/**
 * Replace only a still-current draft. If editing fails, undo our own edit;
 * never overwrite newer user input or try to repair Slack with innerHTML.
 */
export async function replaceComposerText(
	composer: HTMLElement,
	newText: string,
	original: string,
	report?: (diagnostic: ApplyDiagnostic) => void,
): Promise<ApplyResult> {
	if (applyingComposers.has(composer)) return "unchanged";
	// Take the recovery copy NOW, not from the earlier model request. Only keep
	// it in this transaction's memory; a stale suggestion must still be refused.
	const snapshot = composer.innerText;
	if (
		typeof newText !== "string" ||
		!newText.trim() ||
		!composer.isConnected ||
		!composer.isContentEditable ||
		snapshot !== original
	)
		return "unchanged";

	applyingComposers.add(composer);
	const doc = composer.ownerDocument;
	const started = Date.now();
	let editing = false;
	let interrupted = false;
	let interruptEvent: ApplyDiagnostic["interruptEvent"];
	let selected = false;
	let outcome: ApplyResult = "failed";
	const emit = (stage: ApplyDiagnostic["stage"]) => {
		try {
			const current = composer.innerText;
			report?.({
				stage,
				...(stage === "finish" ? { outcome } : {}),
				beforeChars: snapshot.length,
				afterChars: current.length,
				connected: composer.isConnected,
				focused: doc.activeElement === composer,
				interrupted,
				interruptEvent,
				empty: !current.trim(),
				elapsedMs: Date.now() - started,
			});
		} catch {
			/* diagnostics must never interfere with editing */
		}
	};
	const finish = (result: ApplyResult): ApplyResult => {
		outcome = result;
		return result;
	};
	const safeToEdit = () =>
		!interrupted &&
		composer.isConnected &&
		composer.isContentEditable &&
		doc.activeElement === composer;
	const releaseSelection = () => {
		try {
			if (safeToEdit()) placeCaretEnd(composer);
		} catch {
			/* a selection failure must not bypass draft recovery */
		}
	};
	// Watch the whole document: neither typing elsewhere nor a Send gesture
	// during reconciliation may be followed by undoing a different transaction.
	const onInput = (event: Event) => {
		if (!editing) {
			interrupted = true;
			interruptEvent ??= event.type as ApplyDiagnostic["interruptEvent"];
		}
	};
	for (const event of APPLY_INTERRUPTS)
		doc.addEventListener(event, onInput, true);
	try {
		emit("snapshot");
		composer.focus({ preventScroll: true });
		if (doc.activeElement !== composer || composer.innerText !== original)
			return finish("unchanged");
		const sel = doc.getSelection();
		if (!sel) return finish("unchanged");
		// A document-wide selectAll can escape the editor after a focus race.
		const range = doc.createRange();
		range.selectNodeContents(composer);
		selected = true;
		sel.removeAllRanges();
		sel.addRange(range);
		if (
			!safeToEdit() ||
			!composer.contains(sel.anchorNode) ||
			!composer.contains(sel.focusNode) ||
			doc.activeElement !== composer ||
			composer.innerText !== original
		)
			return finish("unchanged");

		let inserted = false;
		try {
			editing = true;
			inserted = doc.execCommand("insertText", false, newText);
		} catch {
			// Even a throwing command may already have deleted the selection.
		} finally {
			editing = false;
		}
		// Release the replacement range BEFORE yielding. Even a failed native
		// command must not leave a full-draft selection for the next keystroke.
		releaseSelection();
		emit("insert");
		await settleEdit();
		emit("verify");
		if (!safeToEdit()) return finish("interrupted");
		if (inserted && sameText(composer.innerText, newText))
			return finish("applied");
		if (composer.innerText === snapshot) return finish("unchanged");

		// No intervening input: this is still our transaction at the top of undo.
		try {
			editing = true;
			doc.execCommand("undo");
		} catch {
			// Undo can fail too. An empty editor may still be repaired below.
		} finally {
			editing = false;
		}
		releaseSelection();
		await settleEdit();
		emit("undo");
		if (!safeToEdit()) return finish("interrupted");
		if (composer.innerText === snapshot) return finish("restored");
		// Undo is not a sufficient safety net: if it also leaves an empty draft,
		// restore the click-time snapshot through the same native editing path.
		// Never replace nonempty/unrecognized contents, or retry the correction.
		if (!composer.innerText.trim()) {
			const recoveryRange = doc.createRange();
			recoveryRange.selectNodeContents(composer);
			sel.removeAllRanges();
			sel.addRange(recoveryRange);
			if (
				!safeToEdit() ||
				!composer.contains(sel.anchorNode) ||
				!composer.contains(sel.focusNode) ||
				composer.innerText.trim()
			)
				return finish("interrupted");
			try {
				editing = true;
				doc.execCommand("insertText", false, snapshot);
			} catch {
				/* verify even a throwing command */
			} finally {
				editing = false;
			}
			releaseSelection();
			await settleEdit();
			emit("restore");
			if (!safeToEdit()) return finish("interrupted");
			if (sameText(composer.innerText, snapshot)) return finish("restored");
		}
		return finish("failed");
	} catch {
		return finish("failed");
	} finally {
		emit("finish");
		applyingComposers.delete(composer);
		for (const event of APPLY_INTERRUPTS)
			doc.removeEventListener(event, onInput, true);
		// A refused edit/undo must not leave the entire draft selected: the next
		// keystroke would otherwise replace it. Never move a user's newer caret.
		if (
			selected &&
			!interrupted &&
			composer.isConnected &&
			doc.activeElement === composer &&
			composer.innerText === original
		) {
			try {
				placeCaretEnd(composer);
			} catch {
				/* fail soft */
			}
		}
	}
}

export function nextFrame(): Promise<void> {
	return new Promise((resolve) => {
		// rAF pauses in background windows; never leave Apply stuck indefinitely.
		const timer = setTimeout(() => {
			cancelAnimationFrame(frame);
			resolve();
		}, 100);
		const frame = requestAnimationFrame(() => {
			clearTimeout(timer);
			resolve();
		});
	});
}

async function settleEdit(): Promise<void> {
	await nextFrame();
	await nextFrame();
	// Quill/React may reconcile after the first paint. Keep watching input and
	// verify beyond two frames, also when rAF is suspended in the background.
	await new Promise((resolve) => setTimeout(resolve, 250));
	await nextFrame();
}

export async function composerTextAfterEdit(
	composer: HTMLElement,
): Promise<string> {
	await nextFrame();
	return composer.innerText;
}
