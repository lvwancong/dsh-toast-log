# dsh-toast-log — Toast 留痕铃铛

[English](README.en.md) | **中文**

DSH 界面里一闪而过的提示统一进一个可回看面板（IDEA Event Log 式），
侧栏底部 🔔 铃铛 + 未读角标。**双通道合并**：

| 页签 | 来源 | 通道 |
|---|---|---|
| 全部 | 两路按时间归并去重（`t+text` 键） | — |
| 网页 | DSH GUI 内部 toast（复制/删除/警告浮条） | MutationObserver 盯 body 的 `div[role="alert"]` + `_toast_` 类 / `--dsh-toast-hold` CSS 变量（双锚点防哈希漂移），写 localStorage |
| 系统 | dsh-notify-windows 发的 Windows 通知（轮次完成/审批/报错） | 宿主半 `index.js` 注册 `GET /toast-log/notify`，只读解析 `<tmp>/dsh-notify/notify.log` 尾部 |

网页通道为推送（DOM 观察器即时）。系统通道双保险：宿主 `fs.watch` notify.log → SSE `/toast-log/notify/stream` 亚秒广播（主，实测端到端 341ms），60s 轮询兜底（SSE 断开/宿主半未装载时最终一致）；指纹比对无变化不重渲染。

面板特性：右缘握把拖拽调宽（300–920px，持久化）、按日期分组（今天/昨天）、
色调圆点（绿=成功 / 橙=审批或警告 / 蓝=普通，已读空心）、单行省略 + 点击展开全文、
点外部关闭、**面板内中英切换**（持久化，无需改浏览器语言）。
「清空/单删」只作用于网页侧历史；系统页签是文件流水的只读视图，不删。

## 已知边界（诚实声明）

- **非官方接缝**：宿主升级若同时改掉 `role="alert"` 和 CSS 变量名，网页页签会漏抓——
  只需改 `client.js` 的 `isToastNode`（一处）。系统页签依赖 dsh-notify-windows 的
  日志格式（`{time,event,reason,turn,body,url}` JSONL），它变了改 `index.js` 的 `parseNotifyLine`。
- `/toast-log/notify` 与宿主其它自定义路由一样默认无鉴权，仅监听 127.0.0.1；
  返回内容含通知正文（会话标题/摘要片段），本机单用户环境可接受。
- 纯逻辑单测 `node test.mjs`（16 项，从发布物源码提取函数测本体）。

## 安装

```bash
# 方式〇：下载 Release 附件（最稳，不依赖 git 拉取）
# https://github.com/lvwancong/dsh-toast-log/releases 下载 dsh-toast-log-<ver>.tgz
cd <profile目录>/
pnpm add ./dsh-toast-log-<ver>.tgz

# 方式一：从 GitHub 直装
cd <profile目录>/          # 例：~/.dsh/profiles/desktop
pnpm add github:lvwancong/dsh-toast-log

# 方式二：克隆后 link（开发源单一副本，改码后重装即生效）
git clone https://github.com/lvwancong/dsh-toast-log
pnpm add link:./dsh-toast-log
```

⚠️ **pnpm add 不写激活列表**：需在 profile 的 `package.json` → `dsh.profile.bundles`
数组里手工追加 `"dsh-toast-log"`，然后**完全重启 DSH**（宿主半路由改动必须重启；
之后仅 client.js 改动 Ctrl+R 即可）。

## 卸载

bundles 移除 + `pnpm remove dsh-toast-log`。历史在浏览器 localStorage（`dsh.toast-log.*`），
系统流水在 dsh-notify-windows 自己的日志里，本插件不写任何别人的文件。

## License

MIT
