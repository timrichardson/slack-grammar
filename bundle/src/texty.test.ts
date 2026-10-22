import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ApplyDiagnostic } from "../../shared/apply-diagnostic.ts";
import { replaceComposerText } from "./texty.ts";

// A deliberately small editing host: command failures and reconciliation races
// must be testable without Slack, a model, or any real message contents.
const original = "we was testing the checker";
const corrected = "we were testing the checker";
let doc: Document;
let composer: HTMLElement;
let active: HTMLElement | null;
let text: string;
let connected: boolean;
let editable: boolean;
let focusWorks: boolean;
let selectionWorks: boolean;
let commands: string[];
let command: (name: string, value?: string) => boolean;
let reconcile: (() => void) | undefined;
let listeners: Map<string, Set<(event: Event) => void>>;
let rangeTarget: Node | null;
let collapsed: boolean;
let globals: Map<string, PropertyDescriptor | undefined>;

function input(): void {
	for (const listener of listeners.get("input") ?? [])
		listener(new Event("input"));
}

beforeEach(() => {
	text = original;
	connected = editable = focusWorks = selectionWorks = true;
	commands = [];
	listeners = new Map();
	rangeTarget = null;
	collapsed = false;
	reconcile = undefined;
	const selection = {
		anchorNode: null as Node | null,
		focusNode: null as Node | null,
		removeAllRanges() {
			this.anchorNode = this.focusNode = null;
		},
		addRange() {
			this.anchorNode = this.focusNode = selectionWorks ? rangeTarget : null;
		},
	};
	command = (name, value) => {
		text = name === "undo" ? original : (value ?? text);
		input();
		return true;
	};
	doc = {
		get activeElement() {
			return active;
		},
		getSelection: () => selection,
		createRange: () => ({
			selectNodeContents: (node: Node) => {
				rangeTarget = node;
			},
			collapse: () => {
				collapsed = true;
			},
		}),
		execCommand: (name: string, _ui?: boolean, value?: string) => {
			commands.push(name);
			return command(name, value);
		},
		addEventListener: (name: string, listener: (event: Event) => void) => {
			if (!listeners.has(name)) listeners.set(name, new Set());
			listeners.get(name)?.add(listener);
		},
		removeEventListener: (name: string, listener: (event: Event) => void) => {
			listeners.get(name)?.delete(listener);
		},
	} as unknown as Document;
	composer = {
		get innerText() {
			return text;
		},
		get isConnected() {
			return connected;
		},
		get isContentEditable() {
			return editable;
		},
		ownerDocument: doc,
		contains: (node: Node | null) => node === (composer as unknown as Node),
		focus: () => {
			if (focusWorks) active = composer;
		},
	} as unknown as HTMLElement;
	active = composer;
	globals = new Map();
	for (const [name, value] of Object.entries({
		requestAnimationFrame: (callback: FrameRequestCallback) =>
			setTimeout(() => {
				const next = reconcile;
				reconcile = undefined;
				next?.();
				callback(0);
			}, 0),
		cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) =>
			clearTimeout(id),
	})) {
		globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, value });
	}
});

afterEach(() => {
	for (const [name, descriptor] of globals) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
	expect([...listeners.values()].every((set) => set.size === 0)).toBe(true);
});

test("verified replacement uses an editor-scoped range, not document selectAll", async () => {
	expect(await replaceComposerText(composer, corrected, original)).toBe(
		"applied",
	);
	expect(text).toBe(corrected);
	expect(rangeTarget).toBe(composer);
	expect(commands).toEqual(["insertText"]);
	expect(collapsed).toBe(true);
});

test("rejects empty, whitespace-only and malformed corrections without editing", async () => {
	for (const value of ["", " \n ", undefined, null, 42]) {
		expect(await replaceComposerText(composer, value as string, original)).toBe(
			"unchanged",
		);
	}
	expect(text).toBe(original);
	expect(commands).toEqual([]);
});

