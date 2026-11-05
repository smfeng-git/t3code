# T3 独立环境定制功能接入包

日期：2026-11-05。这是定制源码、预览安装包与接入工具的使用说明。对方使用自己的机器、账号、项目、Pi Web 和 T3 环境，不连接作者的电脑。

## 包含哪些优化

- Pi Web 全目录历史与后续新会话发现；T3 与 Pi Web 续聊同一原生会话。
- 外部已保存消息约每 5 秒同步；不承诺外部输出逐字直播。
- Pi 标题跟随；首次历史默认 Settled，之后新建会话活跃，后续用户消息唤醒会话。
- Codex 各目录历史跟随，以及可选的本机共享后端接入。
- 桌面/Web 侧栏按环境和项目筛选、项目分组、简化重复信息。

内置浏览器、T3 Connect、WSL 支持本来就是上游功能。手机网页批注没有实现。此包不包含定制手机安装包。

## 文件

- patches/pi-web-shared-integration.patch：Pi Web 配套代码及测试补丁。
- codex/bridge.cjs：T3 stdio 到本机 Codex WebSocket 的连接桥。
- codex/run.py、config.example.json：可移植的 Windows 共享启动工具与配置模板。
- ACCEPTANCE.md：验证和已知边界。

不提供作者的 config.json、数据库、登录信息、运行日志、进程状态、备份或 server.asar。

## 直接安装预览版（无需编译 T3）

