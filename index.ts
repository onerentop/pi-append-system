/**
 * pi-append-system
 *
 * 在运行时增删、启停追加到 system prompt 的规则，不必编辑 APPEND_SYSTEM.md，也不必 /reload。
 *
 * 规则存放在 <agentDir>/append-system.json，在 before_agent_start 中作为独立的
 * `dynamic_append` system prompt section 注入。Pi 会对 prompt section 做 diff，只把发生
 * 变化的 section 作为一条补丁消息发出去，所以改动在下一条消息就生效。
 *
 * 这条通道与 `appendSystemPrompt`（APPEND_SYSTEM.md / --append-system-prompt 用的
 * `addendum` section）彼此独立，两者叠加而不是互相覆盖。
 *
 * 界面文案按系统语言自动切换中英文，见 detectLang()。
 *
 * 用法：/append-system help
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";

const STATE_PATH = join(getAgentDir(), "append-system.json");
const SECTION_NAME = "dynamic_append";
const MAX_PREVIEW = 72;

interface Item {
	text: string;
	enabled: boolean;
}

interface State {
	/** 全局注入开关；关闭时所有条目都不进 system prompt。 */
	enabled: boolean;
	items: Item[];
}

interface Selection {
	index: number;
	item: Item;
}

// ---------------------------------------------------------------- 界面文案

type Lang = "zh" | "en";

/**
 * 按系统语言选择界面文案。LC_ALL > LC_MESSAGES > LANG，只有 zh* 用中文，
 * 其余（包括未设置）一律英文 —— 分发到别人的机器上默认是英文。
 */
function detectLang(): Lang {
	const raw = (process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "").toLowerCase();
	return raw.startsWith("zh") ? "zh" : "en";
}

const zh = {
	commandDescription: "运行时增删追加到 system prompt 的规则（无需 /reload）",
	listEmpty: (sw: string) => `追加规则为空（注入开关：${sw}）\n用 /append-system add "你的规则" 添加`,
	listHeader: (sw: string, total: number, active: number) =>
		`追加规则（注入开关：${sw}）—— 共 ${total} 条，启用 ${active} 条`,
	listFooter: "rm N 删除 · on/off N 启停单条 · on/off 全局开关 · edit N 修改或查看全文",
	help: (statePath: string) =>
		[
			"/append-system                  列出所有规则",
			'/append-system add "文本"        新增并启用（不带文本会打开编辑器）',
			"/append-system edit N           修改第 N 条或查看全文（不带文本会打开编辑器）",
			"/append-system rm N [N...]      删除一条或多条",
			"/append-system on|off [N]       全局注入开关，或启停单条",
			"/append-system clear            清空全部规则",
			"",
			"别名：list = ls，remove/delete = rm。rm 之后序号会重排，可用 edit N 查看全文。",
			"",
			`状态文件：${statePath}`,
			"作为 system prompt 的 dynamic_append section 注入，与 APPEND_SYSTEM.md 叠加而非覆盖。",
			"改动在下一条消息立即生效，无需 /reload。",
		].join("\n"),
	editorAdd: "新增追加规则（保存后下一条消息生效）",
	editorEdit: (n: number) => `编辑第 ${n} 条`,
	added: (n: number) => `已添加第 ${n} 条规则，下一条消息生效`,
	updated: (n: number) => `已更新第 ${n} 条规则`,
	removed: (n: number, left: number) => `已删除 ${n} 条规则，剩余 ${left} 条（序号已重排，用 ls 查看）`,
	emptyAdd: "内容为空，未添加",
	emptyEdit: "内容为空，未修改",
	usageEdit: (max: number) => `用法：/append-system edit <编号>，编号范围 1-${max}`,
	usageRm: (max: number) => `用法：/append-system rm <编号>，编号范围 1-${max}`,
	badIndex: (max: number) => `编号非法，范围 1-${max}`,
	noRules: "还没有任何规则，用 /append-system add 添加",
	switchedOn: "追加规则注入已开启",
	switchedOff: "追加规则注入已关闭",
	toggledOn: (n: number) => `已启用 ${n} 条规则`,
	toggledOff: (n: number) => `已停用 ${n} 条规则`,
	nothingToClear: "没有规则可清空",
	clearTitle: "清空追加规则",
	clearConfirm: (n: number) => `将删除全部 ${n} 条规则，确定？`,
	cleared: (n: number) => `已清空 ${n} 条规则`,
	unknownSub: (sub: string) => `未知子命令 "${sub}"`,
	saveFailed: (message: string) => `保存失败：${message}`,
	statusActive: (n: number) => `append-system: ${n} 条规则`,
	statusOff: (n: number) => `append-system: off (${n})`,
};