test("rejects a suggestion after the draft changed", async () => {
	text = "a newer synthetic draft";
	expect(await replaceComposerText(composer, corrected, original)).toBe(
		"unchanged",
	);
	expect(text).toBe("a newer synthetic draft");
	expect(commands).toEqual([]);
});

test("rejects a detached or noneditable composer", async () => {
	connected = false;
	expect(await replaceComposerText(composer, corrected, original)).toBe(
		"unchanged",
	);
	connected = true;
	editable = false;
	expect(await replaceComposerText(composer, corrected, original)).toBe(
		"unchanged",
	);
	expect(commands).toEqual([]);
});

test("focus or selection failure cannot edit another element", async () => {
	active = null;
	focusWorks = false;
	expect(await replaceComposerText(composer, corrected, original)).toBe(
		"unchanged",
	);
	focusWorks = true;
	selectionWorks = false;
	expect(await replaceComposerText(composer, corrected, original)).toBe(
		"unchanged",
	);
	expect(commands).toEqual([]);
});

test("no-op command failure does not undo the user's previous edit", async () => {
	command = () => false;
	expect(await replaceComposerText(composer, corrected, original)).toBe(
		"unchanged",
	);
	expect(text).toBe(original);
	expect(commands).toEqual(["insertText"]);
	expect(collapsed).toBe(true);
});

test("a command reporting success but deleting the draft is undone", async () => {
	command = (name) => {
		text = name === "undo" ? original : "\n";
		input();
		return true;
	};
	expect(await replaceComposerText(composer, corrected, original)).toBe(
		"restored",
	);
	expect(text).toBe(original);
	expect(commands).toEqual(["insertText", "undo"]);
});

test("a partial deletion followed by a false return is undone", async () => {
	command = (name) => {
		text = name === "undo" ? original : "";
		input();
		return name === "undo";
	};
	expect(await replaceComposerText(composer, corrected, original)).toBe(
		"restored",
	);
	expect(text).toBe(original);
});

test("a command throwing after deleting the selection is undone", async () => {
	command = (name) => {
		if (name === "undo") {
			text = original;
			return true;
		}
		text = "";
		throw new Error("synthetic insertion failure");
	};
	expect(await replaceComposerText(composer, corrected, original)).toBe(
		"restored",
	);
	expect(text).toBe(original);
});

test("asynchronous editor reconciliation clearing the draft is detected", async () => {
	reconcile = () => {
		text = "\n";
	};
	expect(await replaceComposerText(composer, corrected, original)).toBe(
		"restored",
	);
	expect(text).toBe(original);
});

test("partial or wrong replacement is not reported as success", async () => {
	command = (name) => {
		text = name === "undo" ? original : "we were";
		return true;
	};
	expect(await replaceComposerText(composer, corrected, original)).toBe(
		"restored",
	);
	expect(text).toBe(original);
});

test("user typing while settling is preserved, never undone", async () => {
	reconcile = () => {
		text = "a newer synthetic draft";
		input();
	};
	expect(await replaceComposerText(composer, corrected, original)).toBe(
		"interrupted",
	);
	expect(text).toBe("a newer synthetic draft");
	expect(commands).toEqual(["insertText"]);
});

test("focus moving to another editor prevents rollback there", async () => {
	reconcile = () => {
		text = "";
		active = null;
	};
	expect(await replaceComposerText(composer, corrected, original)).toBe(
		"interrupted",
	);
	expect(commands).toEqual(["insertText"]);
});

test("a Send gesture while settling prevents unsafe rollback", async () => {
	reconcile = () => {
		for (const listener of listeners.get("keydown") ?? [])
			listener(new Event("keydown"));
		text = ""; // Slack cleared the composer after sending.
	};
	expect(await replaceComposerText(composer, corrected, original)).toBe(
		"interrupted",
	);
	expect(commands).toEqual(["insertText"]);
});

test("channel switch while settling never writes to a detached composer", async () => {
	reconcile = () => {
		connected = false;
	};
	expect(await replaceComposerText(composer, corrected, original)).toBe(
		"interrupted",
	);
	expect(commands).toEqual(["insertText"]);
});

