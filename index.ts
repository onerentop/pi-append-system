/**
 * pi-append-system
 *
 * 用命令管理 pi 原生 APPEND_SYSTEM.md 的规则：增、删、改、单条启停、全局开关。
 *
 * 规则的结构化台账存在 <agentDir>/append-system.json（每条带启用标记），每次改动后把
 * 「启用中的规则」拼接渲染进 <agentDir>/APPEND_SYSTEM.md —— 也就是 pi 原生的 addendum
 * 通道。pi 在会话启动时读取该文件，所以改动需要 /reload（或新会话）才生效。
 *
 * 为什么不实时：APPEND_SYSTEM.md 走 pi 内核的 addendum，位置比自定义 section 更靠前、
 * 更强势，而且离开本扩展后规则依然留在标准文件里。代价就是要 /reload。
 *
 * 文件归属：本扩展独占写 APPEND_SYSTEM.md。首次接管时若发现已存在手写内容，会先备份到
 * APPEND_SYSTEM.md.bak，避免覆盖。
 *
 * 界面文案按系统语言自动切换中英文，见 detectLang()。用法：/append-system help
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";

const AGENT_DIR = getAgentDir();
const STATE_PATH = join(AGENT_DIR, "append-system.json"); // 结构化台账（规则 + 启用标记）
const MD_PATH = join(AGENT_DIR, "APPEND_SYSTEM.md"); // 渲染产物，pi 原生读取
const MAX_PREVIEW = 72;

interface Item {
	text: string;
	enabled: boolean;
}

interface State {
	/** 全局注入开关；关闭时 APPEND_SYSTEM.md 被清空。 */
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
	commandDescription: "管理 APPEND_SYSTEM.md 的规则（增删启停，/reload 生效）",
	listEmpty: (sw: string) => `规则为空（注入开关：${sw}）\n用 /append-system add "你的规则" 添加`,
	listHeader: (sw: string, total: number, active: number) =>
		`规则（注入开关：${sw}）—— 共 ${total} 条，启用 ${active} 条`,
	listFooter: "rm N 删除 · on/off N 启停单条 · on/off 全局开关 · edit N 修改或查看全文 · 改完 /reload 生效",
	help: (statePath: string, mdPath: string) =>
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
			`台账：${statePath}`,
			`渲染产物：${mdPath}（pi 原生 APPEND_SYSTEM.md，本扩展独占写入）`,
			"启用中的规则拼接写入该文件，走 pi 的 addendum 通道；改动后需要 /reload 或新会话才生效。",
			"注意：若当前项目有 .pi/APPEND_SYSTEM.md（且已信任），pi 会优先用它、忽略这里的全局文件。",
		].join("\n"),
	editorAdd: "新增规则（写入 APPEND_SYSTEM.md，/reload 后生效）",
	editorEdit: (n: number) => `编辑第 ${n} 条`,
	added: (n: number) => `已添加第 ${n} 条并写入 APPEND_SYSTEM.md，/reload 后生效`,
	updated: (n: number) => `已更新第 ${n} 条，/reload 后生效`,
	removed: (n: number, left: number) => `已删除 ${n} 条，剩余 ${left} 条（序号已重排），/reload 后生效`,
	emptyAdd: "内容为空，未添加",
	emptyEdit: "内容为空，未修改",
	usageEdit: (max: number) => `用法：/append-system edit <编号>，编号范围 1-${max}`,
	usageRm: (max: number) => `用法：/append-system rm <编号>，编号范围 1-${max}`,
	badIndex: (max: number) => `编号非法，范围 1-${max}`,
	switchedOn: "注入已开启，APPEND_SYSTEM.md 已重建，/reload 后生效",
	switchedOff: "注入已关闭，APPEND_SYSTEM.md 已清空，/reload 后生效",
	toggledOn: (n: number) => `已启用 ${n} 条，/reload 后生效`,
	toggledOff: (n: number) => `已停用 ${n} 条，/reload 后生效`,
	nothingToClear: "没有规则可清空",
	clearTitle: "清空规则",
	clearConfirm: (n: number) => `将删除全部 ${n} 条规则并清空 APPEND_SYSTEM.md，确定？`,
	cleared: (n: number) => `已清空 ${n} 条，APPEND_SYSTEM.md 已移除，/reload 后生效`,
	unknownSub: (sub: string) => `未知子命令 "${sub}"`,
	saveFailed: (message: string) => `保存失败：${message}`,
	backedUp: (path: string) => `检测到已存在的 APPEND_SYSTEM.md，已备份到 ${path} 再接管`,
	statusActive: (n: number) => `append-system: ${n} 条`,
	statusOff: (n: number) => `append-system: off (${n})`,
};

