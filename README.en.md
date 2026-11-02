# dsh-toast-log — Toast History Bell

**English** | [中文](README.md)

A persistent, reviewable history panel for the transient toasts in the DSH GUI
(IDEA Event Log style), with a 🔔 bell + unread badge in the sidebar footer.
**Two channels merged:**

| Tab | Source | Channel |
|---|---|---|
| All | Both streams merged by time, deduped by `t+text` | — |
| Web | In-app GUI toasts (copy/delete/warning floats) | MutationObserver on `body` for `div[role="alert"]` with `_toast_` class / `--dsh-toast-hold` CSS variable (dual anchors survive CSS-module hash drift), stored in localStorage |
| System | Windows notifications sent by dsh-notify-windows (turn done / approval / error) | Host half registers `GET /toast-log/notify`, read-only parse of the tail of `<tmp>/dsh-notify/notify.log` |

The web channel is push-based (instant DOM observer). The system channel is
belt-and-braces: host `fs.watch` on notify.log → SSE `/toast-log/notify/stream`
broadcasts in sub-second (measured 341 ms end-to-end), with a 60 s polling
fallback for eventual consistency; content fingerprinting skips no-op re-renders.

Panel features: right-edge grip drag-to-resize (300–920 px, persisted),
day grouping (Today/Yesterday), tone dots (green = success / orange = approval
or warning / blue = plain, hollow when read), single-line ellipsis with
click-to-expand full text, click-outside to close, and an **in-panel zh/en
toggle** (persisted — no browser-language switching needed).
Clear/remove only touches the web-side history; the System tab is a read-only
view of the log file and never deletes it.

## Known limits (stated honestly)

- **Unofficial seam**: if a future host release changes both `role="alert"` and
  the CSS variable, the Web tab misses captures — fix is a single function,
  `isToastNode` in `client.js`. The System tab depends on dsh-notify-windows'
  log format (`{time,event,reason,turn,body,url}` JSONL); if it changes, update
  `parseNotifyLine` in `index.js`.
- `/toast-log/notify` has no auth, same as other custom host routes, and only
  listens on 127.0.0.1. Responses contain notification bodies (session titles /
  summary snippets) — acceptable on a single-user machine.
- Pure-logic tests: `node test.mjs` (16 cases, extracted from the shipped
  source itself).

## Install

```bash
# Option 1: straight from GitHub
cd <profile dir>/          # e.g. ~/.dsh/profiles/desktop
pnpm add github:lvwancong/dsh-toast-log

# Option 2: clone + link (single dev source; reinstall after edits)
git clone https://github.com/lvwancong/dsh-toast-log
pnpm add link:./dsh-toast-log
```

⚠️ **`pnpm add` does not activate the plugin**: append `"dsh-toast-log"` to
`dsh.profile.bundles` in the profile's `package.json`, then **fully restart
DSH** (host-half route changes require a restart; later client.js-only changes
just need Ctrl+R).

## Uninstall

Remove from bundles + `pnpm remove dsh-toast-log`. History lives in browser
localStorage (`dsh.toast-log.*`); system entries stay in dsh-notify-windows'
own log. This plugin never writes anyone else's files.

## License

MIT
