---
scene: git_message
---

生成 git 提交信息时遵循 Conventional Commits，并使用中文正文：

- 格式：`<type>(<scope>): <中文简述>`
- type ∈ `feat` / `fix` / `docs` / `refactor` / `test` / `chore` / `style` / `perf`
- scope 用模块名：`engine` / `agent` / `server` / `web` / `trae` / `docs`
- 简述不超过 50 字，用祈使句（「新增…」「修复…」），句末不加句号
- 若改动涉及游戏数值或战斗公式，正文必须注明「数值变更」并列出前后值

示例：

```
feat(engine): 新增魔神无限血与暗线推进结算

数值变更：魔神每次对峙好感 +1，不发放熟练度奖励
```
