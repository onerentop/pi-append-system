/**
 * 集成测试：走 pi 真实的加载与渲染链路，而不是 mock。
 *
 * 1. 用 pi 自己的 discoverAndLoadExtensions 按 package.json 的 `pi` manifest 加载本包
 *    —— 这同时验证了包结构、关键字与 peerDependency 约定是否正确。
 * 2. 把拿到的 handler 接到 pi 真实的 system prompt 构造/渲染函数上，
 *    断言 section 的出现、消失与补丁语义。
 *
 * 运行：node test/render.test.mjs  （或 npm test）
 *
 * 注意：第 2 步用了 pi 的内部模块 dist/core/system-prompt.js。它未被 package.json
 * 的 exports 暴露，所以只能按绝对路径导入；若 pi 调整内部结构，这个测试会失败 ——
 * 这正是我们想及早知道的兼容性破坏。
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const PKG_DIR = join(import.meta.dirname, "..");
// 解析 pi 的实际安装位置，而不是硬编码 node_modules 目录布局
const PI_DIST = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));

const TMP_ROOT = "/tmp/pi-append-system-test/render";
const TMP_CWD = join(TMP_ROOT, "cwd");
const TMP_AGENT_DIR = join(TMP_ROOT, "agent");
const STATE = join(TMP_AGENT_DIR, "append-system.json");

process.env.LANG = "en_US.UTF-8";
process.env.PI_CODING_AGENT_DIR = TMP_AGENT_DIR;
rmSync(TMP_ROOT, { recursive: true, force: true });
mkdirSync(TMP_CWD, { recursive: true });
mkdirSync(TMP_AGENT_DIR, { recursive: true });

const { normalizeBuildSystemPromptOptions, buildSystemPrompt, diffSystemPromptSections } = await import(
	pathToFileURL(join(PI_DIST, "core", "system-prompt.js")).href
);

const results = [];
async function check(name, fn) {
	try {
		await fn();
		results.push(`  PASS  ${name}`);
	} catch (error) {
		results.push(`  FAIL  ${name}\n        ${error.message.split("\n")[0]}`);
	}
}

// ---------------------------------------------------------------- 包加载

const loadResult = await discoverAndLoadExtensions([PKG_DIR], TMP_CWD, TMP_AGENT_DIR);
const loaded = loadResult.extensions.find((ext) => String(ext.path).includes("index.ts"));
const onBeforeStart = loaded?.handlers?.get?.("before_agent_start") ?? [];

await check("pi 按 package.json 的 pi manifest 加载到本包", async () => {
	assert.ok(loaded, `未加载到 index.ts，实际加载：${loadResult.extensions.map((e) => e.path).join(", ") || "(空)"}`);
});

await check("加载过程无 diagnostics/errors", async () => {
	assert.deepEqual(loadResult.errors ?? [], []);
});

await check("注册了 append-system 命令与两个事件 handler", async () => {
	assert.ok(loaded.commands.get("append-system"), "缺少 append-system 命令");
	assert.ok(loaded.handlers.get("before_agent_start")?.length, "缺少 before_agent_start");
	assert.ok(loaded.handlers.get("session_start")?.length, "缺少 session_start");
});

await check("命令描述随语言环境切换（此处为英文）", async () => {
	assert.match(loaded.commands.get("append-system").description, /no \/reload/);
});

// ---------------------------------------------------------------- 真实渲染

/** 走 pi 的真实流程：base options → 每轮 normalize 出副本 → handler → 渲染 */
async function renderTurn(baseOptions = {}) {
	const base = normalizeBuildSystemPromptOptions({ cwd: TMP_CWD, ...baseOptions });
	const perTurn = normalizeBuildSystemPromptOptions(base); // pi 每轮这样交给 handler
	for (const handler of onBeforeStart) await handler({ systemPromptOptions: perTurn }, {});
	return { prompt: buildSystemPrompt(perTurn), base, perTurn };
}