test("failed undo is surfaced as failure, not successful apply", async () => {
	command = () => {
		text = "";
		return false;
	};
	expect(await replaceComposerText(composer, corrected, original)).toBe(
		"failed",
	);
});

test("editor-final newline is tolerated, lost internal line breaks are not", async () => {
	command = (name, value) => {
		text = name === "undo" ? original : `${value}\n`;
		return true;
	};
	expect(
		await replaceComposerText(composer, `${corrected}\nsecond line`, original),
	).toBe("applied");
	text = original;
	command = (name, value) => {
		text = name === "undo" ? original : (value ?? "").replace(/\n/g, " ");
		return true;
	};
	expect(
		await replaceComposerText(composer, `${corrected}\nsecond line`, original),
	).toBe("restored");
});

test("verification still completes when animation frames are suspended", async () => {
	Object.defineProperty(globalThis, "requestAnimationFrame", {
		configurable: true,
		value: () => 0,
	});
	expect(await replaceComposerText(composer, corrected, original)).toBe(
		"applied",
	);
});

test("empty draft is restored from the snapshot if undo fails", async () => {
	let inserts = 0;
	command = (name, value) => {
		if (name === "undo") return false;
		text = ++inserts === 1 ? "\n" : (value ?? "");
		input();
		return true;
	};
	const diagnostics: ApplyDiagnostic[] = [];
	expect(
		await replaceComposerText(composer, corrected, original, (d) =>
			diagnostics.push(d),
		),
	).toBe("restored");
	expect(text).toBe(original);
	expect(commands).toEqual(["insertText", "undo", "insertText"]);
	expect(diagnostics.map((d) => d.stage)).toEqual([
		"snapshot",
		"insert",
		"verify",
		"undo",
		"restore",
		"finish",
	]);
	expect(diagnostics.at(-1)?.outcome).toBe("restored");
	expect(JSON.stringify(diagnostics)).not.toContain(original);
	expect(JSON.stringify(diagnostics)).not.toContain(corrected);
});

test("throwing undo still permits verified empty-draft recovery", async () => {
	let inserts = 0;
	command = (name, value) => {
		if (name === "undo") throw new Error("synthetic undo failure");
		text = ++inserts === 1 ? "" : (value ?? "");
		return true;
	};
	expect(await replaceComposerText(composer, corrected, original)).toBe(
		"restored",
	);
	expect(text).toBe(original);
});

test("does not snapshot-restore over nonempty unrecognized undo contents", async () => {
	command = (name) => {
		text = name === "undo" ? "another synthetic draft" : "";
		return false;
	};
	expect(await replaceComposerText(composer, corrected, original)).toBe(
		"failed",
	);
	expect(text).toBe("another synthetic draft");
	expect(commands).toEqual(["insertText", "undo"]);
});

test("user input during undo prevents snapshot recovery", async () => {
	command = (name) => {
		text = "";
		if (name === "undo")
			reconcile = () => {
				text = "new synthetic input";
				input();
			};
		return false;
	};
	expect(await replaceComposerText(composer, corrected, original)).toBe(
		"interrupted",
	);
	expect(text).toBe("new synthetic input");
	expect(commands).toEqual(["insertText", "undo"]);
});

test("clearing later than two frames is detected and undone", async () => {
	setTimeout(() => {
		text = "\n";
	}, 100);
	expect(await replaceComposerText(composer, corrected, original)).toBe(
		"restored",
	);
	expect(text).toBe(original);
});

test("parallel Apply cannot acquire the same composer twice", async () => {
	const first = replaceComposerText(composer, corrected, original);
	expect(collapsed).toBe(true); // selection released before any await
	expect(await replaceComposerText(composer, corrected, original)).toBe(
		"unchanged",
	);
	expect(await first).toBe("applied");
	expect(commands).toEqual(["insertText"]);
});

test("a broken diagnostic sink cannot break Apply", async () => {
	expect(
		await replaceComposerText(composer, corrected, original, () => {
			throw new Error("synthetic diagnostic failure");
		}),
	).toBe("applied");
});
