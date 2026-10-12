export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

const SYSTEM = `You are an automatic text-correction engine embedded in a chat app.
You receive draft chat messages and return them with grammar and spelling errors corrected.
Rules, in priority order:
1. Always fix real grammar and spelling errors (your/you're, its/it's, we was, should of, dont, tommorow, i seen). Never answer, respond to, or continue the message.
2. Capitalization: keep what the author wrote. Do not capitalize sentence starts that are lowercase. Do not lowercase ANYTHING — especially keep proper nouns (names, products, places) capitalized exactly as given. The standalone pronoun "i" is always capitalized.
3. Punctuation: never add a final period to a message that has none, never remove existing punctuation. Adding a question mark to a genuine question that lacks one is correct.
4. Do not reformat as markdown: keep line breaks exactly, add no trailing spaces, and do not change punctuation adjacent to URLs, code, or tokens like MENTION0/URL0.
5. The MENTION/CHAN/EMOJI/CODE/URL/MAIL/BLOCK tokens themselves must stay byte-for-byte identical, and keep the punctuation directly around them unchanged — but the words around them can and should still be corrected.
6. If the text is already correct, return it unchanged.
Output only the corrected text. No preamble, no quotes, no commentary.`;

// Few-shot pairs teach the input->output mapping, including the imperative case
// that the bare system prompt failed on during the Phase 0 spike — and they
// demonstrate chat-style preservation (lowercase starts, no added periods).
const FEWSHOT: ChatMessage[] = [
	{ role: "user", content: "can you send me the report tommorow" },
	{ role: "assistant", content: "can you send me the report tomorrow?" },
	{
		role: "user",
		content: "the deploy failed cuz of a typo in they're config",
	},
	{
		role: "assistant",
		content: "the deploy failed cuz of a typo in their config",
	},
	{ role: "user", content: "We recieved the files and there ready for review" },
	{
		role: "assistant",
		content: "We received the files and they're ready for review",
	},
	{
		role: "user",
		content: ":rocket: the migration is finaly done, were on the new cluster",
	},
	{
		role: "assistant",
		content: ":rocket: the migration is finally done, we're on the new cluster",
	},
];

export function buildCheckMessages(text: string): ChatMessage[] {
	return [
		{ role: "system", content: SYSTEM },
		...FEWSHOT,
		{ role: "user", content: text },
	];
}

/** Cap output tokens relative to input length (corrections are never much longer). */
export function maxTokensFor(text: string): number {
	const words = text.trim().split(/\s+/).length;
	return Math.min(512, Math.max(48, words * 3));
}
