/**
 * dsh-toast-log — Toast 留痕铃铛
 *
 * 宿主 GUI 的系统 toast（复制成功、删除完成、错误提示…）一闪而过、无处回看。
 * 本插件用 MutationObserver 盯住 document.body 上新挂载的 toast 节点
 * （宿主 ui-primitives Toast：createPortal(body) + div[role="alert"] +
 *  CSS-module `_toast_*` 类 + `--dsh-toast-hold` 样式变量，双锚点匹配），
 * 把文本/色调/时间戳记进 localStorage 环形历史，并在侧栏底部放一个铃铛：
 * 未读角标 + 点开可回看全部历史（标为已读 / 清空 / 单条删除）。
 *
 * 面板经 createPortal 挂到 body 上以 position:fixed 定位：不受侧栏宽度
 * 与 overflow 裁剪；左缘把手可拖拽调宽（持久化）。react-dom 不可用时
 * 回退为侧栏内嵌弹层（旧行为）。
 *
 * 纯浏览器侧插件，零宿主内部 API 依赖；宿主升级改了 toast 结构时，
 * 只需更新 isToastNode/toneOf/textOf 三个匹配函数。
 */
window.__ModuleLoader__.load({
  id: 'dsh-toast-log',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    let createPortal = null;
    try { createPortal = require('react-dom').createPortal; } catch { createPortal = null; }

    // ── 存储键 ──
    const KEY = 'dsh.toast-log.entries-v1';
    const READ_KEY = 'dsh.toast-log.last-read-v1';
    const ENABLE_KEY = 'dsh.toast-log.enabled';
    const CAP_KEY = 'dsh.toast-log.capacity';
    const WIDTH_KEY = 'dsh.toast-log.width-v1';
    const LANG_KEY = 'dsh.toast-log.lang';
    const STYLE_ID = 'dsh-toast-log-style';
    const MAX_CAP = 1000;
    const DEFAULT_CAP = 200;
    const MIN_W = 300, MAX_W = 920, DEFAULT_W = 420;

    const STRINGS = {
      zh: {
        title: 'Toast 历史',
        aria: '查看 toast 提示历史',
        empty: '还没有记录到提示。',
        markRead: '全部已读',
        clearAll: '清空',
        dismiss: '删除这条',
        resize: '拖拽调整宽度',
        settingsTitle: 'Toast 留痕铃铛',
        settingsHint: '把界面里一闪而过的系统 toast 记入侧栏铃铛历史（localStorage 持久化）',
        capacity: '历史保留条数',
        today: '今天',
        tabAll: '全部',
        tabWeb: '网页',
        tabSys: '系统',
        sysFailed: '系统通知读取失败',
        langLabel: '中文',
        langTip: 'Switch to English',
      },
      en: {
        title: 'Toast history',
        aria: 'View toast notification history',
        empty: 'No toasts captured yet.',
        markRead: 'Mark all read',
        clearAll: 'Clear',
        dismiss: 'Remove',
        resize: 'Drag to resize',
        settingsTitle: 'Toast Log bell',
        settingsHint: 'Record transient system toasts into a sidebar history (persisted in localStorage)',
        capacity: 'History capacity',
        today: 'Today',
        tabAll: 'All',
        tabWeb: 'Web',
        tabSys: 'System',
        sysFailed: 'failed to load system notifications',
        langLabel: 'English',
        langTip: '切换到中文',
      },
    };
    // 语言：用户覆盖（面板一键切换）> 浏览器语言。切换持久化，无需改浏览器设置。
    const guessLang = () => ((navigator.language || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en');
    let curLang = (() => { try { const v = localStorage.getItem(LANG_KEY); return v === 'zh' || v === 'en' ? v : guessLang(); } catch { return guessLang(); } })();
    const t = (k, vars) => {
      let s = (STRINGS[curLang] && STRINGS[curLang][k]) || STRINGS.en[k] || k;
      if (vars) for (const [a, b] of Object.entries(vars)) s = s.replace(`{${a}}`, b);
      return s;
    };
    function setLang(l) {
      curLang = l;
      try { localStorage.setItem(LANG_KEY, l); } catch { /* private mode */ }
      notify();
    }

    // ── 纯逻辑（可单测，元素用 duck-typing）──
    function isToastNode(el) {
      if (!el || typeof el.getAttribute !== 'function') return false;
      if (el.getAttribute('role') !== 'alert') return false;
      const cls = typeof el.className === 'string' ? el.className : '';
      const hasToastClass = /(^|[\s_])_?toast[\s_]/i.test(cls);
      let hold = '';
      try { hold = el.style && el.style.getPropertyValue ? el.style.getPropertyValue('--dsh-toast-hold') : ''; } catch { hold = ''; }
      return hasToastClass || (hold || '').length > 0;
    }
    function toneOf(el, find) {
      if (find && find('[class*="_success_"]')) return 'success';
      if (find && find('[class*="_icon_"]')) return 'warn';
      return 'info';
    }
    function textOf(el, textNode) {
      const own = textNode && typeof textNode.textContent === 'string' ? textNode.textContent : '';
      const all = typeof el.textContent === 'string' ? el.textContent : '';
      return (own || all || '').trim();
    }
    function dedupeDrop(list, entry, windowMs) {
      // 同 text+tone 且时间差 < windowMs 视为 React 双渲染重复，丢弃
      const last = list[list.length - 1];
      if (last && last.text === entry.text && last.tone === entry.tone && entry.t - last.t < windowMs) return false;
      return true;
    }
    function trimCap(list, cap) { return list.length > cap ? list.slice(list.length - cap) : list; }
    function unreadCount(list, lastRead) { return list.filter((e) => e.t > lastRead).length; }
    function normalizeSys(raw) {
      // 宿主路由返回的 {ok,entries} → 统一条目形状（src:'sys'）
      if (!raw || !raw.ok || !Array.isArray(raw.entries)) return null;
      return raw.entries.map((e) => ({
        t: e.t,
        text: String(e.body || '').trim(),
        tone: e.kind === 'approval' || e.reason === 'error' ? 'warn' : 'success',
        src: 'sys',
        reason: e.reason || e.kind || null,
        url: e.url || null,
      }));
    }
    function mergeEntries(web, sys, capN) {
      const seen = new Set();
      const out = [];
      for (const e of web.concat(sys)) {
        const k = e.t + '|' + e.text;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(e);
      }
      out.sort((a, b) => a.t - b.t);
      return out.length > capN ? out.slice(out.length - capN) : out;
    }
    function clampWidth(w) { return Math.min(MAX_W, Math.max(MIN_W, Math.round(w) || DEFAULT_W)); }
    function dayKey(ts) { const d = new Date(ts); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; }
    function dayLabelOf(ts, lang2, t2) {
      const now = new Date();
      const d = new Date(ts);
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      if (ts >= midnight) return t2('today');
      const yest = midnight - 86400000;
      if (ts >= yest) return lang2 === 'zh' ? '昨天' : 'Yesterday';
      return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
    }

    // ── 存储 ──
    const enabled = () => localStorage.getItem(ENABLE_KEY) !== '0';
    const cap = () => Math.min(MAX_CAP, Math.max(10, Number(localStorage.getItem(CAP_KEY)) || DEFAULT_CAP));
    function load() { try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } }
    function save(list) { try { localStorage.setItem(KEY, JSON.stringify(trimCap(list, cap()))); } catch { /* quota */ } }
    const lastRead = () => Number(localStorage.getItem(READ_KEY)) || 0;
    const savedWidth = () => { try { return clampWidth(Number(localStorage.getItem(WIDTH_KEY)) || DEFAULT_W); } catch { return DEFAULT_W; } };

    function notify() { window.dispatchEvent(new CustomEvent('dsh-toast-log-updated')); }

    // ── 观察者：只装一次 ──
    let observerStarted = false;
    function record(list, entry) {
      if (!dedupeDrop(list, entry, 2000)) return;
      list.push(entry);
      save(list);
      notify();
    }
    function watchNode(node) {
      // toast 文本更新可能复用同一 DOM 节点（React 不重挂载），
      // 给节点挂子树观察器补漏：文本变了就再记一条。节点销毁后随 GC 回收。
      const textNode = node.querySelector ? node.querySelector('[class*="_text_"]') : null;
      let lastText = textOf(node, textNode);
      if (!lastText) return;
      const tone = toneOf(node, node.querySelector ? node.querySelector.bind(node) : null);
      record(load(), { t: Date.now(), text: lastText, tone });
      try {
        const sub = new MutationObserver(() => {
          const now = textOf(node, node.querySelector ? node.querySelector('[class*="_text_"]') : null);
          if (now && now !== lastText) {
            lastText = now;
            record(load(), { t: Date.now(), text: now, tone: toneOf(node, node.querySelector ? node.querySelector.bind(node) : null) });
          }
        });
        sub.observe(node, { childList: true, subtree: true, characterData: true });
      } catch { /* 观察失败不影响主链路 */ }
    }
    function startObserver() {
      if (observerStarted) return;
      observerStarted = true;
      const seen = new WeakSet();
      const mo = new MutationObserver((mutations) => {
        if (!enabled()) return;
        for (const m of mutations) {
          for (const n of m.addedNodes) {
            if (!isToastNode(n) || seen.has(n)) continue;
            seen.add(n);
            watchNode(n);
          }
        }
      });
      mo.observe(document.body, { childList: true });
    }

    // ── 样式 ──
    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return;
      const el = document.createElement('style');
      el.id = STYLE_ID;
      el.textContent = `
.dtl-root{position:relative;display:inline-flex}
.dtl-bell{position:relative;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:0;border-radius:6px;background:none;color:inherit;cursor:pointer;font-size:15px;line-height:1}
.dtl-bell:hover{background:color-mix(in srgb,currentColor 10%,transparent)}
.dtl-badge{position:absolute;top:-2px;right:-4px;min-width:15px;height:15px;padding:0 4px;border-radius:8px;background:var(--dsw-alias-state-error-primary,#e5484d);color:#fff;font-size:10px;font-weight:600;display:flex;align-items:center;justify-content:center}
.dtl-panel{position:fixed;z-index:1300;display:flex;flex-direction:column;border-radius:12px;border:1px solid color-mix(in srgb,currentColor 14%,transparent);background:var(--dsw-alias-bg-primary,#1b1c1f);color:var(--dsw-alias-label-primary,inherit);box-shadow:0 16px 48px rgba(0,0,0,.42);font-size:13px;animation:dtl-in .14s ease-out}
.dtl-panel.inline{position:absolute;left:0;bottom:34px;z-index:1200}
@keyframes dtl-in{0%{opacity:0;transform:translateY(6px)}100%{opacity:1;transform:none}}
.dtl-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid color-mix(in srgb,currentColor 10%,transparent)}
.dtl-head b{flex:1;font-size:13px;font-weight:600}
.dtl-actions{display:flex;gap:6px}
.dtl-tabs{display:flex;gap:2px;margin-left:auto;background:color-mix(in srgb,currentColor 7%,transparent);border-radius:8px;padding:2px}
.dtl-tab{border:0;background:none;color:inherit;opacity:.65;border-radius:6px;padding:3px 9px;font-size:11px;cursor:pointer}
.dtl-tab.on{background:color-mix(in srgb,currentColor 14%,transparent);opacity:1;font-weight:600}
.dtl-tag{flex:none;font-size:10px;line-height:14px;padding:0 5px;margin-top:2px;border-radius:4px;background:color-mix(in srgb,currentColor 10%,transparent);color:color-mix(in srgb,currentColor 75%,transparent)}
.dtl-syserr{padding:6px 14px;font-size:11px;color:var(--dsw-alias-state-warn-primary,#d98a2b)}
.dtl-btn{border:1px solid color-mix(in srgb,currentColor 18%,transparent);background:none;color:inherit;border-radius:6px;padding:4px 10px;font-size:11px;cursor:pointer}
.dtl-btn:hover{background:color-mix(in srgb,currentColor 8%,transparent)}
.dtl-list{overflow-y:auto;padding:4px 0 8px}
.dtl-day{padding:10px 14px 4px;font-size:11px;font-weight:600;color:color-mix(in srgb,currentColor 55%,transparent);position:sticky;top:0;background:var(--dsw-alias-bg-primary,#1b1c1f)}
.dtl-row{display:flex;align-items:flex-start;gap:9px;padding:7px 14px}
.dtl-row:hover{background:color-mix(in srgb,currentColor 5%,transparent)}
.dtl-dot{flex:none;width:6px;height:6px;margin-top:7px;border-radius:50%;background:var(--dsw-alias-interactive-primary,#4d8dff)}
.dtl-dot.success{background:var(--dsw-alias-state-success-primary,#46a758)}
.dtl-dot.warn{background:var(--dsw-alias-state-warn-primary,#d98a2b)}
.dtl-dot.read{background:transparent;border:1px solid color-mix(in srgb,currentColor 25%,transparent)}
.dtl-time{flex:none;color:color-mix(in srgb,currentColor 60%,transparent);font-variant-numeric:tabular-nums;font-size:11px;margin-top:2px}
.dtl-text{flex:1;min-width:0;line-height:1.45;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dtl-row.open .dtl-text{white-space:pre-wrap;word-break:break-word}
.dtl-x{flex:none;border:0;background:none;color:inherit;opacity:0;cursor:pointer;padding:0 2px;font-size:12px;margin-top:1px}
.dtl-row:hover .dtl-x{opacity:.6}
.dtl-x:hover{opacity:1!important}
.dtl-empty{padding:26px 12px;text-align:center;color:color-mix(in srgb,currentColor 55%,transparent)}
.dtl-cap{display:flex;align-items:center;gap:8px;padding:9px 14px;border-top:1px solid color-mix(in srgb,currentColor 10%,transparent);color:color-mix(in srgb,currentColor 75%,transparent);font-size:11px}
.dtl-cap input{width:52px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:5px;background:none;color:inherit;padding:2px 6px;font-size:11px}
.dtl-resize{position:absolute;right:-3px;top:8px;bottom:8px;width:10px;cursor:ew-resize;border-radius:5px;display:flex;align-items:center;justify-content:center}
.dtl-resize::after{content:"";width:3px;height:28px;border-radius:2px;background:color-mix(in srgb,currentColor 28%,transparent)}
.dtl-resize:hover::after,.dtl-resize.active::after{background:var(--dsw-alias-interactive-primary,#4d8dff);height:48px}
.dtl-settings{display:flex;align-items:center;gap:10px}
`;
      document.head.appendChild(el);
    }

    // ── 铃铛 + 面板 ──
    function Bell() {
      const [open, setOpen] = React.useState(false);
      const [entries, setEntries] = React.useState(load);
      const [sys, setSys] = React.useState([]);
      const [sysErr, setSysErr] = React.useState(false);
      const [tab, setTab] = React.useState('all'); // all | web | sys
      const [lang, setLangState] = React.useState(curLang);
      const switchLang = () => { const next = curLang === 'zh' ? 'en' : 'zh'; setLang(next); setLangState(next); };
      const [expanded, setExpanded] = React.useState(() => new Set()); // 点开看全文的行
      const [readTs, setReadTs] = React.useState(lastRead);
      const [width, setWidth] = React.useState(savedWidth);
      const [pos, setPos] = React.useState(null);
      const bellRef = React.useRef(null);
      const panelRef = React.useRef(null);
      const dragging = React.useRef(false);

      const sysSig = React.useRef('');
      const fetchSys = React.useCallback(() => {
        fetch('/toast-log/notify?limit=200', { credentials: 'same-origin' })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error('http ' + r.status))))
          .then((j) => {
            const list = normalizeSys(j);
            if (!list) { setSysErr(true); return; }
            setSysErr(false);
            // 内容没变不触发重渲染（轮询安静跑）
            const sig = list.length ? list[list.length - 1].t + '|' + list.length : '0';
            if (sig !== sysSig.current) { sysSig.current = sig; setSys(list); }
          })
          .catch(() => setSysErr(true));
      }, []);

      React.useEffect(() => {
        const sync = () => { setEntries(load()); setReadTs(lastRead()); };
        window.addEventListener('dsh-toast-log-updated', sync);
        window.addEventListener('storage', sync);
        return () => { window.removeEventListener('dsh-toast-log-updated', sync); window.removeEventListener('storage', sync); };
      }, []);
      React.useEffect(() => { if (open) fetchSys(); }, [open, fetchSys]);
      // 感知通道 1：SSE——宿主盯 notify.log 文件，追加即广播（亚秒级）。
      // 感知通道 2：60s 轮询兜底（SSE 断开/宿主半未装载时仍能最终一致）。
      React.useEffect(() => {
        fetchSys();
        let es = null;
        try {
          es = new EventSource('/toast-log/notify/stream');
          es.onmessage = () => fetchSys();
          es.onerror = () => { /* EventSource 自动重连；期间靠轮询兜底 */ };
        } catch { es = null; }
        const timer = setInterval(fetchSys, 60000);
        return () => { clearInterval(timer); try { es?.close(); } catch { /* noop */ } };
      }, [fetchSys]);

      // 面板定位：贴铃铛上方、左缘对齐铃铛；越界时向内收。
      const reposition = React.useCallback(() => {
        if (!bellRef.current) return;
        const r = bellRef.current.getBoundingClientRect();
        const vw = window.innerWidth;
        let left = r.left;
        if (left + width + 12 > vw) left = Math.max(8, vw - width - 12);
        setPos({ left, bottom: window.innerHeight - r.top + 8 });
      }, [width]);
      React.useEffect(() => {
        if (!open || !createPortal) return;
        reposition();
        const onMove = () => { if (!dragging.current) reposition(); };
        window.addEventListener('resize', onMove);
        window.addEventListener('scroll', onMove, true);
        return () => { window.removeEventListener('resize', onMove); window.removeEventListener('scroll', onMove, true); };
      }, [open, reposition]);

      // 点击外部关闭
      React.useEffect(() => {
        if (!open) return;
        const onDown = (ev) => {
          if (panelRef.current && panelRef.current.contains(ev.target)) return;
          if (bellRef.current && bellRef.current.contains(ev.target)) return;
          setOpen(false);
        };
        document.addEventListener('mousedown', onDown, true);
        return () => document.removeEventListener('mousedown', onDown, true);
      }, [open]);

      // 拖拽调宽（右缘把手：向右拖变宽；面板左缘锚定在铃铛上方）
      const startResize = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        dragging.current = true;
        const startX = ev.clientX;
        const startW = width;
        const move = (e) => setWidth(clampWidth(startW + (e.clientX - startX)));
        const up = () => {
          dragging.current = false;
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
          document.body.style.userSelect = '';
        };
        document.body.style.userSelect = 'none';
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      };
      React.useEffect(() => { localStorage.setItem(WIDTH_KEY, String(width)); }, [width]);

      const merged = mergeEntries(entries, sys, MAX_CAP);
      const shown = tab === 'all' ? merged : tab === 'web' ? entries : sys;
      const unread = unreadCount(merged, readTs);
      const fmt = (ts) => {
        const d = new Date(ts);
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      };
      const markRead = () => { localStorage.setItem(READ_KEY, String(Date.now())); setReadTs(lastRead()); notify(); };
      const clearAll = () => { save([]); notify(); }; // 只清网页侧历史；系统日志是文件流水，面板不删
      const dismiss = (ts) => { save(load().filter((e) => e.t !== ts)); notify(); };
      const rows = shown.slice().reverse();

      const panel = open ? h('div', {
        ref: panelRef,
        className: 'dtl-panel' + (createPortal ? '' : ' inline'),
        role: 'dialog', 'aria-label': t('title'),
        style: createPortal && pos ? { left: pos.left, bottom: pos.bottom, width } : { width },
      },
        createPortal ? h('div', { className: 'dtl-resize', title: t('resize'), onMouseDown: startResize }) : null,
        h('div', { className: 'dtl-head' },
          h('b', null, t('title')),
          h('button', {
            type: 'button', className: 'dtl-btn dtl-lang', title: t('langTip'),
            onClick: (ev) => { ev.stopPropagation(); switchLang(); },
          }, t('langLabel') === '中文' ? '中文 / EN' : 'EN / 中文'),
          h('div', { className: 'dtl-tabs' },
            ...[['all', t('tabAll')], ['web', t('tabWeb')], ['sys', t('tabSys')]].map(([k, label]) =>
              h('button', {
                key: k, type: 'button',
                className: 'dtl-tab' + (tab === k ? ' on' : ''),
                onClick: () => setTab(k),
              }, label)),
          ),
          h('div', { className: 'dtl-actions' },
            unread > 0 ? h('button', { className: 'dtl-btn', type: 'button', onClick: markRead }, t('markRead')) : null,
            tab !== 'sys' && rows.length > 0 ? h('button', { className: 'dtl-btn', type: 'button', onClick: clearAll }, t('clearAll')) : null,
          ),
        ),
        sysErr ? h('div', { className: 'dtl-syserr' }, t('sysFailed')) : null,
        h('div', { className: 'dtl-list', style: { maxHeight: 'min(480px, calc(100vh - 140px))' } },
          rows.length === 0
            ? h('div', { className: 'dtl-empty' }, t('empty'))
            : rows.map((e, i) => {
                const prev = rows[i - 1];
                const newDay = !prev || dayKey(prev.t) !== dayKey(e.t);
                const rowKey = (e.src || 'w') + ':' + e.t;
                const isOpen = expanded.has(rowKey);
                return h(React.Fragment, { key: rowKey },
                  newDay ? h('div', { className: 'dtl-day' }, dayLabelOf(e.t, lang, t)) : null,
                  h('div', {
                    className: 'dtl-row' + (isOpen ? ' open' : ''),
                    title: isOpen ? undefined : e.text,
                    onClick: () => setExpanded((s) => { const n = new Set(s); if (n.has(rowKey)) n.delete(rowKey); else n.add(rowKey); return n; }),
                  },
                    h('span', { className: 'dtl-dot ' + (e.t > readTs ? (e.tone || 'info') : 'read') }),
                    h('span', { className: 'dtl-time' }, fmt(e.t)),
                    e.src === 'sys' ? h('span', { className: 'dtl-tag' }, t('srcSys')) : null,
                    h('span', { className: 'dtl-text' }, e.text),
                    e.src === 'sys' ? null : h('button', { className: 'dtl-x', type: 'button', title: t('dismiss'), onClick: (ev) => { ev.stopPropagation(); dismiss(e.t); } }, '×'),
                  ),
                );
              }),
        ),
        h('div', { className: 'dtl-cap' },
          t('capacity'),
          h('input', {
            type: 'number', min: 10, max: MAX_CAP, defaultValue: cap(),
            onBlur: (ev) => { const v = Math.min(MAX_CAP, Math.max(10, Number(ev.target.value) || DEFAULT_CAP)); localStorage.setItem(CAP_KEY, String(v)); save(load()); notify(); },
          }),
        ),
      ) : null;

      return h('div', { className: 'dtl-root' },
        h('button', {
          ref: bellRef,
          className: 'dtl-bell', type: 'button', title: t('title'), 'aria-label': t('aria'),
          'aria-expanded': open, onClick: () => setOpen((v) => !v),
        }, '🔔', unread > 0 ? h('span', { className: 'dtl-badge' }, unread > 99 ? '99+' : String(unread)) : null),
        panel && createPortal ? createPortal(panel, document.body) : panel,
      );
    }

    // ── 设置行 ──
    function SettingsRow() {
      const [on, setOn] = React.useState(enabled());
      const [, force] = React.useState(0); // 语言切换经 notify() 广播，这里订阅重渲染
      React.useEffect(() => {
        const bump = () => force((x) => x + 1);
        window.addEventListener('dsh-toast-log-updated', bump);
        return () => window.removeEventListener('dsh-toast-log-updated', bump);
      }, []);
      return h('label', { className: 'dtl-settings' },
        h('input', {
          type: 'checkbox', checked: on,
          onChange: (ev) => { const v = ev.target.checked; localStorage.setItem(ENABLE_KEY, v ? '1' : '0'); setOn(v); },
        }),
        h('span', null, t('settingsTitle')),
        h('span', { style: { opacity: 0.6, marginLeft: 8 } }, t('settingsHint')),
      );
    }

    function apply(ctx) {
      ensureStyle();
      startObserver();
      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register({ name: 'sidebar.footer.action', id: 'dsh-toast-log-bell', order: 60 }, Bell),
      );
      ctx.slots.inject('settings.general.item', () =>
        ctx.slots.register({ name: 'settings.general.item', id: 'dsh-toast-log-settings', order: 27 }, SettingsRow),
      );
    }

    return { inject: ['slots'], apply };
  },
});
