/**
 * Host half — 系统通知流水的只读接口。
 *
 * dsh-notify-windows 把每条系统级通知（完成/审批/报错）追加到
 * <tmp>/dsh-notify/notify.log（JSONL）。浏览器侧读不了文件，这里注册
 * GET /toast-log/notify 把最近 N 条以 JSON 返回，供铃铛面板合并展示。
 * 只读；不解析、不改写日志文件本身。
 */
import { createReadStream, watch } from "node:fs";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { dirname, basename } from "node:path";

const ROUTE = "/toast-log/notify";
const SSE_ROUTE = "/toast-log/notify/stream";
const LOG_PATH = path.join(os.tmpdir(), "dsh-notify", "notify.log");
const MAX_LINES = 300;
const clients = new Set();

/** 解析一行 JSONL；非 notify/approval 事件（start 自检等）与坏行返回 null。 */
export function parseNotifyLine(line) {
  if (!line || !line.trim()) return null;
  let j;
  try { j = JSON.parse(line); } catch { return null; }
  if (!j || (j.event !== "notify" && j.event !== "approval")) return null;
  if (typeof j.time !== "number" || typeof j.body !== "string") return null;
  return {
    t: j.time,
    kind: j.event,
    reason: typeof j.reason === "string" ? j.reason : null,
    turn: typeof j.turn === "number" ? j.turn : null,
    sessionId: typeof j.sessionId === "string" ? j.sessionId : null,
    title: typeof j.title === "string" ? j.title : null,
    body: j.body,
    url: typeof j.url === "string" ? j.url : null,
  };
}

/** 从文本尾部取最近 max 条可解析事件（按时间升序）。 */
export function tailEntries(text, max = MAX_LINES) {
  const out = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0 && out.length < max; i--) {
    const e = parseNotifyLine(lines[i]);
    if (e) out.push(e);
  }
  return out.reverse();
}

async function readTail(limit) {
  try {
    const { size } = await stat(LOG_PATH);
    // 只读尾部 512KB，避免大日志全量进内存
    const start = Math.max(0, size - 512 * 1024);
    const chunks = [];
    await new Promise((resolve, reject) => {
      const rs = createReadStream(LOG_PATH, { start });
      rs.on("data", (c) => chunks.push(c));
      rs.on("end", resolve);
      rs.on("error", reject);
    });
    return tailEntries(Buffer.concat(chunks).toString("utf8"), limit);
  } catch {
    return []; // 日志不存在=还没装/没发过通知，返回空而不是报错
  }
}

export async function apply(ctx) {
  const serve = (wctx) => {
    const server = wctx?.webServer ?? wctx?.get?.("webServer");
    if (!server?.register) return;
    const disposer = server.register({
      kind: "exact",
      path: ROUTE,
      handler: async (req, res) => {
        if (req.method !== "GET") { res.writeHead(405).end(); return; }
        try {
          const u = new URL(req.url, "http://localhost");
          const limit = Math.min(1000, Math.max(1, Number(u.searchParams.get("limit")) || 200));
          const entries = await readTail(limit);
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify({ ok: true, logPath: LOG_PATH, entries }));
        } catch (error) {
          res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
        }
      },
    });
    const sseDisposer = server.register({
      kind: "exact",
      path: SSE_ROUTE,
      handler: (req, res) => {
        if (req.method !== "GET") { res.writeHead(405).end(); return; }
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        res.write("retry: 3000\n\n");
        clients.add(res);
        req.on?.("close", () => clients.delete(res));
        res.on?.("close", () => clients.delete(res));
      },
    });
    // 盯 notify.log 所在目录（Windows 下按文件 watch 不稳，目录+过滤更可靠），
    // 300ms 去抖后向所有 SSE 客户端广播 change，浏览器收到即重拉 JSON。
    let debounce = null;
    const broadcast = () => {
      for (const res of clients) { try { res.write("data: change\n\n"); } catch { clients.delete(res); } }
    };
    let watcher = null;
    try {
      watcher = watch(dirname(LOG_PATH), (event, filename) => {
        if (filename && filename !== basename(LOG_PATH)) return;
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(broadcast, 300);
      });
    } catch { /* 目录还不存在：轮询兜底仍工作 */ }
    const keepAlive = setInterval(() => {
      for (const res of clients) { try { res.write(": ping\n\n"); } catch { clients.delete(res); } }
    }, 25000);
    try {
      (wctx ?? ctx).effect?.(() => () => {
        disposer?.(); sseDisposer?.(); watcher?.close?.(); clearInterval(keepAlive);
        if (debounce) clearTimeout(debounce);
        for (const res of clients) { try { res.end(); } catch { /* noop */ } }
        clients.clear();
      });
    } catch { /* no effect seam */ }
    ctx.logger?.info?.(`[dsh-toast-log] routes mounted: ${ROUTE} (GET) · ${SSE_ROUTE} (SSE) -> ${LOG_PATH}`);
  };
  try {
    if (typeof ctx.inject === "function") ctx.inject(["webServer"], serve);
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-toast-log] route register failed (ignored): ${error?.message ?? error}`);
  }
}
