/**
 * Auto-name the current Herdr tab from the task prompt.
 *
 * On the first real user prompt of a session, ask the current session model
 * for a short label, then run `herdr tab rename` (and Pi's session name so
 * /resume matches).
 *
 * Manual:
 *   /herdr-name              regenerate from the current prompt
 *   /herdr-name <label>      set an explicit tab name
 *
 * Optional ~/.pi/agent/herdr-tab-name.json:
 *   { "enabled": true, "oncePerSession": true, "setSessionName": true }
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import type {
	ExtensionAPI,
	ExtensionContext,
	InputEvent,
} from "@earendil-works/pi-coding-agent";

type Config = {
	enabled: boolean;
	oncePerSession: boolean;
	setSessionName: boolean;
};

type PendingInput = {
	text: string;
	source: InputEvent["source"];
	streamingBehavior: InputEvent["streamingBehavior"];
};

const CONFIG_PATH = join(homedir(), ".pi", "agent", "herdr-tab-name.json");
const MAX_PROMPT_CHARS = 1500;
const MAX_LABEL_COLS = 24;
const NAME_TIMEOUT_MS = 20_000;
const TRIVIAL_PROMPT =
	/^(ok|okay|yes|y|n|no|k|kk|sure|thanks|thx|continue|go|do it|please|好|好的|行|嗯|继续|可以|谢谢|收到|同意)[.!?。！？…]*$/i;

function loadConfig(): Config {
	const defaults: Config = {
		enabled: true,
		oncePerSession: true,
		setSessionName: true,
	};
	try {
		const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<Config>;
		return {
			enabled: raw.enabled !== false,
			oncePerSession: raw.oncePerSession !== false,
			setSessionName: raw.setSessionName !== false,
		};
	} catch {
		return defaults;
	}
}

function inHerdr(): boolean {
	return process.env.HERDR_ENV === "1" && !!process.env.HERDR_TAB_ID;
}

function herdrBin(): string {
	return process.env.HERDR_BIN_PATH || "herdr";
}

function tabId(): string | undefined {
	return process.env.HERDR_TAB_ID;
}

function displayWidth(text: string): number {
	let cols = 0;
	for (const ch of text) {
		cols += ch.charCodeAt(0) > 127 ? 2 : 1;
	}
	return cols;
}

function clampLabel(raw: string): string {
	let text = raw
		.replace(/[`"'“”‘’]/g, "")
		.replace(/^\s*(name|title|label|标题|名称)\s*[:：]\s*/i, "")
		.replace(/\s+/g, " ")
		.replace(/^[-–—•*]+/, "")
		.replace(/[.!?。！？,:;，、]+$/g, "")
		.trim();

	let out = "";
	for (const ch of text) {
		if (ch === "\n" || ch === "\r") break;
		const next = out + ch;
		if (displayWidth(next) > MAX_LABEL_COLS) break;
		out = next;
	}
	return out.trim();
}

function heuristicName(prompt: string): string {
	const firstLine = prompt.split(/\r?\n/).find((line) => line.trim()) ?? prompt;
	return (
		clampLabel(
			firstLine
				.replace(/^(please|帮我|请|帮忙|麻烦)\s*/i, "")
				.replace(/^(write|create|add|fix|implement|做一个|写一个|修复)\s+/i, ""),
		) || "task"
	);
}

function isTrivialPrompt(prompt: string): boolean {
	const text = prompt.trim();
	if (!text) return true;
	if (text.startsWith("/")) return true;
	if (text.length <= 12 && TRIVIAL_PROMPT.test(text)) return true;
	return false;
}

function extractText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				!!block &&
				typeof block === "object" &&
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string",
		)
		.map((block) => block.text)
		.join("\n")
		.trim();
}