const en: typeof zh = {
	commandDescription: "Add, toggle and remove system-prompt append rules at runtime (no /reload)",
	listEmpty: (sw) => `No append rules (inject: ${sw})\nAdd one with /append-system add "your rule"`,
	listHeader: (sw, total, active) => `Append rules (inject: ${sw}) — ${total} total, ${active} active`,
	listFooter: "rm N delete · on/off N toggle one · on/off global switch · edit N edit or view full text",
	help: (statePath) =>
		[
			"/append-system                  list all rules",
			'/append-system add "text"       add and enable (opens an editor without text)',
			"/append-system edit N           edit rule N, or view its full text",
			"/append-system rm N [N...]      delete one or more",
			"/append-system on|off [N]       global switch, or toggle one rule",
			"/append-system clear            delete all rules",
			"",
			"Aliases: list = ls, remove/delete = rm. Removing renumbers the list; `edit N` shows full text.",
			"",
			`State file: ${statePath}`,
			"Injected as the `dynamic_append` system-prompt section; stacks with APPEND_SYSTEM.md instead of replacing it.",
			"Changes take effect on the next message — no /reload needed.",
		].join("\n"),
	editorAdd: "New append rule (effective on the next message)",
	editorEdit: (n) => `Edit rule ${n}`,
	added: (n) => `Added rule ${n}; effective on the next message`,
	updated: (n) => `Updated rule ${n}`,
	removed: (n, left) => `Removed ${n} rule(s), ${left} left (indexes renumbered — run ls)`,
	emptyAdd: "Empty content, nothing added",
	emptyEdit: "Empty content, nothing changed",
	usageEdit: (max) => `Usage: /append-system edit <N>, N in 1-${max}`,
	usageRm: (max) => `Usage: /append-system rm <N>, N in 1-${max}`,
	badIndex: (max) => `Invalid index, expected 1-${max}`,
	noRules: "No rules yet — add one with /append-system add",
	switchedOn: "Append-rule injection enabled",
	switchedOff: "Append-rule injection disabled",
	toggledOn: (n) => `Enabled ${n} rule(s)`,
	toggledOff: (n) => `Disabled ${n} rule(s)`,
	nothingToClear: "No rules to clear",
	clearTitle: "Clear append rules",
	clearConfirm: (n) => `Delete all ${n} rule(s)?`,
	cleared: (n) => `Cleared ${n} rule(s)`,
	unknownSub: (sub) => `Unknown subcommand "${sub}"`,
	saveFailed: (message) => `Failed to save: ${message}`,
	statusActive: (n) => `append-system: ${n} rule(s)`,
	statusOff: (n) => `append-system: off (${n})`,
};

const MESSAGES: Record<Lang, typeof zh> = { zh, en };

/** 每次取用时重新判断语言，便于测试切换环境变量。 */
function t(): typeof zh {
	return MESSAGES[detectLang()];
}

// ---------------------------------------------------------------- 状态读写

function emptyState(): State {
	return { enabled: true, items: [] };
}

/** 读取状态文件；文件缺失、损坏或字段异常时回退到空状态，不抛错。 */
function loadState(): State {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(STATE_PATH, "utf-8"));
	} catch (error) {
		// 文件不存在是正常情况；内容损坏则先改名留存，避免下一次写入把它覆盖掉
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
			try {
				renameSync(STATE_PATH, `${STATE_PATH}.bad`);
			} catch {
				// 备份失败就按空状态继续，不打断对话
			}
		}
		return emptyState();
	}
	if (typeof raw !== "object" || raw === null) return emptyState();

	const source = raw as { enabled?: unknown; items?: unknown };
	const items: Item[] = [];
	if (Array.isArray(source.items)) {
		for (const entry of source.items) {
			if (typeof entry === "string") {
				if (entry.trim()) items.push({ text: entry, enabled: true });
				continue;
			}
			if (typeof entry !== "object" || entry === null) continue;
			const item = entry as { text?: unknown; enabled?: unknown };
			const text = typeof item.text === "string" ? item.text : "";
			if (text.trim()) items.push({ text, enabled: item.enabled !== false });
		}
	}
	return { enabled: source.enabled !== false, items };
}

