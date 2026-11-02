// 单测：把 client.js 里的纯逻辑抠出来同构验证（client.js 依赖浏览器全局，无法直接 import）。
// 若两侧实现漂移，本测试就是刹车。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 从 client.js 源码里提取纯函数体并 eval —— 保证测的就是发布物本体。
const src = readFileSync(new URL("./client.js", import.meta.url), "utf8");
function extract(name) {
  const m = new RegExp(`function ${name}\\(([^)]*)\\) \\{`).exec(src);
  assert.ok(m, `function ${name} not found in client.js`);
  const start = m.index;
  let depth = 0, i = src.indexOf("{", start);
  for (; i < src.length; i++) { const c = src[i]; if (c === "{") depth++; else if (c === "}") { depth--; if (depth === 0) break; } }
  return src.slice(start, i + 1);
}
const NAMES = ["isToastNode", "toneOf", "textOf", "dedupeDrop", "trimCap", "unreadCount", "clampWidth", "dayKey", "dayLabelOf", "normalizeSys", "mergeEntries"];
const { isToastNode, toneOf, textOf, dedupeDrop, trimCap, unreadCount, clampWidth, dayKey, dayLabelOf, normalizeSys, mergeEntries } = eval(
  `(() => { ${NAMES.map(extract).join("\n")}
     const MAX_W = 920, MIN_W = 300, DEFAULT_W = 420;
     return { ${NAMES.join(", ")} }; })()`,
);

const el = (role, cls, hold = "") => ({
  getAttribute: (k) => (k === "role" ? role : null),
  className: cls,
  style: { getPropertyValue: (k) => (k === "--dsh-toast-hold" ? hold : "") },
});

test("isToastNode: 类名锚点命中", () => {
  assert.equal(isToastNode(el("alert", "abc _toast_l6cvn_6 def")), true);
});
test("isToastNode: CSS 变量锚点命中（类名哈希漂移兜底）", () => {
  assert.equal(isToastNode(el("alert", "renamed-hash-xyz", "3000ms")), true);
});
test("isToastNode: role 不是 alert 一律不认", () => {
  assert.equal(isToastNode(el("status", "_toast_l6cvn_6")), false);
});
test("isToastNode: 非 alert 无锚点不认", () => {
  assert.equal(isToastNode(el("alert", "dialog-root")), false);
});
test("isToastNode: null/非元素不炸", () => {
  assert.equal(isToastNode(null), false);
  assert.equal(isToastNode({}), false);
});
test("toneOf: success / warn / info 三档", () => {
  assert.equal(toneOf({}, () => ({})), "success");
  assert.equal(toneOf({}, (sel) => (sel.includes("_icon_") ? {} : null)), "warn");
  assert.equal(toneOf({}, () => null), "info");
  assert.equal(toneOf({}, null), "info");
});
test("textOf: 优先 _text_ 子节点，回退整体 textContent", () => {
  assert.equal(textOf({ textContent: "整体" }, { textContent: " 局部  " }), "局部");
  assert.equal(textOf({ textContent: "整体" }, null), "整体");
});
test("dedupeDrop: 同文同色 2s 内视为 React 双渲染重复", () => {
  const list = [{ t: 1000, text: "已复制", tone: "success" }];
  assert.equal(dedupeDrop(list, { t: 1500, text: "已复制", tone: "success" }, 2000), false);
  assert.equal(dedupeDrop(list, { t: 4000, text: "已复制", tone: "success" }, 2000), true);
  assert.equal(dedupeDrop(list, { t: 1500, text: "已删除", tone: "success" }, 2000), true);
  assert.equal(dedupeDrop([], { t: 1, text: "x", tone: "info" }, 2000), true);
});
test("trimCap: 只裁头部保最新", () => {
  const list = [1, 2, 3, 4, 5];
  assert.deepEqual(trimCap(list, 3), [3, 4, 5]);
  assert.deepEqual(trimCap(list, 10), list);
});
test("unreadCount: 按时间戳与 lastRead 比较", () => {
  const list = [{ t: 10 }, { t: 20 }, { t: 30 }];
  assert.equal(unreadCount(list, 20), 1);
  assert.equal(unreadCount(list, 0), 3);
  assert.equal(unreadCount(list, 99), 0);
});

// ── v0.1.1 面板改版新增逻辑 ──
test("clampWidth: 越界收进 [300,920]，非法回默认 420", () => {
  assert.equal(clampWidth(100), 300);
  assert.equal(clampWidth(2000), 920);
  assert.equal(clampWidth(500.6), 501);
  assert.equal(clampWidth(NaN), 420);
  assert.equal(clampWidth(0), 420);
});
test("dayKey: 同一天同键，跨天不同键", () => {
  const a = new Date(2026, 10, 2, 10, 0).getTime();
  const b = new Date(2026, 10, 2, 23, 59).getTime();
  const c = new Date(2026, 10, 3, 0, 1).getTime();
  assert.equal(dayKey(a), dayKey(b));
  assert.notEqual(dayKey(a), dayKey(c));
});
test("dayLabelOf: 今天/昨天/日期三分支", () => {
  const tt = (k) => (k === "today" ? "今天" : k);
  const now = Date.now();
  assert.equal(dayLabelOf(now, "zh", tt), "今天");
  assert.equal(dayLabelOf(now - 86400000, "zh", tt), "昨天");
  assert.match(dayLabelOf(now - 5 * 86400000, "zh", tt), /^\d{4}\/\d+\/\d+$/);
});

// ── v0.1.2 系统通知合并新增逻辑 ──
test("normalizeSys: ok+entries → src:sys 条目；approval 归 warn", () => {
  const j = { ok: true, entries: [
    { t: 10, kind: "notify", reason: "completed", body: "任务完成", url: "http://x" },
    { t: 20, kind: "approval", body: "等待审批" },
  ]};
  const out = normalizeSys(j);
  assert.equal(out.length, 2);
  assert.equal(out[0].src, "sys");
  assert.equal(out[0].tone, "success");
  assert.equal(out[1].tone, "warn");
  assert.equal(out[0].text, "任务完成");
});
test("normalizeSys: 坏响应返回 null", () => {
  assert.equal(normalizeSys(null), null);
  assert.equal(normalizeSys({ ok: false }), null);
  assert.equal(normalizeSys({ ok: true }), null);
});
test("mergeEntries: 按时间升序、t+text 去重、尾部裁剪", () => {
  const web = [{ t: 5, text: "a", tone: "info" }, { t: 9, text: "b", tone: "success" }];
  const sys = [{ t: 1, text: "s1", tone: "success", src: "sys" }, { t: 9, text: "b", tone: "success", src: "sys" }];
  const m = mergeEntries(web, sys, 10);
  assert.deepEqual(m.map((e) => e.t), [1, 5, 9]);
  assert.equal(m.length, 3); // t=9 重复只留一份
  const cut = mergeEntries(web, sys, 2);
  assert.deepEqual(cut.map((e) => e.t), [5, 9]); // 保最新
});
