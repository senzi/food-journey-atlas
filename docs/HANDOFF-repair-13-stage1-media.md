# 13 个阶段一异常媒体修复交接

> 目的：修复封版 Post 数据中 13 个没有结构化阶段一结果的媒体记录。  
> 范围：只生成独立修复结果，不修改任何现有 JSONL，不重新生成 Entity、Place、Visit 或 Trip。  
> 输入基线：`data-processing/data/vlm_results_v2_with_poi_mentions_v1.jsonl`

> 状态：已于 2026-07-24 完成并通过 `stage1_missing_13_merge_v1` 合入。  
> 合入审计：`data-processing/data/analysis/stage1_missing_13_merge_v1/`

## 1. 修复对象

| Post ID | `pic_index` | 当前问题 | 正文线索 |
|---|---:|---|---|
| `6diDHN` | 0 | 模型安全拒绝 | 人物/非美食可能性高 |
| `xlAZlp0ep` | 0 | 模型安全拒绝 | 新疆、聚餐人物场景 |
| `xvan9zb4a` | 0 | 阶段一为空对象 | 中山堂历史场景，非美食可能性高 |
| `ypQti1e60` | 0 | `raw` 中串联了 5 段互相冲突的 JSON | 拉罗谢尔海鲜餐馆、生蚝 |
| `zb5nS7zKD` | 0 | 阶段一为空对象 | 南京餐馆、酱油虾、羊排、腰片等 |
| `A8yjZlHPX` | 0 | 模型安全拒绝 | 纪录片宣传，网络图片，非美食可能性高 |
| `BcrYVD6wS` | 2 | 模型安全拒绝 | 二战纪录片资料图，非美食可能性高 |
| `FgE1ZurLA` | 0 | 模型安全拒绝 | 正文含歧义表达，需只按图片判断 |
| `Fi8U1DIOq` | 0 | 模型安全拒绝 | 烧麦/烧卖讨论 |
| `HexsOkxYn` | 5 | 模型安全拒绝 | 里昂、美食之都与电影历史 |
| `J2oLYmJnk` | 4 | 模型安全拒绝 | 美食节目宣传语 |
| `Kb2AZcF6A` | 8 | 模型安全拒绝 | 食物、烹饪与书籍 |
| `LhIzPhuqf` | 3 | 模型安全拒绝 | 贵阳早餐、湖南面、肠旺面 |

以上 13 项均以 `post_id + pic_index` 定位。不要依赖数组顺序或图片 URL 作为主键。

## 2. 输入要求

对每个修复对象，从封版 Post 中读取：

```text
post_id
content
pics[pic_index]
当前 vlm_analysis[pic_index].stage1
```

原始图片 URL 仅用于本次内部分析，不得写入最终修复输出。

## 3. 阶段一预期结果

每项必须输出：

```json
{
  "food_related": true,
  "image_type": "dish | restaurant | menu | food_material | person_with_food | non_food",
  "description": "string",
  "confidence": 0.0,
  "need_deep_analysis": true,
  "visual_importance": "high | medium | low"
}
```

规则：

- 必须分析指定的单张图片，不能把同一 Post 的多张图合并成一份结果。
- 不根据正文强行把非美食图片判为美食图片。
- `confidence` 为 0–1 数字。
- 不确定时降低置信度，不编造菜品、人物或场所。
- 阶段一仍为 `non_food` 时，`need_deep_analysis` 应为 `false`。
- 不要因为旧结果是安全拒绝就沿用旧判断。

## 4. 阶段二要求

如果新的阶段一结果满足：

```text
need_deep_analysis = true
```

则使用 `docs/Prompt_B.md` 对该图片运行阶段 B，并返回完整 `stage2.analysis`。

如果为 `false`，阶段二只返回：

```json
{
  "status": "not_requested"
}
```

## 5. 交付格式

输出一个独立 JSONL，例如：

```text
data-processing/data/repairs/stage1_missing_13_repair_v1.jsonl
```

每行格式：

```json
{
  "post_id": "ypQti1e60",
  "pic_index": 0,
  "repair_status": "success | failed",
  "stage1": {},
  "stage2": {
    "status": "success | not_requested | failed",
    "analysis": {}
  },
  "processing": {
    "stage1_model": "string",
    "stage1_prompt_version": "string",
    "stage2_model": "string",
    "stage2_prompt_version": "B-v1",
    "processed_at": "ISO 8601 string"
  },
  "notes": "string"
}
```

要求：

- 一共返回 13 行；失败项也必须保留一行。
- 不包含原始图片 URL、Token 用量、模型原始响应或密钥。
- 不修改现有封版文件。
- 不创建新的 Entity、Place、Visit 或 Trip。
- 不尝试重新判断或修改 107 个封版 Trip。

## 6. 本项目合入原则

返回后由本项目逐条审查并手工合入：

- 仅替换对应媒体的异常 `stage1`。
- `need_deep_analysis = true` 时才合入新的 `stage2`。
- 保留旧异常内容到内部修复审计记录，不覆盖审计来源。
- 新结果只补充 Post/Media 展示信息，不自动改变 Entity、Place、Visit 或 Trip。
- 如新结果产生有价值的菜品或地点线索，先作为原始分析标签保留；是否进入规范 Entity 或 Facet 另行决定。