const en: typeof zh = {
	commandDescription: "Manage APPEND_SYSTEM.md rules (add/toggle/remove, applied on /reload)",
	listEmpty: (sw) => `No rules (inject: ${sw})\nAdd one with /append-system add "your rule"`,
	listHeader: (sw, total, active) => `Rules (inject: ${sw}) — ${total} total, ${active} active`,
	listFooter: "rm N delete · on/off N toggle one · on/off global switch · edit N edit/view · /reload to apply",
	help: (statePath, mdPath) =>
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
			`Ledger: ${statePath}`,
			`Rendered file: ${mdPath} (pi's native APPEND_SYSTEM.md, owned by this extension)`,
			"Enabled rules are concatenated into that file via pi's addendum channel; changes need /reload or a new session.",
			"Note: a project's .pi/APPEND_SYSTEM.md (when trusted) takes precedence, and pi then ignores this global file.",
		].join("\n"),
	editorAdd: "New rule (written to APPEND_SYSTEM.md, applied on /reload)",
	editorEdit: (n) => `Edit rule ${n}`,
	added: (n) => `Added rule ${n} and wrote APPEND_SYSTEM.md; /reload to apply`,
	updated: (n) => `Updated rule ${n}; /reload to apply`,
	removed: (n, left) => `Removed ${n} rule(s), ${left} left (renumbered); /reload to apply`,
	emptyAdd: "Empty content, nothing added",
	emptyEdit: "Empty content, nothing changed",
	usageEdit: (max) => `Usage: /append-system edit <N>, N in 1-${max}`,
	usageRm: (max) => `Usage: /append-system rm <N>, N in 1-${max}`,
	badIndex: (max) => `Invalid index, expected 1-${max}`,
	switchedOn: "Injection enabled, APPEND_SYSTEM.md rebuilt; /reload to apply",
	switchedOff: "Injection disabled, APPEND_SYSTEM.md cleared; /reload to apply",
	toggledOn: (n) => `Enabled ${n} rule(s); /reload to apply`,
	toggledOff: (n) => `Disabled ${n} rule(s); /reload to apply`,
	nothingToClear: "No rules to clear",
	clearTitle: "Clear rules",
	clearConfirm: (n) => `Delete all ${n} rule(s) and clear APPEND_SYSTEM.md?`,
	cleared: (n) => `Cleared ${n} rule(s), APPEND_SYSTEM.md removed; /reload to apply`,
	unknownSub: (sub) => `Unknown subcommand "${sub}"`,
	saveFailed: (message) => `Failed to save: ${message}`,
	backedUp: (path) => `Existing APPEND_SYSTEM.md found; backed up to ${path} before taking over`,
	statusActive: (n) => `append-system: ${n} rule(s)`,
	statusOff: (n) => `append-system: off (${n})`,
};

const MESSAGES: Record<Lang, typeof zh> = { zh, en };

/** 每次取用时重新判断语言，便于测试切换环境变量。 */
function t(): typeof zh {
	return MESSAGES[detectLang()];
}

// ---------------------------------------------------------------- 台账读写

function emptyState(): State {
	return { enabled: true, items: [] };
}

/** 读取台账；文件缺失、损坏或字段异常时回退到空状态，不抛错。 */
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

/** 先写临时文件再 rename，避免进程中断留下半截内容。 */
function atomicWrite(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tempPath = `${path}.tmp`;
	writeFileSync(tempPath, content, "utf-8");
	renameSync(tempPath, path);
}

function saveState(state: State): void {
	atomicWrite(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

/** 把启用中的规则拼接渲染进 APPEND_SYSTEM.md；无内容时移除该文件。 */
function renderMarkdown(state: State): void {
	const body = state.enabled
		? state.items
				.filter((item) => item.enabled)
				.map((item) => item.text)
				.join("\n\n")
				.trim()
		: "";
	if (body) {
		atomicWrite(MD_PATH, `${body}\n`);
	} else {
		rmSync(MD_PATH, { force: true });
	}
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

/** 只接受纯十进制整数，挡掉 0x2 / 1e2 / 1.0 这类 Number() 会接受的写法。 */
function selectItems(tokens: string[], items: Item[]): Selection[] | null {
	const selected: Selection[] = [];
	for (const token of tokens) {
		if (!/^\d+$/.test(token)) return null;
		const n = Number(token);
		if (n < 1 || n > items.length) return null;
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

/** 把渲染进 APPEND_SYSTEM.md 的规则数量同步到状态栏；没有则清除。 */
function syncStatus(ctx: ExtensionContext, state: State): void {
	if (!state.enabled) {
		ctx.ui.setStatus(
			"append-system",
			state.items.length > 0 ? t().statusOff(state.items.length) : undefined,
		);
		return;
	}
	const active = state.items.filter((item) => item.enabled).length;
	ctx.ui.setStatus("append-system", active > 0 ? t().statusActive(active) : undefined);
}

/** 保存台账 + 渲染 APPEND_SYSTEM.md + 同步状态栏；首次接管前备份手写文件。 */
function persist(state: State, ctx: ExtensionCommandContext): boolean {
	try {
		// 首次接管（还没有台账）时若已存在手写的 APPEND_SYSTEM.md，先备份，避免覆盖
		if (!existsSync(STATE_PATH) && existsSync(MD_PATH)) {
			const backup = `${MD_PATH}.bak`;
			// 只在 .bak 不存在时才备份，避免用户删掉台账后再改动时把最初的手写备份覆盖掉
			if (!existsSync(backup)) {
				renameSync(MD_PATH, backup);
				ctx.ui.notify(t().backedUp(backup), "warning");
			}
		}
		saveState(state);
		renderMarkdown(state);
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
					ctx.ui.notify(t().help(STATE_PATH, MD_PATH), "info");
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
						ctx.ui.notify(t().usageEdit(state.items.length), "error");
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
						ctx.ui.notify(t().badIndex(state.items.length), "error");
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
						ctx.ui.notify(t().badIndex(state.items.length), "error");
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
					ctx.ui.notify(`${t().unknownSub(sub)}\n\n${t().help(STATE_PATH, MD_PATH)}`, "error");
					return;
			}
		},
	});

	// 会话启动时同步状态栏，避免忘了自己开着哪些规则。
	pi.on("session_start", async (_event, ctx) => {
		syncStatus(ctx, loadState());
	});
}
