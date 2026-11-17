# B站投稿助手（Grok v2）

这是独立于 `Documents/B站投稿-grok` 的新版本，端口 **3459**，不覆盖 3457 原版。

本地运行的视频预处理与 B 站草稿投稿工具。精简主流程由固定本地程序下载视频、读取信息并截取3张封面；Grok 只负责生成标题、标签、简介和分区，不再驱动命令或视频工具。默认使用 `grok-4.6`，只有文案调用失败或质量检查不通过时才切换 `grok-4.5` 复核。最终由本地上传脚本保存到 B 站草稿箱。

v2 借鉴 Codex harness 的工作方式，但不把 Codex 嵌进循环：

- 改稿必须带着 `content_brief.json` 过质量门
- 处理过程写阶段事件和模型调用账
- 分析成功后可以从事实卡续跑，不必重新下载
- 不确定项、低置信实体、查证译名要先确认才能保存草稿
- 分析阶段最多查 3 个拉丁人名的中文维基译名
- 「试一组标题」写入 `branches/`，不会覆盖当前文案

主流程会额外截取10张均匀分布的分析帧，并尝试使用本地缓存的 Whisper 模型自动转录；没有音轨、没有语音或本地模型不可用时会记录明确状态，其中转录不可用不会阻塞基础投稿流程。默认模型为 `large-v3-turbo`，可用 `BILI_TRANSCRIBE_MODEL` 修改；运行前需按 `requirements.txt` 安装 Python 依赖并提前缓存所选模型。外语口播默认译成中文并烧进成片；没有人声会跳过。可在提交时取消勾选，或在补充说明里写「不要字幕」。已生成但没字幕的成片可在结果页点「补烧中文字幕」。

原 `/Users/wangtangjie/Projects/bili-publisher` 只读。本树是独立的 Grok 驱动副本。

## 使用

双击桌面「B站投稿助手-Grok-v2」，或运行：

```bash
cd ~/Documents/B站投稿-grok-v2
bun start
```

浏览器打开 http://127.0.0.1:3459

文案由 **grok-4.6** 生成，失败或审稿不通过时用 **grok-4.5** 复核。对话改稿也会写回当前任务的标题/标签/简介/分区，不再假装能跑 ffmpeg。

凭证二选一即可，不需要 Codex：

- 项目目录 `.env` 里的 `BILI_GROK_API_KEY` 或 `XAI_API_KEY`
- 本机已执行 `grok login` 的 SuperGrok 登录（`~/.grok/auth.json`）

令牌保存在 `.auth-token`，B站 Cookie 保存在 `~/.bili_cookie.json`；两者都不应分享或提交到版本库。公开仓库同样不包含：

- `.env`、`.auth-token` 和本机 Cookie
- `workspace/` 里的下载视频、字幕、封面和任务记录
- `fonts/` 里的黑体文件（字幕使用系统自带的 STHeiti，不随仓库分发）

环境变量名称见 `.env.example`。桌面启动器脚本在 `scripts/launcher.sh`，应用描述文件和图标在 `packaging/`。

投稿前需要确认：

- 标题和标签；
- 封面；
- 明确的 B 站分区 ID（tid）；
- 可选的活动。

“保存草稿”只会写入 B 站草稿箱。同一任务成功后会阻止重复上传。

## 开发与检查

```bash
bun install
bun start
bun run check
```

Python 依赖记录在 `requirements.txt`。项目固定监听 `127.0.0.1`，默认端口为 `3459`；可用 `BILI_PUBLISHER_PORT` 修改端口。不要占用原 Grok 树的 `3457` 或 Codex 树的 `3456`。3458 已被 `thought-graph` 占用。

Grok 相关环境变量：

- `BILI_GROK_API_KEY` 或 `XAI_API_KEY`：xAI API key；
- `BILI_GROK_PRIMARY_MODEL` / `BILI_PUBLISHER_PRIMARY_MODEL`：常规处理模型，默认 `grok-4.6`；
- `BILI_GROK_FALLBACK_MODEL` / `BILI_PUBLISHER_FALLBACK_MODEL`：失败或质量不合格时的复核模型，默认 `grok-4.5`。

## 数据目录

处理结果位于 `workspace/<jobId>/`。Web 服务只允许访问其中的图片和视频文件，不会对外提供任务提示词、Cookie 或 JSON 调试文件。
