# B站投稿-grok-v2

- 原版保留：`/Users/wangtangjie/Documents/B站投稿-grok`（端口 3457）不要覆盖
- Codex 原树只读：`/Users/wangtangjie/Projects/bili-publisher`（端口 3456）
- 本树 Grok 只写文案/分区，本机脚本下载、截封面、存草稿
- 借鉴 Codex harness 的工作方式：改稿接着事实卡、阶段事件、调用留痕、从事实卡续跑、保存前确认、分析阶段查证译名、标题试验不覆盖当前结果
- 不点设备、不发正式稿（只草稿）
- 端口 3459
- 启动: 桌面「B站投稿助手-Grok-v2」或 `cd Documents/B站投稿-grok-v2 && bun start`
- Cookie: `~/.bili_cookie.json`

本树不依赖 Codex / ChatGPT.app。文案模型默认 `grok-4.6`，失败时回退 `grok-4.5`。可用 `BILI_GROK_PRIMARY_MODEL` / `BILI_GROK_FALLBACK_MODEL` 覆盖。API key 读取 `BILI_GROK_API_KEY` 或 `XAI_API_KEY`。
