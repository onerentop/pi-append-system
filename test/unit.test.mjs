/**
 * 单元测试：mock 掉 ExtensionAPI，驱动命令 handler。
 * 通过 PI_CODING_AGENT_DIR 把台账与 APPEND_SYSTEM.md 隔离到临时目录，不碰真实配置。
 *
 * 运行：node test/unit.test.mjs
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// 先锁定中文环境，让下面的断言基于确定语言；语言切换在文件末尾单独测
process.env.LANG = "zh_CN.UTF-8";
delete process.env.LC_ALL;
delete process.env.LC_MESSAGES;

const AGENT_DIR = "/tmp/pi-append-system-test/unit";
const STATE = join(AGENT_DIR, "append-system.json");
const MD = join(AGENT_DIR, "APPEND_SYSTEM.md");
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
rmSync(AGENT_DIR, { recursive: true, force: true });
mkdirSync(AGENT_DIR, { recursive: true });

const { default: appendSystemExtension } = await import("../index.ts");

let log = [];
const commands = new Map();
const handlers = new Map();
const pi = {
	registerCommand: (name, opts) => commands.set(name, opts),
	on: (event, handler) => {
		if (!handlers.has(event)) handlers.set(event, []);
		handlers.get(event).push(handler);
	},
};

function makeCtx(overrides = {}) {
	return {
		ui: {
			notify: (message, type = "info") => log.push(`${type}: ${message}`),
			editor: async () => undefined,
			confirm: async () => true,
			setStatus: (key, text) => log.push(`status ${key}=${text}`),
			...overrides,
		},
	};
}

appendSystemExtension(pi);
const cmd = commands.get("append-system");
const ctx = makeCtx();

async function run(args, context = ctx) {
	log = [];
	await cmd.handler(args, context);
	return log.join("\n");
}

const readState = () => JSON.parse(readFileSync(STATE, "utf-8"));
const readMd = () => (existsSync(MD) ? readFileSync(MD, "utf-8") : null);

const results = [];
async function check(name, fn) {
	try {
		await fn();
		results.push(`  PASS  ${name}`);
	} catch (error) {
		results.push(`  FAIL  ${name}\n        ${error.message.split("\n")[0]}`);
	}
}

assert.ok(cmd, "命令 /append-system 未注册");
assert.ok(handlers.get("session_start")?.length, "未注册 session_start");

// ------------------------------------------------------------ 核心：写 APPEND_SYSTEM.md

await check("扩展不再注册 before_agent_start（不做实时注入）", async () => {
	assert.ok(!handlers.get("before_agent_start"), "不应有 before_agent_start handler");
});

await check("空状态不产生 APPEND_SYSTEM.md", async () => {
	assert.equal(readMd(), null);
});

await check("add 写入 APPEND_SYSTEM.md 并去引号", async () => {
	await run('add "所有回答用简体中文"');
	assert.equal(readState().items[0].text, "所有回答用简体中文");
	assert.equal(readMd(), "所有回答用简体中文\n");
});

await check("add 提示包含 /reload", async () => {
	assert.match(await run('add "第二条"'), /\/reload/);
});

await check("多条规则以空行连接写入", async () => {
	assert.equal(readMd(), "所有回答用简体中文\n\n第二条\n");
});

await check("字面量 \\n 还原为换行后写入", async () => {
	await run('add "甲\\n乙"');
	assert.match(readMd(), /甲\n乙\n$/);
});

await check("ls 显示全局开关与逐条状态", async () => {
	const out = await run("ls");
	assert.match(out, /注入开关：on/);
	assert.match(out, /共 3 条，启用 3 条/);
	assert.match(out, /1\. \[on \] 所有回答用简体中文/);
});

await check("off N 从 APPEND_SYSTEM.md 移除单条", async () => {
	await run("off 2");
	assert.equal(readMd(), "所有回答用简体中文\n\n甲\n乙\n");
	assert.equal(readState().enabled, true);
	assert.match(log.join("\n"), /reload/);
});

await check("on N 恢复单条", async () => {
	await run("on 2");
	assert.equal(readMd(), "所有回答用简体中文\n\n第二条\n\n甲\n乙\n");
});

await check("全局 off 移除 APPEND_SYSTEM.md 但保留台账", async () => {
	await run("off");
	assert.equal(readMd(), null);
	assert.equal(readState().enabled, false);
	assert.equal(readState().items.length, 3);
	assert.match(await run("ls"), /注入开关：off/);
});

await check("全局 on 重建 APPEND_SYSTEM.md", async () => {
	await run("on");
	assert.match(readMd(), /所有回答用简体中文/);
});

await check("edit 就地修改并重渲染", async () => {
	await run("edit 1 回答一律用简体中文");
	assert.match(readMd(), /^回答一律用简体中文\n\n/);
});

await check("edit 无文本时走编辑器并 trim", async () => {
	await run("edit 2", makeCtx({ editor: async () => "  编辑器写入  " }));
	assert.match(readMd(), /编辑器写入/);
	assert.ok(!readMd().includes("编辑器写入  "), "应已 trim");
});

await check("rm 删除后重新编号并重渲染", async () => {
	const before = readState().items.length;
	await run("rm 1");
	assert.equal(readState().items.length, before - 1);
	assert.ok(!readMd().includes("回答一律用简体中文"), "被删的规则应从文件消失");
	assert.match(await run("rm 1"), /序号已重排/);
});

await check("rm 越界报错且不改动数据", async () => {
	const before = readState().items.length;
	assert.match(await run("rm 99"), /编号非法/);
	assert.equal(readState().items.length, before);
});

// ------------------------------------------------------------ 交互与解析

await check("add 编辑器取消时静默且无副作用", async () => {
	const beforeState = readFileSync(STATE, "utf-8");
	const beforeMd = readMd();
	log = [];
	await cmd.handler("add", makeCtx({ editor: async () => undefined }));
	assert.equal(log.length, 0);
	assert.equal(readFileSync(STATE, "utf-8"), beforeState);
	assert.equal(readMd(), beforeMd);
});

await check("add 空内容被拒绝", async () => {
	assert.match(await run("add", makeCtx({ editor: async () => "   " })), /内容为空/);
});

await check("tab 分隔子命令 + 引号边界", async () => {
	writeFileSync(STATE, JSON.stringify({ enabled: true, items: [] }), "utf-8");
	await cmd.handler('add\t"a" and "b"', ctx);
	assert.equal(readState().items.at(-1).text, '"a" and "b"');
});

await check("selectItems 拒绝 0x2/1e1/1.0/-1/+1", async () => {
	writeFileSync(STATE, JSON.stringify({ enabled: true, items: ["甲", "乙"] }), "utf-8");
	for (const bad of ["0x2", "1e1", "1.0", "-1", "+1"]) {
		assert.match(await run(`rm ${bad}`), /编号非法/, `应拒绝 ${bad}`);
	}
	assert.equal(readState().items.length, 2);
});

await check("零规则时越界提示范围 1-0（未引入 noRules）", async () => {
	writeFileSync(STATE, JSON.stringify({ enabled: true, items: [] }), "utf-8");
	assert.match(await run("rm 1"), /范围 1-0/);
	assert.match(await run("on 1"), /范围 1-0/);
});

await check("重复编号按出现次数计数", async () => {
	writeFileSync(STATE, JSON.stringify({ enabled: true, items: ["甲", "乙"] }), "utf-8");
	assert.match(await run("on 1 1"), /已启用 2 条/);
});

await check("别名 list/remove/delete 可用", async () => {
	writeFileSync(STATE, JSON.stringify({ enabled: true, items: ["甲", "乙"] }), "utf-8");
	assert.match(await run("list"), /共 2 条/);
	await run("remove 1");
	assert.equal(readState().items.length, 1);
	await run("delete 1");
	assert.equal(readState().items.length, 0);
	assert.equal(readMd(), null, "删空后 APPEND_SYSTEM.md 应移除");
});

await check("空参数回退为 ls", async () => {
	writeFileSync(STATE, JSON.stringify({ enabled: true, items: ["甲"] }), "utf-8");
	assert.match(await run(""), /共 1 条/);
	assert.match(await run("   "), /共 1 条/);
});

// ------------------------------------------------------------ 数据健壮性

await check("clear 拒绝确认时保留数据", async () => {
	writeFileSync(STATE, JSON.stringify({ enabled: true, items: ["甲"] }), "utf-8");
	renderFromState();
	await run("clear", makeCtx({ confirm: async () => false }));
	assert.equal(readState().items.length, 1);
});

await check("clear 确认后清空并移除文件", async () => {
	await run("clear");
	assert.equal(readState().items.length, 0);
	assert.equal(readMd(), null);
});

await check("原子写不残留 .tmp", async () => {
	await run('add "临时"');
	assert.ok(!existsSync(`${STATE}.tmp`), "台账 .tmp 应已 rename");
	assert.ok(!existsSync(`${MD}.tmp`), "md .tmp 应已 rename");
});

await check("损坏台账回退为空并可恢复", async () => {
	writeFileSync(STATE, "{ 坏掉的", "utf-8");
	assert.match(await run("ls"), /规则为空/);
	assert.ok(existsSync(`${STATE}.bad`), "损坏文件应被备份为 .bad");
	await run('add "恢复"');
	assert.equal(readState().items[0].text, "恢复");
});

await check("兼容字符串条目并过滤空条目", async () => {
	writeFileSync(STATE, JSON.stringify({ enabled: true, items: ["保留", { text: "" }, { text: "二", enabled: false }] }), "utf-8");
	assert.match(await run("ls"), /共 2 条，启用 1 条/);
});

// ------------------------------------------------------------ 首次接管备份

await check("首次接管前备份已存在的手写 APPEND_SYSTEM.md", async () => {
	rmSync(AGENT_DIR, { recursive: true, force: true });
	mkdirSync(AGENT_DIR, { recursive: true });
	writeFileSync(MD, "我是用户手写的原始内容\n", "utf-8");
	const out = await run('add "工具规则"');
	assert.match(out, /已备份/);
	assert.equal(readFileSync(`${MD}.bak`, "utf-8"), "我是用户手写的原始内容\n");
	assert.equal(readMd(), "工具规则\n", "接管后写入工具规则");
});

await check("台账被删后再改动不覆盖已有 .bak（P1）", async () => {
	rmSync(AGENT_DIR, { recursive: true, force: true });
	mkdirSync(AGENT_DIR, { recursive: true });
	writeFileSync(MD, "原始手写内容\n", "utf-8");
	await run('add "工具规则"'); // 首次接管：备份到 .bak
	assert.equal(readFileSync(`${MD}.bak`, "utf-8"), "原始手写内容\n");
	rmSync(STATE, { force: true }); // 用户手动删台账
	const out = await run('add "又一条"');
	assert.ok(!out.includes("已备份"), ".bak 已存在时不应再提示备份");
	assert.equal(readFileSync(`${MD}.bak`, "utf-8"), "原始手写内容\n", ".bak 应保留最初的手写内容");
});

await check("已有台账后不再重复备份", async () => {
	rmSync(`${MD}.bak`, { force: true });
	const out = await run('add "第二条工具规则"');
	assert.ok(!out.includes("已备份"), "已接管则不再备份");
	assert.ok(!existsSync(`${MD}.bak`));
});

// ------------------------------------------------------------ 状态栏

await check("session_start 同步状态栏为启用条数", async () => {
	writeFileSync(STATE, JSON.stringify({ enabled: true, items: ["甲", "乙"] }), "utf-8");
	log = [];
	for (const h of handlers.get("session_start") ?? []) await h({}, ctx);
	assert.match(log.join("\n"), /status append-system=append-system: 2 条/);
});

await check("全局 off 状态栏显示 off (N)", async () => {
	writeFileSync(STATE, JSON.stringify({ enabled: false, items: ["甲", "乙"] }), "utf-8");
	log = [];
	for (const h of handlers.get("session_start") ?? []) await h({}, ctx);
	assert.match(log.join("\n"), /append-system: off \(2\)/);
});

// ------------------------------------------------------------ 双语

await check("英文环境命令与列表用英文", async () => {
	process.env.LANG = "en_US.UTF-8";
	writeFileSync(STATE, JSON.stringify({ enabled: true, items: ["x"] }), "utf-8");
	assert.match(await run("ls"), /Rules \(inject: on\)/);
	assert.match(await run('add "y"'), /\/reload to apply/);
});

await check("LANG 未设置默认英文；LC_ALL 优先", async () => {
	delete process.env.LANG;
	delete process.env.LC_ALL;
	delete process.env.LC_MESSAGES;
	assert.match(await run("ls"), /Rules \(inject/);
	process.env.LC_ALL = "zh_CN.UTF-8";
	assert.match(await run("ls"), /规则（注入开关/);
});

// 供 clear 测试用：从台账重渲染 APPEND_SYSTEM.md（不经命令）
function renderFromState() {
	const s = readState();
	const body = s.enabled ? s.items.filter((i) => i.enabled).map((i) => i.text).join("\n\n").trim() : "";
	if (body) writeFileSync(MD, `${body}\n`, "utf-8");
	else rmSync(MD, { force: true });
}

console.log(results.join("\n"));
const failed = results.filter((line) => line.includes("FAIL")).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed > 0 ? 1 : 0);
