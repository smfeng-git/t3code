# T3 共享会话接入包

这是 **源码分支 + 配套工具**，不是 Windows/Android 安装包。接收者使用自己的电脑、账号与模型权限，不连接分享者的机器。版本：2026-11-05，第 2 版。

## 给接收者：从这里开始

让 AI 帮忙时，把下面这段连同 ZIP 或分支链接发给它：

> 请按包内 AI-START.md 为我的独立环境接入 T3 定制功能。先检查本机系统、T3、Codex、Pi Web 和 WSL 的实际路径与版本，列出环境对应关系。执行我需要的 provider 分支，完成真实双向消息验证后交付启动方式。不要只应用补丁就宣布完成。需要我登录或选择安装位置时再问我。

源码：[feat/pi-session-sync 分支](https://github.com/smfeng-git/t3code/tree/feat/pi-session-sync)。该分支已经包含 T3 改动，**无需给 T3 再打补丁**。ZIP 的补丁只用于另一个项目 Pi Web。

## 选择需要的功能

| 需求 | 需要运行的组件 | 步骤 |
| --- | --- | --- |
| Pi 全目录共享会话和双向续聊 | 定制 T3 后端 + 配套 Pi Web + Pi | [SETUP.md 第 1、2 节](SETUP.md) |
| Codex App 与 T3 双向续聊 | 定制 T3 + Codex App + 共享启动器 | [SETUP.md 第 1、3 节](SETUP.md) |
| 侧栏环境筛选、项目分组 | 定制桌面或 Web 前端 | [SETUP.md 第 1 节](SETUP.md) |
| 手机访问上述环境 | 对应定制 T3 后端 + 官方手机 App | [SETUP.md 第 4 节](SETUP.md) |

仅 Windows Codex 不需要安装 Pi Web。仅 Pi 共享不需要 Codex 启动器。Windows Codex 和 WSL Pi 同时使用时，分别确认两个 T3 后端均为定制版本；安装 Windows 前端不代表 WSL 后端已更新。

## 这次修复

新增 [cloud.env.example](cloud.env.example)：构建前合并到 T3 根目录 `.env.local`，避免缺少公开登录配置而隐藏账号按钮。CI 构建也已补齐同样的配置。

本机已验证账号头像恢复、原登录状态有效、T3 Connect 隧道连接；14 项登录相关测试通过。此次仅发布源码和接入工具，未发布新安装包。另一台机器仍需完成 [验收清单](ACCEPTANCE.md)。

## 文件作用

| 文件 | 用途 |
| --- | --- |
| AI-START.md | AI 执行顺序、检查点和故障定位 |
| SETUP.md | 构建、Pi、Codex、手机的具体步骤 |
| cloud.env.example | 公开登录构建配置，无私人 token |
| patches/pi-web-shared-integration.patch | Pi Web API 与消息去重配套补丁 |
| codex/run.py、bridge.cjs、config.example.json | Windows Codex 共享启动器及模板 |
| ACCEPTANCE.md | 双向消息、全目录发现和回退验证 |
| PACKAGE.json、SHA256SUMS.json | ZIP 附带的源码提交标识与校验值 |

## 为什么还需要接入

Pi Web 补丁来自已有改动的 0.12.2 工作区，不能保证适配任意版本；检查失败需要按版本适配。Codex App 共享服务入口也存在版本差异。说明书能减少重复排查，不能让这些兼容性问题变成零配置。

外部 Pi 已保存消息约每 5 秒跟随，首次历史可能在 Settled。不承诺外部输出逐字直播、删除/回滚双向镜像。官方手机沿用原 UI，不含桌面侧栏控件或网页批注。
