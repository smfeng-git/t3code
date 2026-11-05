# T3 Shared 独立环境预览版（已撤回）

此版本的 Release、标签及远端安装包已删除，原因是远程接入流程未达到交付要求。以下仅保留构建记录，不是当前下载或安装建议。

这是社区定制构建，不是 T3 官方发行版。

- Windows x64：包含 Pi/Codex 会话同步适配、侧栏筛选和分组，以及同版 WSL 后端。安装包未使用商业代码签名。
- Android arm64：独立应用 T3 Shared（com.smfeng.t3shared），自有签名，包含 JS bundle，不需要 Metro。使用原有手机 UI，无网页批注或定制桌面侧栏。
- Linux x64 归档：Windows WSL 配套运行包。

首次使用仍需自己的 provider 登录；Pi Web 共享需配套补丁，Codex App 共享需配套启动器。下载 `T3-Shared-Setup.zip`，或阅读[独立环境接入说明](https://github.com/smfeng-git/t3code/blob/feat/pi-session-sync/extras/shared-sessions/README.md)。

本次构建不包含官方云服务发布凭据，T3 Connect 的可用性不作承诺；可以通过自身可达网络地址配对，异地可使用自己的 Tailscale 网络。Android 官方 OTA 更新已关闭。Windows 预览版本不发布自动更新清单。

安装前备份自己的 T3 状态。Windows 安装可能与已有 T3 安装使用相同应用标识/数据位置，不应当作隔离的并行测试安装。Android 独立包无法覆盖官方 App，也不继承其本地配置，需要重新配对。

校验文件见 SHA256SUMS.txt。构建与签名检查不等于已完成真实设备、真实账号的完整交互验收；此版本按预览版发布。

构建证据：Windows/WSL 与发布产物来自 [41997435700](https://github.com/smfeng-git/t3code/actions/runs/41997435700)，Android 来自 [41995641825](https://github.com/smfeng-git/t3code/actions/runs/41995641825)。Android 配置测试、Release 编译、APK v2/v3 签名及内置 JS bundle 检查通过；Windows 包内资源检查通过；WSL 运行包版本检查通过。原始 Android 任务的发布步骤失败已由最终发布任务接续完成。