/** 先写临时文件再 rename，避免进程中断留下半截 JSON。 */
function saveState(state: State): void {
	mkdirSync(dirname(STATE_PATH), { recursive: true });
	const tempPath = `${STATE_PATH}.tmp`;
	writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
	renameSync(tempPath, STATE_PATH);
}

// ---------------------------------------------------------------- 输入处理

/**
 * 去掉用户输入外层成对的引号，并把字面量 \n 还原为换行。
 * 只剥掉内部没有同类引号的包裹，避免把 `"a" and "b"` 削成 `a" and "b`。
 */
function normalizeInput(raw: string): string {
	let text = raw.trim();
	const doubleQuoted = text.match(/^"([^"]*)"$/);
	const singleQuoted = doubleQuoted ? null : text.match(/^'([^']*)'$/);
	if (doubleQuoted) text = doubleQuoted[1] ?? "";
	else if (singleQuoted) text = singleQuoted[1] ?? "";
	return text.replace(/\\n/g, "\n").trim();
}

/** 只接受纯十进制整数，挡掉 0x2 / 1e2 / 1.0 这类 Number() 会接受的写法；重复编号只算一次。 */
function selectItems(tokens: string[], items: Item[]): Selection[] | null {
	const selected: Selection[] = [];
	const seen = new Set<number>();
	for (const token of tokens) {
		if (!/^\d+$/.test(token)) return null;
		const n = Number(token);
		if (n < 1 || n > items.length) return null;
		if (seen.has(n)) continue;
		seen.add(n);
		const item = items[n - 1];
		if (item) selected.push({ index: n - 1, item });
	}
	return selected;
}

// ---------------------------------------------------------------- 展示

function preview(text: string): string {
	const flat = text.replace(/\s*\n\s*/g, " ⏎ ");
	return flat.length > MAX_PREVIEW ? `${flat.slice(0, MAX_PREVIEW)}…` : flat;
}

function formatList(state: State): string {
	const switchText = state.enabled ? "on" : "off";
	if (state.items.length === 0) return t().listEmpty(switchText);
	const active = state.items.filter((item) => item.enabled).length;
	return [
		t().listHeader(switchText, state.items.length, active),
		...state.items.map((item, i) => `  ${i + 1}. [${item.enabled ? "on " : "off"}] ${preview(item.text)}`),
		"",
		t().listFooter,
	].join("\n");
}

/** 把当前生效的规则数量同步到状态栏；没有生效规则时清除。 */
function syncStatus(ctx: ExtensionContext, state: State): void {
	if (!state.enabled) {
		// 全局关闭时条目仍在，明确显示 off 而不是直接清掉，避免和 clear 混淆
		ctx.ui.setStatus(
			"append-system",
			state.items.length > 0 ? t().statusOff(state.items.length) : undefined,
		);
		return;
	}
	const active = state.items.filter((item) => item.enabled).length;
	ctx.ui.setStatus("append-system", active > 0 ? t().statusActive(active) : undefined);
}

function persist(state: State, ctx: ExtensionCommandContext): boolean {
	try {
		saveState(state);
	} catch (error) {
		ctx.ui.notify(t().saveFailed(error instanceof Error ? error.message : String(error)), "error");
		return false;
	}
	syncStatus(ctx, state);
	return true;
}

// ---------------------------------------------------------------- 扩展本体

