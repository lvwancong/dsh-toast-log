import { readFileSync } from "node:fs";
import { parseNotifyLine, tailEntries } from "./index.js";
import assert from "node:assert/strict";
// 真实日志路径（dsh-notify-windows 的流水）
const p = "C:/Users/Administrator/AppData/Local/Temp/dsh-notify/notify.log";
const text = readFileSync(p, "utf8");
const all = tailEntries(text, 1000);
console.log("parsed entries:", all.length, "| raw lines:", text.split(/\r?\n/).filter(Boolean).length);
assert.ok(all.length >= 4, "应至少解析出 4 条（今天实测发过 4+ 条通知）");
assert.ok(all.every((e) => e.t > 0 && typeof e.text === "undefined" ? typeof e.body === "string" : true));
const kinds = new Set(all.map((e) => e.kind));
console.log("kinds:", [...kinds].join(","));
assert.ok(kinds.has("notify"));
const last = all[all.length - 1];
console.log("newest:", JSON.stringify({ t: last.t, kind: last.kind, reason: last.reason, turn: last.turn, body: last.body.slice(0, 40) }));
// 坏行容忍
assert.equal(parseNotifyLine("not json"), null);
assert.equal(parseNotifyLine('{"event":"start","version":"0.7.8"}'), null); // 自检行应被过滤
assert.equal(tailEntries("garbage\n\n{}", 10).length, 0);
console.log("HOST-VERIFY OK");
