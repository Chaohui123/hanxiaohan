---
Title: Replace exposed example secrets / rotate keys

Description:
- 本 PR 清除了仓库示例/演示文件中的真实密钥并替换为占位符（见 `.env.example`）。
- 请在合并前确认已在所有相关服务中轮换/撤销受影响的密钥，并将新密钥安全地注入部署环境。

Checklist:
- [ ] 确认 `.env.example` 中所有真实或看似真实的值已替换为占位符
- [ ] 撤销/轮换在外泄或可能外泄的密钥（GLM_API_KEY / DEEPSEEK_API_KEY / OZON_API_KEYS 等）
- [ ] 在 CI/部署平台注入新密钥（不要 commit 到仓库）
- [ ] 更新部署或运维文档（如需）
- [ ] 由安全负责人复核并批准合并

Suggested commit message:
- chore(secrets): replace example secrets with placeholders in .env.example

PR body (brief):
- Replaced real-looking secret values in `.env.example` with placeholders and added rotation checklist. This PR does not change runtime configuration; after merging, rotate any exposed keys immediately.
