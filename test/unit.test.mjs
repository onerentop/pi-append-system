/**
 * 单元测试：mock 掉 ExtensionAPI，直接驱动命令 handler 与 before_agent_start。
 * 通过 PI_CODING_AGENT_DIR 把状态文件隔离到临时目录，不触碰真实配置。
 *
 * 运行：node test/unit.test.mjs  （或 npm test）
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// 先锁定中文环境，让下面所有断言基于确定的语言；语言切换在文件末尾单独测
process.env.LANG = "zh_CN.UTF-8";
delete process.env.LC_ALL;
delete process.env.LC_MESSAGES;

const AGENT_DIR = "/tmp/pi-append-system-test/unit";
const STATE = join(AGENT_DIR, "append-system.json");
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

/** 执行命令，返回本次的 notify 输出 */
async function run(args, context = ctx) {
	log = [];
	await cmd.handler(args, context);
	return log.join("\n");
}

/** 触发 before_agent_start，返回注入的 dynamic_append section */
async function injected(event = { systemPromptOptions: { sections: {} } }) {
	for (const handler of handlers.get("before_agent_start") ?? []) await handler(event, ctx);
	return event.systemPromptOptions.sections.dynamic_append;
}

const readState = () => JSON.parse(readFileSync(STATE, "utf-8"));
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
assert.ok(handlers.get("before_agent_start")?.length, "未注册 before_agent_start");
assert.ok(handlers.get("session_start")?.length, "未注册 session_start");

// ------------------------------------------------------------ 基础行为

await check("空状态不注入 section", async () => {
	assert.equal(await injected(), undefined);
});

await check("add 去掉包裹的引号", async () => {
	await run('add "所有回答用简体中文"');
	assert.equal(readState().items[0].text, "所有回答用简体中文");
	assert.equal(readState().items[0].enabled, true);
});

await check("add 还原字面量 \\n 为换行", async () => {
	await run('add "第一条\\n第二条"');
	assert.equal(readState().items[1].text, "第一条\n第二条");
});

await check("多条规则以空行连接注入", async () => {
	assert.equal(await injected(), "所有回答用简体中文\n\n第一条\n第二条");
});

await check("ls 显示全局开关与逐条状态", async () => {
	const out = await run("ls");
	assert.match(out, /注入开关：on/);
	assert.match(out, /共 2 条，启用 2 条/);
	assert.match(out, /1\. \[on \] 所有回答用简体中文/);
	assert.match(out, /2\. \[on \] 第一条 ⏎ 第二条/);
});

await check("off N 只停用单条", async () => {
	await run("off 2");
	assert.equal(await injected(), "所有回答用简体中文");
	assert.equal(readState().enabled, true);
});

await check("on N 恢复单条", async () => {
	await run("on 2");
	assert.equal(await injected(), "所有回答用简体中文\n\n第一条\n第二条");
});

await check("全局 off 后完全不注入但保留条目", async () => {
	await run("off");
	assert.equal(await injected(), undefined);
	assert.equal(readState().items.length, 2);
	assert.match(await run("ls"), /注入开关：off/);
});

await check("全局 on 恢复注入", async () => {
	await run("on");
	assert.equal(await injected(), "所有回答用简体中文\n\n第一条\n第二条");
});

await check("edit N 就地修改（参数形式）", async () => {
	await run("edit 1 回答一律使用简体中文");
	assert.equal(await injected(), "回答一律使用简体中文\n\n第一条\n第二条");
});

await check("edit N 无文本时走编辑器并 trim 结果", async () => {
	await run("edit 2", makeCtx({ editor: async () => "  编辑器写入\n多行  " }));
	assert.equal(await injected(), "回答一律使用简体中文\n\n编辑器写入\n多行");
});

await check("rm 删除后重新编号", async () => {
	await run("rm 1");
	assert.equal(await injected(), "编辑器写入\n多行");
	assert.equal(readState().items.length, 1);
});

await check("rm 越界报错且不改动数据", async () => {
	assert.match(await run("rm 5"), /编号非法，范围 1-1/);
	assert.equal(readState().items.length, 1);
});

// ------------------------------------------------------------ 编辑器与确认交互

await check("add 在编辑器取消时无副作用", async () => {
	const before = readFileSync(STATE, "utf-8");
	await run("add", makeCtx({ editor: async () => undefined }));
	assert.equal(readFileSync(STATE, "utf-8"), before);
});

await check("add 取消编辑器时静默（不弹 warning）", async () => {
	log = [];
	await cmd.handler("add", makeCtx({ editor: async () => undefined }));
	assert.equal(log.length, 0, `不应有任何提示，实际：${log.join(" | ")}`);
});