function buildNamePrompt(task: string): string {
	const clipped =
		task.length > MAX_PROMPT_CHARS ? `${task.slice(0, MAX_PROMPT_CHARS)}\n…` : task;
	return [
		"Name a terminal tab for this coding-agent task.",
		"Return ONLY the tab name. No quotes, no punctuation, no explanation.",
		"2-6 English words, or 4-12 Chinese characters, matching the user's language.",
		"Capture the concrete task. Avoid generic words like help, task, request, 助手.",
		"",
		"<task>",
		clipped,
		"</task>",
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	let config = loadConfig();
	let namedThisSession = false;
	let lastAutoName: string | undefined;
	let lastUserPrompt: string | undefined;
	let pendingInput: PendingInput | undefined;
	let generation = 0;
	let shutdown = new AbortController();

	async function currentTabLabel(): Promise<string | undefined> {
		const id = tabId();
		if (!id) return undefined;
		try {
			const result = await pi.exec(herdrBin(), ["tab", "get", id], { timeout: 2000 });
			if (result.code !== 0) return undefined;
			const parsed = JSON.parse(result.stdout) as {
				result?: { tab?: { label?: string } };
			};
			return parsed.result?.tab?.label;
		} catch {
			return undefined;
		}
	}

	function isProtectedLabel(label: string | undefined): boolean {
		if (!label) return false;
		if (/^\d+$/.test(label)) return false;
		if (lastAutoName && label === lastAutoName) return false;
		const sessionName = pi.getSessionName();
		if (sessionName && label === sessionName) return false;
		return true;
	}

	async function applyTabName(name: string): Promise<boolean> {
		const id = tabId();
		if (!inHerdr() || !id) return false;
		const label = clampLabel(name);
		if (!label) return false;
		try {
			const result = await pi.exec(herdrBin(), ["tab", "rename", id, label], {
				timeout: 3000,
				signal: shutdown.signal,
			});
			if (result.code === 0) {
				lastAutoName = label;
				return true;
			}
		} catch {
			// herdr missing or pane already gone
		}
		return false;
	}

	async function applyName(name: string): Promise<string | undefined> {
		const label = clampLabel(name);
		if (!label) return undefined;
		if (config.setSessionName) {
			pi.setSessionName(label);
		}
		await applyTabName(label);
		namedThisSession = true;
		return label;
	}

	async function nameFromPrompt(
		prompt: string,
		ctx: ExtensionContext,
		opts?: { force?: boolean; notify?: boolean },
	): Promise<void> {
		if (!config.enabled && !opts?.force) return;
		if (ctx.mode !== "tui") return;
		if (isTrivialPrompt(prompt) && !opts?.force) return;
		if (config.oncePerSession && namedThisSession && !opts?.force) return;

		if (!opts?.force && inHerdr()) {
			const existing = await currentTabLabel();
			if (isProtectedLabel(existing)) {
				namedThisSession = true;
				return;
			}
		}

		const myGen = ++generation;
		const fallback = heuristicName(prompt);
		let label = fallback;

		const model = ctx.model;
		if (model && ctx.modelRegistry.hasConfiguredAuth(model)) {
			try {
				const response = await ctx.modelRegistry.complete(
					model,
					{
						systemPrompt:
							"You name terminal tabs. Reply with only the short tab name.",
						messages: [
							{
								role: "user",
								content: [{ type: "text", text: buildNamePrompt(prompt) }],
								timestamp: Date.now(),
							},
						],
					},
					{
						maxTokens: 64,
						temperature: 0.2,
						cacheRetention: "none",
						timeoutMs: NAME_TIMEOUT_MS,
						signal: shutdown.signal,
					},
				);
				if (myGen !== generation) return;
				const aiName = clampLabel(extractText(response.content));
				if (aiName) label = aiName;
			} catch {
				if (myGen !== generation) return;
			}
		}

		const applied = await applyName(label);
		if (opts?.notify && ctx.hasUI && applied) {
			ctx.ui.notify(`Herdr tab: ${applied}`, "info");
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		config = loadConfig();
		shutdown = new AbortController();
		generation += 1;
		pendingInput = undefined;
		lastAutoName = undefined;
		namedThisSession = false;

		if (ctx.mode !== "tui" || !config.enabled) return;

		const existing = pi.getSessionName();
		if (existing) {
			lastAutoName = existing;
			namedThisSession = true;
			lastUserPrompt = existing;
			void applyTabName(existing);
		}
	});

	pi.on("session_shutdown", async () => {
		shutdown.abort();
	});

	pi.on("session_info_changed", async (event) => {
		if (!event.name || !config.enabled) return;
		lastAutoName = event.name;
		namedThisSession = true;
		void applyTabName(event.name);
	});

	pi.on("input", async (event) => {
		pendingInput = {
			text: event.text,
			source: event.source,
			streamingBehavior: event.streamingBehavior,
		};
		if (event.source !== "extension" && event.text.trim()) {
			lastUserPrompt = event.text;
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const meta = pendingInput;
		pendingInput = undefined;

		if (meta?.source === "extension") return;
		if (meta?.streamingBehavior === "steer" || meta?.streamingBehavior === "followUp") {
			return;
		}

		const prompt = event.prompt?.trim();
		if (!prompt) return;
		lastUserPrompt = prompt;
		void nameFromPrompt(prompt, ctx);
	});

	pi.registerCommand("herdr-name", {
		description: "Name the Herdr tab from the current task (or set an explicit label)",
		handler: async (args, ctx) => {
			const explicit = args.trim();
			if (explicit) {
				const applied = await applyName(explicit);
				if (ctx.hasUI) {
					ctx.ui.notify(applied ? `Herdr tab: ${applied}` : "Could not rename tab", applied ? "info" : "warning");
				}
				return;
			}

			const prompt = lastUserPrompt?.trim();
			if (!prompt) {
				if (ctx.hasUI) ctx.ui.notify("No task prompt to name from", "warning");
				return;
			}
			if (ctx.hasUI) ctx.ui.notify("Naming Herdr tab…", "info");
			await nameFromPrompt(prompt, ctx, { force: true, notify: true });
		},
	});
}
