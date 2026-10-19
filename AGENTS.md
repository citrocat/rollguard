# AGENTS.md

本文件约束所有在本仓库里工作的 AI coding agent。这里的要求优先级高于一般习惯；提交前必须逐条检查。

## 项目概览

RollGuard 是一个把 Rickroll 拦在播放键之前的 Chrome Manifest V3 扩展。

- `extension/` 是可加载源码：`background.js` 负责导航拦截、短链展开和持久化，`content/` 负责页面链接标记与点击拦截，`popup/`、`blocked/`、`history/` 是三个扩展界面。
- `scripts/build.mjs` 把源码复制到 `dist/`；`dist/` 是本地加载目录，不提交。
- `scripts/package-release.sh` 生成 GitHub Release 用的 `release/rollguard-<version>.zip`。
- `tests/detection.test.mjs` 是仓库当前唯一的自动化测试。
- 视觉方向固定为 B「RIOT / 磁带警报」：热粉、奶油纸、粗描边、贴纸与等宽小标签。新增界面必须延续这个语言。网页标记按表面分三档：正文短链使用 Redline XL（粉底、删除线、实心票签）；块级标题使用 Split Slab（黑底粉框整块 + 右侧警告块）；视频/缩略图卡片使用 Blackout（整框暗幕 + 印章，裁在画面矩形内）。任何新样式都必须先在深色页面和复杂链接布局中验证可见度，标记不得覆盖标题与元数据，并跳过不可见或零尺寸的重复锚点。工具栏角标显示当前标签页已标记数量；数量为 0 时隐藏数字，禁用时显示 OFF。

## 环境与命令

需要 Node.js 22+。

```bash
# 运行检测单测
node tests/detection.test.mjs

# 构建 dist/
node scripts/build.mjs

# 生成可发布的 zip 与 sha256（会先构建）
bash scripts/package-release.sh
```

## 修改原则

- 这是 local-first 工具。不要新增远端收集、账户体系、分析 SDK 或默认网络上报；短链展开和 oEmbed 校验只用于本地判断。
- 不提交 `keys/`、`dist/`、`release/`、`extension/_preview/`、`ui-demos/`、`screenshots/`。密钥与本地测试产物不得进入公开仓库。
- 修改 manifest 版本时必须同步 README 中展示的版本、release note 与 tag，版本号以 `extension/manifest.json` 为唯一来源。
- 发布只能通过 tag 触发的 GitHub Actions 完成；不要在本地手工上传一个与 CI 产物不一致的包。
- 界面文案以中文为主，保留 RollGuard 的短句、标签和克制幽默；不要加入明显 AI 生成腔或与产品无关的叙事。
- 先跑测试与构建再提交。任何会让现有测试或构建失败、或让扩展无法加载的改动都不应提交。

## Commit 规范（强制）

所有 commit 必须遵守以下规则：

1. 使用 **Conventional Commits** 格式：`<type>(<scope>): <中文摘要>`。type 与 scope 用英文，摘要用中文。允许的 type：`feat`、`fix`、`docs`、`style`、`refactor`、`perf`、`test`、`build`、`ci`、`chore`、`revert`。
2. 提交信息必须使用中文，并且**强制多行**：header 后必须有一个空行，再写正文。禁止单行 commit。
3. 正文必须尽量详细，至少包含两条以 `- ` 开头的条目；每一条同时说明“改了什么”和“为什么改/解决了什么问题”。不要只写“修复问题”“优化代码”这类空泛描述。
4. 正文只包括对改动内容的描述以及理由，不要包含工具执行日志、测试流水、寒暄、感谢、AI 生成声明、`Co-authored-by`、`Signed-off-by` 或其他无关 trailer。
5. 摘要要能独立解释这次变更；不要把多个互不相关的改动塞进一个 commit。确实需要时可以拆成多个 commit，但每一条都必须符合本规范。
6. 本仓库提供 `.githooks/commit-msg` 检查器，提交前先执行：

   ```bash
   git config core.hooksPath .githooks
   ```

   禁止使用 `--no-verify` 绕过。hook 会拒绝单行消息、缺少正文、少于两条 bullet、非中文摘要以及常见的自动生成 trailer。

示例：

```text
feat(popup): 放大弹窗的主要信息层级

- 将弹窗宽度调整为 400px 并提升主按钮、区块标题和拦截日志的字号，原因是原先的微字号在 1x 屏幕上阅读负担过高。
- 移除低价值提示条并把短链说明并入底栏，原因是在 600px 高度限制内为关键信息与点击目标腾出空间。
```

## 发布流程

1. 修改 `extension/manifest.json` 的 `version`，同步 README 版本信息和 `.github/release-notes/<version>.md`。
2. 运行测试、构建和 `scripts/package-release.sh`，确认 `release/` 中的 zip 可在解压后直接“加载未打包的扩展程序”。
3. 提交并推送 `main`。
4. 创建 annotated tag `v<version>` 并推送。只有 tag 会触发 `.github/workflows/release.yml`；普通 push 不会产生 release。
5. 检查 GitHub Actions，确认 release 中存在 zip 与 sha256；如果失败，修复后删除并重新打 tag，不要留下半成品 release。

## 安全与隐私检查

- 任何新增的 host permission、远程请求或数据字段都要在 README 和 PR/commit 说明里解释原因。
- 不记录页面内容全文，不记录用户身份，不向服务端发送 URL。拦截记录最多 200 条，写在 `chrome.storage.local`。
- 短链展开只跟随 HTTP(S) 重定向；不要加入凭据、Cookie 或用户代理伪造。
- 若修改内容脚本的标记或拦截逻辑，至少手动验证：已知链接标记、点击拦截、短链命中、关闭防护后标记移除、重新开启后恢复。