await check("add 的空内容被拒绝", async () => {
	const before = readFileSync(STATE, "utf-8");
	assert.match(await run("add", makeCtx({ editor: async () => "   " })), /内容为空/);
	assert.equal(readFileSync(STATE, "utf-8"), before);
});

await check("clear 拒绝确认时保留数据", async () => {
	await run("clear", makeCtx({ confirm: async () => false }));
	assert.equal(readState().items.length, 1);
});

// ------------------------------------------------------------ 输入解析边界

await check("selectItems 拒绝 Number() 能接受的非法写法", async () => {
	const count = readState().items.length;
	for (const bad of ["0x2", "1e1", "1.0", "-1", "+1"]) {
		assert.match(await run(`rm ${bad}`), /编号非法/, `应拒绝 ${bad}`);
	}
	assert.equal(readState().items.length, count, "数据不应被改动");
});

await check("tab 分隔的子命令被正确识别", async () => {
	await cmd.handler("add\t标签规则", ctx);
	assert.equal(readState().items.at(-1).text, "标签规则");
	assert.match(await run("ls"), /标签规则/);
});

await check("引号只在内部无同类引号时剥离", async () => {
	await cmd.handler('add\t"a" and "b"', ctx);
	assert.equal(readState().items.at(-1).text, '"a" and "b"');
});

await check("单引号同样被剥离", async () => {
	await cmd.handler("add\t'单引号内容'", ctx);
	assert.equal(readState().items.at(-1).text, "单引号内容");
});

await check("别名 list / remove / delete 可用", async () => {
	writeFileSync(STATE, JSON.stringify({ enabled: true, items: ["甲", "乙"] }), "utf-8");
	assert.match(await run("list"), /共 2 条/);
	await run("remove 1");
	assert.equal(readState().items.length, 1);
	await run("delete 1");
	assert.equal(readState().items.length, 0);
});

await check("空参数与纯空白回退为 ls", async () => {
	writeFileSync(STATE, JSON.stringify({ enabled: true, items: ["甲"] }), "utf-8");
	assert.match(await run(""), /共 1 条/);
	assert.match(await run("   "), /共 1 条/);
});

await check("零规则时 rm/on/edit 提示 noRules 而非「范围 1-0」", async () => {
	writeFileSync(STATE, JSON.stringify({ enabled: true, items: [] }), "utf-8");
	assert.match(await run("rm 1"), /还没有任何规则/);
	assert.match(await run("on 1"), /还没有任何规则/);
	assert.match(await run("edit 1"), /还没有任何规则/);
});

await check("重复编号只计一次", async () => {
	writeFileSync(STATE, JSON.stringify({ enabled: true, items: ["甲", "乙"] }), "utf-8");
	assert.match(await run("on 1 1"), /已启用 1 条规则/);
	assert.match(await run("off 1 1 2 2"), /已停用 2 条规则/);
});

// ------------------------------------------------------------ 数据健壮性

await check("clear 确认后清空并停止注入", async () => {
	await run("clear");
	assert.equal(readState().items.length, 0);
	assert.equal(await injected(), undefined);
});

await check("损坏的 JSON 回退为空状态且可恢复", async () => {
	writeFileSync(STATE, "{ 这不是 JSON", "utf-8");
	assert.equal(await injected(), undefined);
	await run("ls"); // 命令不应抛错
	await run("add 恢复"); // 应能覆盖损坏文件
	assert.equal(readState().items[0].text, "恢复");
});

await check("损坏 JSON 被备份为 .bad 而不是静默覆盖", async () => {
	rmSync(`${STATE}.bad`, { force: true });
	writeFileSync(STATE, "{ 坏掉的", "utf-8");
	await injected();
	assert.ok(existsSync(`${STATE}.bad`), "应生成 .bad 备份");
	assert.match(readFileSync(`${STATE}.bad`, "utf-8"), /坏掉的/);
	assert.ok(!existsSync(STATE), "原文件应已改名");
	writeFileSync(STATE, JSON.stringify({ enabled: true, items: ["保留"] }), "utf-8");
});

await check("兼容字符串条目并过滤空条目", async () => {
	writeFileSync(STATE, JSON.stringify({ enabled: false, items: ["保留", { text: "" }, { text: "二", enabled: false }] }), "utf-8");
	assert.equal(await injected(), undefined, "全局 off 时即使有条目也不注入");
	await run("on");
	assert.equal(await injected(), "保留");
});

await check("原子写不残留 .tmp", async () => {
	await run("add 临时规则");
	assert.ok(!existsSync(`${STATE}.tmp`), ".tmp 应已被 rename 掉");
});

