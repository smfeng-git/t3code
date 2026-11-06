# 分项接入步骤

先完成第 1 节，再执行需要的 provider 分支。

## 1. 获取源码（必需：当前没有安装包）

内网仓库：http://192.168.10.51/tpf-ci-group/tpf-t3

本次启动适配器以该内网分支为准，GitHub 和旧 ZIP 不保证已同步。

原 GitHub 仓库：https://github.com/smfeng-git/t3code

分支：http://192.168.10.51/tpf-ci-group/tpf-t3/-/tree/feat/pi-session-sync

```powershell
git clone --branch feat/pi-session-sync --single-branch http://192.168.10.51/tpf-ci-group/tpf-t3.git t3code-custom
cd t3code-custom
```

这个分支已经包含修改，无需再次应用 T3 补丁。后续先保存本地改动，再运行 `git pull --ff-only`，重新构建并验证。不要把拉取源码与更新已安装 App 混为一谈。

仓库内 `extras/shared-sessions` 包含 Pi Web 配套补丁和 Codex 连接工具，所以直接克隆也能取得这些文件。源码接入说明位于该目录 README。

定制功能基于官方提交 `9e85538535c8553901351112ab02dd1dd62db5ee`；当前功能来源提交 `c4bf9dff`。

按照该仓库 README 安装 vp；该基线 package.json 固定 Node 26.12.1、pnpm 12.14.0，优先让 vp 管理工具版本。

构建前，将本目录 `cloud.env.example` 的四项合并到 **T3 仓库根目录** `.env.local`。文件不存在时：

```powershell
Copy-Item extras/shared-sessions/cloud.env.example .env.local
```

已有文件时只合并缺少的配置，保留自己的值。这些是官方服务公开标识，不是作者账号凭证；登录用自己的账号。自建 Relay/Clerk 时四项需属于同一套服务。

缺少这些配置会隐藏账号入口。配置在构建时注入，构建后补环境变量不能修复旧包，必须重新构建。官方认证对任意自定义客户端的兼容性仍需验证。

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
3. 若 Pi Web 要求密码，在该 Pi provider 的 Environment 添加敏感变量 `PI_WEB_PASSWORD`。
4. 共享会话采用 Full access，工具权限由 Pi Web 控制。

WSL：应运行已包含补丁的 WSL T3 后端；仅更新 Windows 前端，不会自动把功能编译进官方 WSL 运行包。可先在 WSL 从修改源码运行开发后端，再通过其正常配对入口添加到客户端。不要复用作者的 WSL runtime hash 路径。

Pi Web 必须持续运行。初次全量历史可能进入 Settled；这不代表没同步。不要同时让独立 Pi 进程写同一会话文件。

## 3. 可选：Windows Codex 共享后端

推荐使用 App-owned 模式：Codex App → 原生适配器 → 共享 Codex 后端 ← T3 连接桥。App 持有后端，T3 与 App 各有独立协议连接。浏览器辅助 CLI 仍独立运行。此入口依赖已测 App 的启动参数，不是官方跨版本稳定接口。

前提：Windows、已验证的定制 T3、已登录的 Codex App、Python 3.11+、Node 22+（全局 WebSocket）、Windows .NET Framework C# 编译器。

1. 将仓库的 `codex` 目录放到固定位置，或直接在该目录运行。复制 `config.example.json` 为 `config.json`，填写自己的五项路径/地址。CLI 必须是真实 Codex 可执行文件，不要填适配器。路径可含空格，连接桥路径不要含 `%` 或 `!`。使用自己的 CODEX_HOME。
2. 在该目录依次运行：

```powershell
python run.py check
python run.py setup
python run.py build-app-owned
python test-app-owned.py
```

`setup` 生成连接桥 CMD 并记录三个可执行文件的指纹；`build-app-owned` 从源码编译原生 exe。测试使用临时 CODEX_HOME 和随机本机端口，不访问真实会话或发起模型请求；成功应输出 `passed: true` 和 10 项检查。测试可通过环境变量 `T3_SHARED_CODEX_CONFIG` 指定测试配置；日常启动固定读取本目录 config.json。

3. 在 T3 记下原 Binary path/Home path，把 Codex provider 的 Binary path 改为本目录生成的 `codex-shared.cmd`，Home path 使用配置中的 CODEX_HOME，启用 Sync sessions（如提供）。不要使用 shadow home。
4. 等两端任务结束，完全退出 Codex App 和 T3。如果旧共享后端仍占用配置端口，先通过原启动器正常停止它；新工具会拒绝占用端口，不自动杀进程。
5. 运行 `python run.py run-app-owned`，或双击 `Start-App-Owned-Shared-Codex.cmd`。看到 `App-owned shared backend ready` 后打开定制 T3。启动脚本可以退出，**Codex App 必须保持打开**。
6. 按 ACCEPTANCE.md 验证同一会话双向续聊、浏览器实际读页与手机。结束所有任务后正常退出 App，适配器会清理它创建的后端；退出 App 会中断仍在使用它的 T3 请求。

程序不修改 T3 数据库、应用安装文件或 provider 设置。失败请求不会自动重放。无需管理员权限。若脚本显示 STOP/ERROR，保留报错先检查，不反复启动。

已测本机组合：Codex App 26.1029.7803.0、CLI 0.166.0-alpha.6。原适配器已通过 App 内置浏览器读页、App/T3 在同一会话双向发送验证；便携入口仍需在接收者机器验收。仅 Desktop 主调用包含 `app-server --analytics-default-enabled` 时选择共享，其余 helper 调用委托真实 CLI；App 更新后要重新核验这个调用约定。

**已知限制：消息在后端可读，不等于新会话自动出现在 Codex 侧栏。T3 新建会话的自动发现/刷新/项目归类仍未解决，不把手动打开算自动同步通过。** T3 临时目录也可能导致归类与消息中提及的项目路径不同。

浏览器冷启动使用 60 秒工具超时，分别检查发现、打开、实际页内容；Statsig 警告本身不代表失败。`browser access host unavailable` 与超时应分开诊断，不绕过认证或复制其他会话的授权信息。

App/CLI/Node 文件变化时启动器会拒绝运行；先检查兼容性、重新 setup 和编译/测试。T3 资源和 App 资源更新未必由 exe 指纹覆盖，仍需真实验收。

旧独立模式保留为 `python run.py run`：必须保留控制终端，两个客户端退出后 Ctrl+C；此模式不保证 App 内置浏览器可用。两种模式不能同时占同一端口。

## 4. 手机

手机连接对方自己的 T3 environment。Windows Codex 和 WSL Pi 是不同环境时分别配对；不要转发作者的授权链接、token 或登录文件。同步能力来自对应服务器，侧栏修改来自定制桌面/Web，手机仍使用它自己的 UI。

## 更新与回退

不要直接用官方自动更新覆盖定制版；先在源码分支整合上游、验证、重新构建。此工具不会把旧 server.asar 强行覆盖到新桌面。

Codex 回退：任务结束并退出两个客户端（App-owned 后端随 App 退出；旧独立模式还需 Ctrl+C 停止控制终端）→ 在 T3 恢复此前记录的 provider 路径 → 用正常快捷方式启动。聊天记录不回滚。

Pi 回退：清空 Pi Web shared backend 或禁用该共享 provider，恢复常规 Pi provider；已有显示记录不自动删除，不应为了回退同步而覆盖会话数据库。

向别人分享此开发分支链接即可。首次接入仍需要对方按以上步骤配置和验证；当前没有可推荐给普通用户直接安装的定制发行版；开发者可按上述说明从源码构建。
