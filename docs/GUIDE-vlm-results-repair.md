# `vlm_results_v2.jsonl` 清洗与修复方案

## 1. 不可变原则

`data-processing/data/vlm_results_v2.jsonl` 是本轮 VLM 的原始交付文件，任何脚本不得原地修改、覆盖或重命名它。

每个处理阶段必须：

1. 以只读方式打开输入文件。
2. 写入一个新的、带版本号的输出文件。
3. 拒绝输入和输出为同一路径。
4. 拒绝覆盖已经存在的输出文件。
5. 保存输入处理前后 SHA-256，证明源文件没有变化。
6. 保存输出 SHA-256、脚本版本、修复数量和未解决问题。

本轮输出约定为：

```text
输入：
data-processing/data/vlm_results_v2.jsonl

新副本：
data-processing/data/vlm_results_v2_repaired_v2.jsonl

报告：
data-processing/data/analysis/vlm_v2_repair_v2/
```

## 2. 可以由脚本安全修复的问题

### 2.1 阶段二 `analysis.raw` 中的合法 JSON

5 条阶段二记录只有 `analysis.raw`。其中 4 条是字段完整的单个 JSON object，但包含可确定修复的 JSON 语法错误：

```text
尾随逗号
notes 字段末尾误用单引号
```

脚本可以：

- 解析 JSON。
- 仅修复上述明确的 JSON 语法问题。
- 校验标准字段齐全。
- 写入新副本的 `stage2.analysis`。
- 在 `_original_stage2_analysis_raw` 中保留原始字符串。
- 在 `_repair.changes[]` 记录修复。

不能解析或字段不全时不修复，只写入未解决问题。

### 2.2 非标准 `restaurant_scene.type`

采用保守、固定的映射：

```text
bar                    → unknown
农家乐                  → restaurant
家庭或家庭式餐馆          → restaurant
kitchen                → home
野餐                    → unknown
outdoor_or_field       → unknown
```

脚本在新副本中更新枚举，同时记录原值和新值。原始文件仍保留未经修改的输出。

### 2.3 地理字段的派生规范化

不修改原始 `geo`，而是在新副本增加 `geo_normalized`：

```text
usable
source_order
coordinates_source_order
coordinates_lng_lat
coordinate_system
in_china_bounds
source_type
source_poi
source_poiid
quality_flags[]
```

这一步只处理坐标顺序、全球范围合法性、占位值和空字符串，不猜测坐标系，也不执行 GCJ-02 转换。

### 2.4 图片文字过滤

不删除原始 `visible_text[]`。在每个媒体记录增加：

```text
_derived.poi_usable_visible_text[]
```

确定性排除：

- `@陈晓卿`
- 微博域名和水印
- HTTP URL
- 明显的账号水印文字

### 2.5 明确可证明的缺失来源

如果候选缺少 `source`，且候选名称在微博原文中完全一致出现，可以补成：

```text
source = text
```

必须记录修复依据。无法完全匹配时不推断为 `image` 或 `combined`。

## 3. 只能标记、不能自动修复的问题

### 3.1 阶段一异常

13 条阶段一记录缺少标准结构：

- 多数是风控拒绝信息或空对象。
- 1 条包含多个连续 JSON object，无法确定哪个对象对应当前图片。

脚本不能猜选或合并，统一标记：

```text
stage1_structure_unresolved
```

后续选择重新调用 VLM 或从产品数据隔离。

### 3.2 阶段二风控拒绝

1 条阶段二 `raw` 是：

```text
The request was rejected because it was considered high risk
```

不能构造分析结果，标记：

```text
stage2_analysis_structure_unresolved
```

### 3.3 缺失 `source` 且正文不支持

当前 8 个缺失 `source` 的候选都不能在正文中完全匹配。脚本不猜测来源，标记：

```text
candidate_source_missing_unresolved
```

### 3.4 `source=text` 但不能精确回匹配

5,888 个候选存在这种情况。它可能来自词语规范化，不一定是错误。脚本只按媒体汇总标记：

```text
text_source_not_exactly_in_content
```

不自动改为 `image` 或 `combined`。

### 3.5 多餐厅候选

同一微博出现多个不同餐厅名称不是数据错误。脚本保留全部候选，并在微博级增加：

```text
multiple_restaurant_candidates
```

后续 LLM 检索计划和 Place / Visit 构建必须支持多地点。

### 3.6 坐标系

脚本只能确认原字段顺序是 `[latitude, longitude]`，不能仅凭数值判断 WGS84 或 GCJ-02。

```text
coordinate_system = unknown_requires_review
```

在坐标系确认前，不允许直接把 `coordinates_lng_lat` 用作高德 `around` 的最终 `location`。

## 4. 修复脚本

```powershell
node .\data-processing\scripts\repair-vlm-results.mjs `
  --input .\data-processing\data\vlm_results_v2.jsonl `
  --output .\data-processing\data\vlm_results_v2_repaired_v2.jsonl `
  --report .\data-processing\data\analysis\vlm_v2_repair_v2
```

安全行为：

- 输入以只读模式打开。
- 输入与输出相同时立即拒绝。
- 输出已经存在时立即拒绝。
- 先写临时文件，完整成功后再改名为目标文件。
- 异常中断时只删除本次未完成的临时文件。
- 完成后重新计算源文件哈希。

## 5. 输出使用顺序

后续 LLM 小样本测试应改为读取：

```text
data-processing/data/vlm_results_v2_repaired_v2.jsonl
```

但必须先查看：

```text
data-processing/data/analysis/vlm_v2_repair_v2/repair_manifest.json
data-processing/data/analysis/vlm_v2_repair_v2/unresolved_issues.jsonl
```

原始文件继续作为不可变的来源层保存。修复副本属于分析结果层，不应替代或删除原始交付。
