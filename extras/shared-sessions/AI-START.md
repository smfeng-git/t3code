# AI 接入入口

目标：在接收者自己的环境运行定制 T3，让所选 provider 的同一个原生会话可从两端继续，并验证新目录、新会话、后续消息与手机访问。源码分支为 `feat/pi-session-sync`，不是上游 main。

## 1. 只读预检

1. 读取目标仓库 AGENTS.md。ZIP 使用者先查看 PACKAGE.json 的 sourceCommit，克隆 README 指定的分支后核对提交；复现此包时 checkout 该提交，避免混用未来分支 HEAD。
2. 从已有信息判断用户需要 Pi、Codex 或两者；缺少时只询问这个范围。
3. 记录 OS、T3 安装位置/版本、源码路径、运行环境。Windows 与 WSL 分开记录；用 `wsl --list --verbose` 发现发行版，在目标 WSL 中用 `command -v pi`、`node --version` 检查环境。Pi Web 的 npm 项目目录不是 Pi binary。
4. 输出环境表：环境名 / OS / T3 后端路径与地址 / provider 实际路径 / Pi Web 地址（如有）。不输出密码、token 或完整私人配置。
5. 检查任务和用户改动，选择隔离测试环境。使用原生会话读取/API 验证；禁止直接写 T3 实际数据库制造同步结果。

完成信号：明确哪个 T3 后端调用哪个 provider。

## 2. 运行定制 T3

执行 SETUP.md 第 1 节：先配置根目录 `.env.local`，再安装依赖和构建；使用项目指定的 vp/Node 版本。已有工作区保存改动后更新。

验证运行的是新产物：侧栏有环境筛选，Pi 设置有 Pi Web shared backend。`git pull` 或 `vp run dev` 不会自动升级已安装的旧 App。

Windows 安装包需要 Rust、Python、Visual Studio Build Tools 和正确的 WSL runtime，完整构建配方见 `.github/workflows/custom-installers.yml`。当前没有新的可下载安装包。优先在隔离开发环境验证 provider，再安排正式打包，避免反复整仓构建排查地址。

WSL 需要在 WSL 中运行定制 T3 后端。先用开发启动日志的配对入口连接该环境，验证后安排持久启动；开发后端的终端需要保持运行。若正式打包，则嵌入同版本定制 WSL runtime，不照抄分享者的 runtime hash 或路径。

登录检查：桌面出现账号头像或 Sign in to T3 Connect。入口缺失先检查 cloud.env.example 四项是否在构建时注入。私网浏览器源可能按上游设计禁用云登录，不能用 localhost 网页入口缺失判断桌面构建失败。

## 3. 按需接 provider

### Pi

执行 SETUP.md 第 2 节。先 `git apply --check`，通过后应用 Pi Web 补丁。若已应用，用 `git apply --reverse --check` 检查，避免重复打补丁。

检查失败时报告文件和版本差异，再按实际版本适配，不强制覆盖。接缝为 `lib/rpc-manager.ts`、`lib/shared-input.ts`、`lib/shared-session-page.ts`、`app/api/sessions/[id]/entries/route.ts`。窄测试为 Pi Web 中 `node --test lib/rpc-manager-shared-reads.test.mjs`，还需该工作区类型检查。

在 T3 后端所在系统验证 Pi Web 地址可达。401 先查 PI_WEB_PASSWORD；404 先查补丁/API 和目标服务；拒绝连接先查端口、进程。然后填写该环境 Pi provider 的 binary、shared backend、敏感密码、Full access。共享权限由 Pi Web 控制。Pi Web 保持运行。

### Codex

执行 SETUP.md 第 3 节，使用内网 `feat/pi-session-sync` 最新提交；旧 ZIP 不包含本次适配器。填写自己的 config.json，依次 `check`、`setup`、`build-app-owned`、`python test-app-owned.py`。共享服务与 provider 使用同一个 CODEX_HOME。

两端任务结束并退出后运行 `run-app-owned`，确认 ready 再启动 T3。App 保持运行，启动终端可以关闭。T3 provider 使用生成的 codex-shared.cmd。端口占用先确认所有者，通过原启动器正常停止；不按进程名清理。

完成信号分开记录：后端中可读到消息、两端同会话续聊、新会话自动出现在侧栏、浏览器实际读页。新会话自动显示目前仍有已知缺口；手动打开只能证明可读取，不能宣称自动发现修复。浏览器工具冷启动使用 60 秒超时。

## 4. 真实消息验收

执行 ACCEPTANCE.md。每个选定 provider：原客户端在测试会话发送唯一标记 A，结束后 T3 在同一会话发送 B；确认两端都看到 A/B 且各执行一次。验证新目录、新会话、后续消息、重启无重复；Pi fork 另测一次。历史先查 Settled 和环境筛选。

桌面通过后再接手机：官方 App 登录自己的账户，连接自己的 Windows/WSL 环境，分别查看上述测试会话；必要时刷新。手机无桌面新侧栏控件属于预期。

## 5. 交付运行记录

留下实际源码提交、组件版本、环境表、启动顺序与命令、需持续运行的终端/服务、更新/停止方式及验收结果（通过/失败/未执行）。测试只发短消息，不修改真实项目。

仅完成补丁/构建时报告对应阶段，不称为接入成功。版本不兼容时给出具体文件、命令和错误，避免重新研究整个架构。
