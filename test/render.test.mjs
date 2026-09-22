/**
 * 集成测试：走 pi 真实的加载链路，而不是 mock。
 *
 * 1. 用 discoverAndLoadExtensions 按 package.json 的 `pi` manifest 加载本包，
 *    验证包结构，并确认已不再注册 before_agent_start（不做实时注入）。
 * 2. 跑命令写出 APPEND_SYSTEM.md 后，用 pi 自己的 DefaultResourceLoader 重新加载，
 *    断言 getAppendSystemPrompt() 读到了我们渲染的内容 —— 即 pi 在 /reload/新会话
 *    时真的会把这些规则接进 addendum 通道。
 *
 * 运行：node test/render.test.mjs
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { DefaultResourceLoader, SettingsManager, discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const PKG_DIR = join(import.meta.dirname, "..");
const TMP = "/tmp/pi-append-system-test/render";
const CWD = join(TMP, "cwd");
const AGENT = join(TMP, "agent");
const MD = join(AGENT, "APPEND_SYSTEM.md");

process.env.LANG = "en_US.UTF-8";
process.env.PI_CODING_AGENT_DIR = AGENT;
rmSync(TMP, { recursive: true, force: true });
mkdirSync(CWD, { recursive: true });
mkdirSync(AGENT, { recursive: true });

const loadResult = await discoverAndLoadExtensions([PKG_DIR], CWD, AGENT);
const loaded = loadResult.extensions.find((ext) => String(ext.path).includes("index.ts"));
const cmd = loaded?.commands?.get("append-system");

const ctx = {
	ui: { notify() {}, editor: async () => undefined, confirm: async () => true, setStatus() {} },
};
const runCmd = (args) => cmd.handler(args, ctx);
const readMd = () => (existsSync(MD) ? readFileSync(MD, "utf-8") : null);

/** pi 内核在一次 reload 时会读到的 append system prompt（读的是 AGENT/APPEND_SYSTEM.md）。 */
async function piReloadSeesAppend() {
	const settingsManager = SettingsManager.create(CWD, AGENT);
	const loader = new DefaultResourceLoader({ cwd: CWD, agentDir: AGENT, settingsManager });
	await loader.reload();
	const parts = loader.getAppendSystemPrompt?.() ?? [];
	return parts.join("\n");
}

const results = [];
async function check(name, fn) {
	try {
		await fn();
		results.push(`  PASS  ${name}`);
	} catch (error) {
		results.push(`  FAIL  ${name}\n        ${error.message.split("\n")[0]}`);
	}
}

await check("pi 按 manifest 加载本包，无 errors", async () => {
	assert.ok(loaded, `未加载到 index.ts：${loadResult.extensions.map((e) => e.path).join(", ") || "(空)"}`);
	assert.deepEqual(loadResult.errors ?? [], []);
	assert.ok(cmd, "缺少 append-system 命令");
});

await check("已不再注册 before_agent_start；仅保留 session_start", async () => {
	assert.ok(!loaded.handlers.get("before_agent_start"), "不应再有 before_agent_start");
	assert.ok(loaded.handlers.get("session_start")?.length, "应保留 session_start");
});

await check("命令描述随语言切换（此处英文）", async () => {
	assert.match(cmd.description, /APPEND_SYSTEM\.md/);
});

await check("空状态时 pi 读不到任何 append 内容", async () => {
	assert.equal(readMd(), null);
	assert.equal((await piReloadSeesAppend()).trim(), "");
});

await check("add 后 pi reload 能读到规则（addendum 通道）", async () => {
	await runCmd('add "Never force-push to main"');
	await runCmd('add "Always answer in Chinese"');
	assert.match(readMd(), /Never force-push to main\n\nAlways answer in Chinese\n/);
	const seen = await piReloadSeesAppend();
	assert.match(seen, /Never force-push to main/);
	assert.match(seen, /Always answer in Chinese/);
});

await check("off N 后 pi 读到的内容同步减少", async () => {
	await runCmd("off 1");
	const seen = await piReloadSeesAppend();
	assert.ok(!seen.includes("Never force-push"), "停用的规则不应再被 pi 读到");
	assert.match(seen, /Always answer in Chinese/);
});

await check("全局 off 后 pi 读不到 append，文件被移除", async () => {
	await runCmd("off");
	assert.equal(readMd(), null);
	assert.equal((await piReloadSeesAppend()).trim(), "");
});

await check("全局 on 后 pi 重新读到内容", async () => {
	await runCmd("on");
	assert.match(await piReloadSeesAppend(), /Always answer in Chinese/);
});

await check("多行 / 特殊字符内容原样进入 pi 的 append", async () => {
	await runCmd("clear");
	// 字面 \\n 还原为换行；<tag>/&/# 等特殊字符原样传递（不测内层引号，normalizeInput 不处理 \\" 转义）
	await runCmd('add "第一行\\n第二行 <tag> & 井号#"');
	const seen = await piReloadSeesAppend();
	assert.match(seen, /第一行\n第二行 <tag> & 井号#/);
});

await check("clear 后 pi 读不到 append", async () => {
	await runCmd("clear");
	assert.equal((await piReloadSeesAppend()).trim(), "");
});

console.log(results.join("\n"));
const failed = results.filter((line) => line.includes("FAIL")).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed > 0 ? 1 : 0);