await check("状态文件落在 PI_CODING_AGENT_DIR 下", async () => {
	assert.ok(existsSync(STATE));
});

// ------------------------------------------------------------ section 契约

await check("不覆盖 appendSystemPrompt，走独立 section", async () => {
	writeFileSync(STATE, JSON.stringify({ enabled: true, items: ["保留"] }), "utf-8");
	const event = { systemPromptOptions: { sections: {}, appendSystemPrompt: "来自 APPEND_SYSTEM.md" } };
	await injected(event);
	assert.equal(event.systemPromptOptions.appendSystemPrompt, "来自 APPEND_SYSTEM.md");
	assert.equal(event.systemPromptOptions.sections.dynamic_append, "保留");
});

await check("section 名合法（Pi 要求 /^[a-z][a-z0-9_-]*$/ 且非 preamble）", async () => {
	const event = { systemPromptOptions: { sections: {} } };
	await injected(event);
	for (const name of Object.keys(event.systemPromptOptions.sections)) {
		assert.match(name, /^[a-z][a-z0-9_-]*$/);
		assert.notEqual(name, "preamble");
	}
});

// ------------------------------------------------------------ 状态栏与帮助

await check("session_start 同步状态栏为生效条数", async () => {
	writeFileSync(STATE, JSON.stringify({ enabled: true, items: ["保留"] }), "utf-8");
	log = [];
	for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
	assert.match(log.join("\n"), /status append-system=append-system: 1 条规则/);
});

await check("全局 off 时状态栏显示 off (N) 而非清空", async () => {
	await run("off");
	log = [];
	for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
	assert.match(log.join("\n"), /status append-system=append-system: off \(\d+\)/);
	await run("on");
});

await check("rm 提示序号已重排", async () => {
	await run("add 乙");
	assert.ok(readState().items.length >= 2, "前置条件：至少 2 条");
	assert.match(await run("rm 1"), /序号已重排/);
});

await check("未知子命令给出帮助", async () => {
	assert.match(await run("bogus"), /未知子命令 "bogus"/);
});

await check("help 中文文本包含状态文件路径", async () => {
	const out = await run("help");
	assert.match(out, /状态文件：/);
	assert.ok(out.includes(STATE), "应包含实际状态文件路径");
});

await check("子命令补全大小写不敏感且含全部子命令", async () => {
	assert.deepEqual(
		cmd.getArgumentCompletions("").map((i) => i.value),
		["ls", "add", "edit", "rm", "on", "off", "clear", "help"],
	);
	assert.deepEqual(cmd.getArgumentCompletions("R").map((i) => i.value), ["rm"]);
	assert.equal(cmd.getArgumentCompletions("zzz"), null);
});

// ------------------------------------------------------------ 双语

await check("LANG=zh_CN 时用中文", async () => {
	process.env.LANG = "zh_CN.UTF-8";
	delete process.env.LC_ALL;
	delete process.env.LC_MESSAGES;
	assert.match(await run("ls"), /追加规则/);
});

await check("LANG=en_US 时用英文", async () => {
	process.env.LANG = "en_US.UTF-8";
	assert.match(await run("ls"), /Append rules/);
});

await check("LANG 未设置时默认英文（分发场景）", async () => {
	delete process.env.LANG;
	delete process.env.LC_ALL;
	delete process.env.LC_MESSAGES;
	assert.match(await run("ls"), /Append rules/);
});

await check("LC_ALL 优先于 LANG", async () => {
	process.env.LANG = "en_US.UTF-8";
	process.env.LC_ALL = "zh_CN.UTF-8";
	assert.match(await run("ls"), /追加规则/);
});

await check("LC_MESSAGES 次优先于 LANG", async () => {
	delete process.env.LC_ALL;
	process.env.LC_MESSAGES = "zh_TW.UTF-8";
	assert.match(await run("ls"), /追加规则/);
});

await check("非 zh 的其它语言一律英文", async () => {
	delete process.env.LC_ALL;
	delete process.env.LC_MESSAGES;
	process.env.LANG = "ja_JP.UTF-8";
	assert.match(await run("ls"), /Append rules/);
});

await check("英文环境下注入的规则内容不受影响", async () => {
	process.env.LANG = "en_US.UTF-8";
	writeFileSync(STATE, JSON.stringify({ enabled: true, items: [{ text: "Never force-push" }] }), "utf-8");
	assert.equal(await injected(), "Never force-push");
});

console.log(results.join("\n"));
const failed = results.filter((line) => line.includes("FAIL")).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed > 0 ? 1 : 0);