下载：[Windows / Android Release](https://github.com/smfeng-git/t3code/releases/tag/shared-0.1.7-preview.20261105.1)。

- Windows 10/11 x64：下载 `.exe` 安装包。内含定制 Windows 服务与 WSL 运行包。未做商业代码签名；安装前关闭 T3 并备份已有状态，不保证与官方版并行隔离。
- Android arm64：下载 `T3-Shared-Android-arm64.apk`。这是独立包名的 T3 Shared，不覆盖官方 App；包含完整 JS，无需电脑运行 Metro。安装后重新配对自己的 T3 环境。
- `.tar.gz` 是 Linux/WSL 运行包，普通 Windows 安装用户无需单独下载。
- `SHA256SUMS.txt` 用于校验下载文件。

这里省去的是 T3 编译步骤。Pi Web 共享仍需下文的配套补丁，Codex App 双端共享仍需配置启动器；模型登录使用自己的账号。

远程接入：本构建未配置官方 T3 Connect 云发布参数，优先使用局域网或自己的 Tailscale 网络，通过环境提供的授权配对流程连接。手机不能直接访问电脑的 `127.0.0.1`，应使用可达的电脑/Tailscale 地址。不要把未授权的裸地址当成配对链接。

Android 使用自有签名并关闭官方 OTA；后续从此 Fork 的 Release 手动升级。此版为预览版，构建与包检查通过不等于已完成全部真机交互验收。

## 1. 获取源码（开发者可选）

仓库：https://github.com/smfeng-git/t3code

分支：https://github.com/smfeng-git/t3code/tree/feat/pi-session-sync

```powershell
git clone --branch feat/pi-session-sync --single-branch https://github.com/smfeng-git/t3code.git t3code-custom
cd t3code-custom
```

这个分支已经包含修改，无需再次应用 T3 补丁。后续先保存本地改动，再运行 `git pull --ff-only`，重新构建并验证。不要把拉取源码与更新已安装 App 混为一谈。

仓库内 `extras/shared-sessions` 包含 Pi Web 配套补丁和 Codex 连接工具，所以直接克隆也能取得这些文件。源码接入说明位于该目录 README。

定制功能基于官方提交 `9e85538535c8553901351112ab02dd1dd62db5ee`；当前功能来源提交 `c4bf9dff`。

按照该仓库 README 安装 vp；该基线 package.json 固定 Node 26.12.1、pnpm 12.14.0，优先让 vp 管理工具版本。

```powershell
vp i
vp run dev
```

先用开发环境配对链接验证。开发数据目录与正式环境不同，不要以为打开旧桌面 App 就已运行修改版。

要构建 Windows x64 安装包，仓库已有入口：

```powershell
vp run dist:desktop:win:x64
```

预览安装包由 GitHub Actions 构建。自行构建时以脚本输出为准，按仓库构建文档处理依赖。不要从别人机器拷 server.asar 覆盖任意版本。

## 2. 可选：Pi Web 接入

本机已验证基础是 Pi Web 0.12.2、Pi SDK 1.4.0，且 Pi Web 工作区还有其他本地改动。因此附带补丁不等于保证能应用于干净的任意 0.12.2 checkout：必须先运行检查，再类型检查/测试。

在对方自己的 Pi Web 仓库备份/提交当前改动，然后运行：

```sh
git apply --check /path/to/patches/pi-web-shared-integration.patch
git apply /path/to/patches/pi-web-shared-integration.patch
```

检查失败不要使用强制覆盖；需要把新增 entries 读取和共享输入逻辑按实际版本适配。

启动对方自己的 Pi Web。进入定制 T3 的正确 environment → Settings → Providers → Pi：

1. Binary path 填该环境真正可执行的 pi 路径。
2. Pi Web shared backend 填该 T3 后端可访问的地址，例如同一 WSL 内的 `http://127.0.0.1:30141`。
3. 按仓库 `docs/user/providers-pi.md` 配置需要的 Pi Web 认证；不要把密码放入 URL 或分享包。
4. 共享会话采用 Full access，工具权限由 Pi Web 控制。

WSL：应运行已包含补丁的 WSL T3 后端；仅更新 Windows 前端，不会自动把功能编译进官方 WSL 运行包。可先在 WSL 从修改源码运行开发后端，再通过其正常配对入口添加到客户端。不要复用作者的 WSL runtime hash 路径。

Pi Web 必须持续运行。初次全量历史可能进入 Settled；这不代表没同步。不要同时让独立 Pi 进程写同一会话文件。

## 3. 可选：Windows Codex 共享后端

前提：已验证定制 T3；自己的 Codex App 已登录；Python 3.11+；Node 22+（连接桥需要全局 WebSocket）。Codex App 支持指定共享服务是对已测版本的实现观察，不是跨版本稳定性承诺。

1. 将 codex 目录放到固定路径。复制 config.example.json 为 config.json，填写自己的 Node、Codex CLI、Codex App 可执行文件和 CODEX_HOME。路径可含空格，连接桥路径不要包含 `%` 或 `!`。
2. 在该目录运行 `python run.py check`，只检查路径和本机监听配置，不启动程序。
3. 运行 `python run.py setup`，生成 codex-shared.cmd 和可执行文件版本指纹。
4. 在 T3 Codex provider 中，先记下原来的 Binary path/Home path；把 Binary path 改为生成的 codex-shared.cmd，Home path 指向同一个 CODEX_HOME，启用 Sync sessions（如该实例提供）。不要混用 shadow home。
5. 等任务结束，完全退出 Codex App 和 T3；运行 `python run.py run`。它启动隐藏的本机 Codex 后端及 Codex App，然后手动打开定制 T3。
6. 保留这个控制终端；所有任务结束并关闭两个客户端之后，才按 Ctrl+C 停止它启动的后端。关闭控制终端可能打断任务。

工具不会替换应用文件、写 T3 设置或恢复数据库；不需要管理员权限。它拒绝接入已占用的端口，不会按进程名批量清理；不自动重试失败消息，也不自动重启故障后端。

可执行文件改变时拒绝启动，需重新验证后再 setup。这只是文件变化检测：T3 更新、应用资源更新、协议兼容性仍需人工检查，不保证所有更新都能被指纹发现。

本启动器为此次新整理版本；只完成隔离检查，尚未在另一台机器完成真实双向聊天验收。不要把之前作者机器上的旧启动器验收当成此版本的完整验收。

## 4. 手机

手机连接对方自己的 T3 environment。Windows Codex 和 WSL Pi 是不同环境时分别配对；不要转发作者的授权链接、token 或登录文件。同步能力来自对应服务器，侧栏修改来自定制桌面/Web，手机仍使用它自己的 UI。

## 更新与回退

不要直接用官方自动更新覆盖定制版；先在源码分支整合上游、验证、重新构建。此工具不会把旧 server.asar 强行覆盖到新桌面。

Codex 回退：任务结束并退出两个客户端 → Ctrl+C 停止本工具后端 → 在 T3 恢复此前记录的 provider 路径 → 用正常快捷方式启动。聊天记录不回滚。

Pi 回退：清空 Pi Web shared backend 或禁用该共享 provider，恢复常规 Pi provider；已有显示记录不自动删除，不应为了回退同步而覆盖会话数据库。

向别人分享此开发分支链接即可。首次接入仍需要对方按以上步骤配置和验证；普通用户优先下载上面的预览安装包，开发者可以继续从源码构建。
