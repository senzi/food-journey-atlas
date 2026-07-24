# 数据处理目录

本目录包含从 VLM 原始结果到网页可用结构化数据的完整离线流水线。

```text
data-processing/
  scripts/   数据扫描、修复、API/LLM 调用、构建和验证脚本
  prompts/   结构化 LLM 提示词
  data/      原始输入、中间结果、最终数据、缓存和审计报告
  .env       本地密钥，仅本机使用，不纳入 Git
```

所有命令默认从项目根目录运行，例如：

```powershell
node .\data-processing\scripts\audit-final-data.mjs
```

数据处理遵守以下原则：

1. 原始输入只读，不原地修改。
2. 每个阶段生成新文件或新目录。
3. LLM/API 原始响应按请求单独缓存。
4. 最终产物必须通过对应 validator 和完整审查。
5. `data/` 与 `.env` 不纳入 Git；代码、提示词、指南和报告结构纳入 Git。

最终数据如何供网页使用，请阅读
`docs/HANDOFF-final-data-to-web.md`。网页应构建公开字段投影，不应直接发布内部 JSONL。