export default function appendSystemExtension(pi: ExtensionAPI) {
	pi.registerCommand("append-system", {
		description: t().commandDescription,
		getArgumentCompletions: (prefix) => {
			const subs = ["ls", "add", "edit", "rm", "on", "off", "clear", "help"];
			const lower = prefix.toLowerCase();
			const items = subs.filter((s) => s.startsWith(lower)).map((s) => ({ value: s, label: s }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const state = loadState();
			const trimmed = args.trim();
			// \S+ 切出子命令，其余原样作参数（按任意空白分隔，tab 也认）
			const match = trimmed.match(/^(\S+)(?:\s+([\s\S]*))?$/);
			const sub = (match?.[1] ?? "").toLowerCase() || "ls";
			const rest = (match?.[2] ?? "").trim();

			switch (sub) {
				case "ls":
				case "list":
					ctx.ui.notify(formatList(state), "info");
					return;

				case "help":
					ctx.ui.notify(t().help(STATE_PATH), "info");
					return;

				case "add": {
					let text = rest ? normalizeInput(rest) : "";
					if (!text) {
						const typed = await ctx.ui.editor(t().editorAdd);
						if (typed === undefined) return; // 用户取消，静默返回
						text = normalizeInput(typed);
					}
					if (!text) {
						ctx.ui.notify(t().emptyAdd, "warning");
						return;
					}
					state.items.push({ text, enabled: true });
					if (persist(state, ctx)) {
						ctx.ui.notify(t().added(state.items.length), "info");
					}
					return;
				}

				case "edit": {
					const editMatch = rest.match(/^(\S*)(?:\s+([\s\S]*))?$/);
					const numberToken = editMatch?.[1] ?? "";
					let text = normalizeInput(editMatch?.[2] ?? "");
					const selection = selectItems([numberToken], state.items)?.[0];
					if (!selection) {
						ctx.ui.notify(
							state.items.length === 0 ? t().noRules : t().usageEdit(state.items.length),
							"error",
						);
						return;
					}
					if (!text) {
						const typed = await ctx.ui.editor(t().editorEdit(selection.index + 1), selection.item.text);
						if (typed === undefined) return;
						text = normalizeInput(typed);
					}
					if (!text) {
						ctx.ui.notify(t().emptyEdit, "warning");
						return;
					}
					selection.item.text = text;
					if (persist(state, ctx)) {
						ctx.ui.notify(t().updated(selection.index + 1), "info");
					}
					return;
				}

				case "rm":
				case "remove":
				case "delete": {
					const tokens = rest.split(/\s+/).filter(Boolean);
					if (tokens.length === 0) {
						ctx.ui.notify(t().usageRm(state.items.length), "error");
						return;
					}
					const selection = selectItems(tokens, state.items);
					if (!selection) {
						ctx.ui.notify(
							state.items.length === 0 ? t().noRules : t().badIndex(state.items.length),
							"error",
						);
						return;
					}
					const removed = new Set(selection.map((entry) => entry.item));
					state.items = state.items.filter((item) => !removed.has(item));
					if (persist(state, ctx)) {
						ctx.ui.notify(t().removed(removed.size, state.items.length), "info");
					}
					return;
				}

				case "on":
				case "off": {
					const enable = sub === "on";
					if (!rest) {
						state.enabled = enable;
						if (persist(state, ctx)) {
							ctx.ui.notify(enable ? t().switchedOn : t().switchedOff, "info");
						}
						return;
					}
					const selection = selectItems(rest.split(/\s+/).filter(Boolean), state.items);
					if (!selection) {
						ctx.ui.notify(
							state.items.length === 0 ? t().noRules : t().badIndex(state.items.length),
							"error",
						);
						return;
					}
					for (const entry of selection) entry.item.enabled = enable;
					if (persist(state, ctx)) {
						ctx.ui.notify(enable ? t().toggledOn(selection.length) : t().toggledOff(selection.length), "info");
					}
					return;
				}

				case "clear": {
					const count = state.items.length;
					if (count === 0) {
						ctx.ui.notify(t().nothingToClear, "warning");
						return;
					}
					const confirmed = await ctx.ui.confirm(t().clearTitle, t().clearConfirm(count));
					if (!confirmed) return;
					state.items = [];
					if (persist(state, ctx)) {
						ctx.ui.notify(t().cleared(count), "info");
					}
					return;
				}

				default:
					ctx.ui.notify(`${t().unknownSub(sub)}\n\n${t().help(STATE_PATH)}`, "error");
					return;
			}
		},
	});

	// 每轮对话重新读取配置，把启用的条目注入成独立的 system prompt section。
	// 走 sections 通道，Pi 只把变化的 section 作为一条 system 消息补丁发出去。
	pi.on("before_agent_start", (event) => {
		const state = loadState();
		const text = state.enabled
			? state.items
					.filter((item) => item.enabled)
					.map((item) => item.text)
					.join("\n\n")
					.trim()
			: "";

		if (text) {
			event.systemPromptOptions.sections[SECTION_NAME] = text;
		} else {
			delete event.systemPromptOptions.sections[SECTION_NAME];
		}
	});

	// 会话启动时同步状态栏，避免忘了自己开着哪些规则。
	pi.on("session_start", async (_event, ctx) => {
		syncStatus(ctx, loadState());
	});
}
