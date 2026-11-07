# 开发与交付说明

普通使用者从 [README.md](README.md) 开始。本页面向维护者；不要要求使用者克隆仓库、编译 T3 或自行适配 Pi 补丁。

## 源码准备与构建

内网仓库：http://192.168.10.51/tpf-ci-group/tpf-t3

已验证构建使用 GitHub `feat/pi-session-sync` 分支的提交 `73ddbe69d`；不要以旧 ZIP 代替该提交。内网仓库是否同步需单独核对。

本页涉及的新版 `Start.cmd`、`start.py`、`test-start.py` 目前为本地预览工具，未随此次文档提交发布，下面的新版工具命令仅供取得完整配套工具后维护使用。

原 GitHub 仓库：https://github.com/smfeng-git/t3code

分支：http://192.168.10.51/tpf-ci-group/tpf-t3/-/tree/feat/pi-session-sync

```powershell
git clone --branch feat/pi-session-sync --single-branch http://192.168.10.51/tpf-ci-group/tpf-t3.git t3code-custom
cd t3code-custom
```

这个分支已经包含修改，无需再次应用 T3 补丁。后续先保存本地改动，再运行 `git pull --ff-only`，重新构建并验证。不要把拉取源码与更新已安装 App 混为一谈。

仓库内 `extras/shared-sessions` 包含 Pi Web 配套补丁和 Codex 连接工具，所以直接克隆也能取得这些文件。源码接入说明位于该目录 README。

定制功能基于官方提交 `9e85538535c8553901351112ab02dd1dd62db5ee`；当前安装包源码为 `73ddbe69d`，构建编号与下载校验值见 README。

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

## Pi Web 配套适配

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

## 开发、验证与更新范围

- 日常修改先运行针对性测试，不默认构建安装包。
- 仅修改 `extras/shared-sessions/` 文档或启动器：交付该目录即可，不重打桌面/APK。
- 服务端或 provider 修改：更新实际承载会话的后端；Windows 与 WSL 分别核对。协议兼容时不要求重打 APK。
- Web/桌面修改：更新桌面产物；手机原生浏览器、方向或协议修改需同时检查 APK 与宿主兼容性。
- 正式构建按 `.github/workflows/custom-installers.yml` 执行；依赖安装使用仓库指定 vp 工具链，不另造构建流程。

启动器无第三方 Python 依赖，要求 Python 3.11+。在 `extras/shared-sessions/codex` 运行：

```sh
python -B test-start.py -v
```

这是隔离单元测试，不启动用户应用。Windows 上，配置测试用的路径后，可额外运行 `python test-app-owned.py`：使用临时 Codex home、随机端口和真实 CLI，验证协议与清理，不发模型请求；需要已编译的适配器。结果仍不能代替真实 Codex App 双向聊天验证。

`run.py` 保留底层 `check`、`setup`、`build-app-owned`、`run-app-owned` 命令；日常使用统一走 `Start.cmd`。旧独立模式 `run` 仅为维护入口，需保留终端且不保证 App 浏览器可用。

App-owned 依赖 Codex Desktop 主调用含 `app-server --analytics-default-enabled`；helper 必须继续独立运行。历史已测组合为 App 26.1029.7803.0 / CLI 0.166.0-alpha.6，不代表其他版本通过。指纹只覆盖指定 exe，不覆盖全部 App 资源，更不证明协议兼容。软件更新必须补做真实验收。

## 交付给新用户

1. 提供明确提交、版本及校验值的定制 T3 安装产物，不以旧官方包替代。
2. 附完整 `extras/shared-sessions/`（入口依赖子目录，不能单独发 CMD）；排除本机 config、日志、指纹、运行状态、锁文件、验证结果与缓存。不要携带账户凭证或聊天数据。
3. 若交付预编译适配器，应注明来源与校验值；当前源码目录入口可在首次启动时自动编译，要求 Windows .NET Framework 编译器。
4. Pi 用户另需兼容的 Pi Web、实际可达地址及其既有启动方式；目前本包的一键入口仅负责 Windows Codex 和 T3，不负责部署 WSL/Pi Web。
5. 记录 Windows 实机首启、重复启动、正常/强制重启、双向聊天的结果，按 [ACCEPTANCE.md](ACCEPTANCE.md) 标注未验证项。

不要将个人机器上的成功当作通用发行验收。若无可用安装产物，应由维护者完成构建交付，不把源码编译步骤转交普通用户。