const setState = (state) => writeFileSync(STATE, JSON.stringify(state), "utf-8");

await check("启用时渲染出 <dynamic_append> 标签", async () => {
	setState({ enabled: true, items: [{ text: "规则甲", enabled: true }] });
	const { prompt } = await renderTurn();
	assert.match(prompt, /<dynamic_append>\n规则甲\n<\/dynamic_append>/);
});

await check("停用后标签与内容一起从 prompt 消失", async () => {
	setState({ enabled: false, items: [{ text: "规则甲", enabled: true }] });
	const { prompt } = await renderTurn();
	assert.ok(!prompt.includes("dynamic_append"), "不应残留任何 dynamic_append");
	assert.ok(!prompt.includes("规则甲"), "内容也不应残留");
});

await check("删除所有条目后 prompt 不含该 section", async () => {
	setState({ enabled: true, items: [] });
	const { prompt } = await renderTurn();
	assert.ok(!prompt.includes("dynamic_append"));
});

await check("与 APPEND_SYSTEM.md 的 addendum 通道共存而非覆盖", async () => {
	setState({ enabled: true, items: [{ text: "规则甲", enabled: true }] });
	const { prompt } = await renderTurn({ appendSystemPrompt: "来自 APPEND_SYSTEM.md" });
	assert.match(prompt, /<addendum>\n来自 APPEND_SYSTEM\.md\n<\/addendum>/);
	assert.match(prompt, /<dynamic_append>\n规则甲\n<\/dynamic_append>/);
});

await check("多条规则按空行连接渲染", async () => {
	setState({ enabled: true, items: [{ text: "甲" }, { text: "乙" }] });
	const { prompt } = await renderTurn();
	assert.match(prompt, /<dynamic_append>\n甲\n\n乙\n<\/dynamic_append>/);
});

await check("单条停用的规则不进入 prompt", async () => {
	setState({ enabled: true, items: [{ text: "甲" }, { text: "乙", enabled: false }] });
	const { prompt } = await renderTurn();
	assert.match(prompt, /<dynamic_append>\n甲\n<\/dynamic_append>/);
	assert.ok(!prompt.includes("乙"), "停用的乙不应出现");
});

await check("handler 不污染 pi 的 base options", async () => {
	setState({ enabled: true, items: [{ text: "规则甲" }] });
	const { base } = await renderTurn();
	assert.deepEqual(base.sections, {}, "base 的 sections 应保持为空对象");
});

await check("diff 在停用时产生 null 补丁（真正移除而非留空标签）", async () => {
	setState({ enabled: true, items: [{ text: "规则甲" }] });
	const on = await renderTurn();
	setState({ enabled: false, items: [{ text: "规则甲" }] });
	const off = await renderTurn();
	const before = Object.fromEntries(Object.entries(on.perTurn.sections).filter(([, v]) => v !== undefined));
	const patch = diffSystemPromptSections(before, off.perTurn.sections);
	assert.equal(patch.dynamic_append, null, "应为 null 补丁");
});

await check("规则内容原样保留（多行、特殊字符不被转义）", async () => {
	setState({ enabled: true, items: [{ text: "第一行\n第二行 <tag> & \"引号\"" }] });
	const { prompt } = await renderTurn();
	assert.match(prompt, /<dynamic_append>\n第一行\n第二行 <tag> & "引号"\n<\/dynamic_append>/);
});

await check("连续两轮相同状态不产生补丁（只发变化部分）", async () => {
	setState({ enabled: true, items: [{ text: "规则甲" }] });
	const first = await renderTurn();
	const second = await renderTurn();
	const patch = diffSystemPromptSections(first.perTurn.sections, second.perTurn.sections);
	assert.equal(patch, undefined, "section 未变化时不应产生补丁");
});

console.log(results.join("\n"));
const failed = results.filter((line) => line.includes("FAIL")).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed > 0 ? 1 : 0);
