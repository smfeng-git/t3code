# 2026-11-05 接入包第 2 版

仅发布源码和接入工具，不发布 Windows/Android 安装包。旧 preview 安装包保持撤回。

- 修复构建缺少公开认证配置导致账号入口消失：提供 cloud.env.example，CI 同步补齐四项配置。
- README 改为接入入口和功能选择表。
- 新增 AI-START.md：环境预检、provider 分支、故障定位、真实消息验收、运行记录。
- 操作步骤拆到 SETUP.md，明确 Windows 与 WSL 是不同后端。
- ZIP 增加 PACKAGE.json 源码提交和 SHA256SUMS.json 校验值，不混入旧 T3 源码补丁。

本机已验证账号及 T3 Connect 恢复；不代表通用安装器或另一台机器已验收。Pi Web 版本适配、Codex App 协议兼容性仍需按 ACCEPTANCE.md 检查。
