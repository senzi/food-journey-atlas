# 微博原文实体回匹配与关键词高亮指南

## 1. 目的

本步骤把已经识别和归一化的餐厅、菜品、菜系、地点等实体，重新匹配到微博原文中，生成可追溯的 `mentions[]`。前端据此实现不同样式的关键词高亮和点击跳转。

本步骤不负责发现 POI、生成坐标或推断原文没有出现的信息，也不需要在页面渲染时调用 LLM。

需要始终区分：

- **原文提及**：微博正文中实际存在的文字，可以高亮。
- **图片识别**：图片或 OCR 提供的候选，仅当相同文字也出现在正文中时才作为正文高亮。
- **外部补全**：高德返回的标准名称、地址和坐标不能被描述成原文提及。
- **模型推断**：LLM/VLM 推断出的菜名、菜系或地点不能凭空插入或高亮在原文中。

## 2. 在流水线中的执行时点

推荐的数据处理顺序：

```text
原始微博入库并排除转发
→ 图片初筛与深度分析
→ 必要时进行文本实体补筛
→ 高德 POI 候选检索与消歧
→ Place / Food / Cuisine / Region 实体归一化
→ 本步骤：实体回匹配并生成 mentions[]
→ 构建 Visit
→ 重新聚类生成 Trip
→ 质量检查
→ 冻结并发布静态站点数据
```

### 必须执行本步骤的时间

在以下条件同时满足后执行：

1. 微博正文已经冻结，不再进行清洗方式变更。
2. 图片分析和必要的文本补筛已经完成。
3. 高德 POI 候选已完成匹配或被标记为未匹配、多候选、低可信。
4. 餐厅、菜品、菜系和地区的规范名称、别名及实体 ID 已经基本稳定。

本步骤必须在公开站点数据冻结之前完成。建议在构建 `Visit` 之前完成，因为原文提及可以作为地点匹配、到访资格和质量检查的证据。

### 需要重新执行的情况

以下任一数据发生变化时，应重新生成相关微博的 `mentions[]`：

- 微博正文清洗规则或正文内容变化。
- 实体规范名称、别名或实体合并关系变化。
- 高德 POI 匹配结果变化。
- 菜品、菜系或地区实体归一化结果变化。
- 高亮类型、冲突优先级或最低匹配长度规则变化。

前端样式、颜色或点击组件变化，不要求重新执行数据回匹配。

## 3. 是否需要额外运行文本 LLM

### 不需要文本 LLM 的情况

如果现有 VLM、OCR、POI 匹配和结构化字段已经提供了足够的实体候选，可以直接使用确定性字符串匹配：

- `restaurant_name_candidates`
- `dish_candidates`
- `cuisine_style`
- `place_clues`
- 高德 POI `name`
- 归一化实体的 `canonical_name`
- 归一化实体的 `aliases[]`

“为了实现高亮”本身不是再次调用 LLM 的理由。

### 可以增加文本实体补筛的情况

完成一轮确定性匹配和抽样检查后，如果发现大量原文明示实体没有进入现有结构化字段，可以对相关微博增加一次独立的文本实体提取。适用情况包括：

- 无图片但正文明确提到餐厅、菜品或菜系。
- 图片未包含招牌，但正文明确写出店名。
- VLM 按单张图片处理，遗漏了整条微博的上下文实体。
- 现有字段只能表达图片推断，无法证明原文是否提及。

文本补筛应对每条微博至多执行一次，不应跟随每张图片重复执行。输出必须包含原文引用，最好直接包含字符位置；模型不得补充原文未出现的名称。

## 4. 数据结构

### 4.1 实体数据

```json
{
  "entity_id": "place_001",
  "entity_type": "restaurant",
  "canonical_name": "XX大饭店（人民路店）",
  "aliases": [
    "XX大饭店",
    "XX饭店"
  ],
  "external_provider": "amap",
  "external_poi_id": "B0FF123456",
  "match_status": "unique_high",
  "match_confidence": 0.94
}
```

支持的 `entity_type` 首版建议限定为：

```text
restaurant
dish
cuisine
region
```

如后续需要高亮食材、烹饪方式或食品类别，应分别增加类型，不能与菜品混在同一层级。

### 4.2 微博原文提及

```json
{
  "post_id": "post_001",
  "content": "今天在XX大饭店吃了YY菜，味道很有意思。",
  "mentions": [
    {
      "mention_id": "mention_001",
      "entity_id": "place_001",
      "entity_type": "restaurant",
      "text": "XX大饭店",
      "start": 3,
      "end": 8,
      "source": "text_exact",
      "confidence": 1.0
    },
    {
      "mention_id": "mention_002",
      "entity_id": "food_001",
      "entity_type": "dish",
      "text": "YY菜",
      "start": 10,
      "end": 13,
      "source": "text_exact",
      "confidence": 1.0
    }
  ]
}
```

字段规则：

- `start`：提及在原始正文中的起始字符位置，包含该位置。
- `end`：结束字符位置，不包含该位置。
- `text`：必须等于原文 `content.slice(start, end)`。
- `source`：首版使用 `text_exact` 或 `text_alias`。
- `confidence`：精确字符串匹配可为 `1.0`；别名匹配的可信度由实体匹配状态决定。
- 一个实体可以在同一条微博中出现多次，每次出现都要保存为独立 mention。

字符位置必须基于最终发布的原始正文计算。若后端语言和前端 JavaScript 对 Unicode 字符位置的计算方式不同，需要通过包含 emoji、增补字符和组合字符的测试样本验证切片结果。

## 5. 候选词典构建

每条微博只加载与其已有分析结果相关的实体，不建议拿全站所有名称无差别匹配。

候选来源包括：

1. 微博或图片分析直接关联的餐厅、菜品、菜系和地区实体。
2. 该微博的高德 POI 候选与最终选中实体。
3. 已归一化实体的规范名称和允许公开匹配的别名。
4. 文本补筛明确提取的实体。

候选项示例：

```json
{
  "term": "XX大饭店",
  "entity_id": "place_001",
  "entity_type": "restaurant",
  "term_type": "alias",
  "entity_match_status": "unique_high",
  "entity_match_confidence": 0.94
}
```

不要把以下内容直接加入词典：

- 高德地址中的任意短词。
- 图片推断但没有对应实体的低可信菜名。
- “饭店”“餐厅”“菜”“火锅”等过于通用的单独词语。
- IP 属地。
- LLM 补全但原始证据中没有出现的名称。

## 6. 确定性匹配规则

### 6.1 文本规范化

匹配时可以构造规范化副本，用于处理：

- 全角与半角字符。
- 大小写。
- 连续空格。
- 店名中无语义差异的空格。
- 项目明确维护的简繁体或异体字别名。

规范化副本只能帮助定位，最终 `start`、`end` 和 `text` 必须映射回原始正文，不能保存规范化文本的字符位置。

### 6.2 匹配顺序

1. 按候选词长度从长到短匹配。
2. 同一长度时优先精确规范名称，其次是已维护别名。
3. 同一字符区间只保留一个主 mention。
4. 对重叠结果执行固定的类型优先级。

推荐的默认冲突优先级：

```text
restaurant > dish > cuisine > region
```

该优先级只用于解决同一区间的重叠，不代表实体在产品中的重要程度。

例如“潮州菜”已匹配为菜系时，不应再把其中的“潮州”单独高亮为地区。若“潮州菜馆”是已匹配餐厅的完整名称，应优先将整段识别为餐厅。

### 6.3 别名匹配

别名必须是实体归一化阶段维护的显式别名，不能在运行时任意截短店名。

允许：

```text
规范名称：XX大饭店（人民路店）
别名：XX大饭店
原文：去了XX大饭店
```

不允许：

```text
规范名称：XX大饭店（人民路店）
运行时自动截成：XX
```

当别名可能对应多个分店时，可以高亮为餐厅名称线索，但不能直接链接到某个确定分店。此时应链接到候选选择页、搜索结果页，或显示“分店未确定”。

## 7. 可信度与发布规则

### 餐厅

- `unique_high`：可以使用确定餐厅样式并链接 Place 详情页。
- `multiple`：可以使用候选样式，但不能暗示已确定分店。
- `low`：默认使用弱化或虚线样式，点击后展示匹配依据。
- `unmatched`：可以作为原文中的餐厅文字高亮，但不能链接到不存在的 Place。

### 菜品与菜系

- 原文精确出现且已归一化：可以链接实体详情或筛选结果。
- 仅图片识别、原文未出现：不在原文中高亮，可在图片分析摘要中展示。
- 仅文图综合推断、原文没有对应字符串：不生成正文 mention。

### 地区

- 原文明确出现的地区可以高亮。
- IP 属地不得生成原文 mention，也不得作为到访地点证据。
- 高德补全出的省市区只有在原文中确实出现时，才作为正文 mention。

## 8. 前端渲染与点击行为

前端读取 `content + mentions[]`，按字符位置切分为普通文本和实体片段。不要通过连续字符串替换生成 HTML，也不要把未经转义的正文写入 `innerHTML`。

推荐点击行为：

| 类型 | 高可信 | 不确定或未匹配 |
|---|---|---|
| `restaurant` | 进入 Place 详情页 | 展示候选、证据或相关搜索 |
| `dish` | 进入菜品详情或相关记录 | 使用该词筛选原始记录 |
| `cuisine` | 打开菜系筛选结果 | 使用该词筛选原始记录 |
| `region` | 进入地区详情页 | 使用该地区词查询 |

样式需要同时通过颜色以外的手段区分，例如下划线样式、图标或悬浮标签，以保证可访问性。

## 9. 参考实现逻辑

```js
function buildMentions(content, terms) {
  const sortedTerms = [...terms].sort((a, b) => {
    return b.term.length - a.term.length;
  });

  const candidates = [];

  for (const item of sortedTerms) {
    let fromIndex = 0;

    while (fromIndex < content.length) {
      const start = content.indexOf(item.term, fromIndex);

      if (start === -1) break;

      candidates.push({
        entity_id: item.entity_id,
        entity_type: item.entity_type,
        text: item.term,
        start,
        end: start + item.term.length,
        source: item.term_type === 'alias' ? 'text_alias' : 'text_exact',
        confidence:
          item.term_type === 'alias'
            ? item.entity_match_confidence
            : 1
      });

      fromIndex = start + item.term.length;
    }
  }

  return resolveOverlaps(candidates);
}
```

生产实现还需要处理规范化文本到原文位置的映射、稳定的 `mention_id`、类型优先级和错误日志。

## 10. 质量检查

全量生成前，先抽样检查以下类型：

- 完整餐厅名与简称同时存在。
- 同名多分店。
- 餐厅名包含地区名或菜名。
- 菜名包含菜系或食材名。
- 同一实体在正文中出现多次。
- 图片识别出菜名但正文未提及。
- 高德标准名称比原文名称更长。
- 正文含 emoji、英文、全角字符和换行。
- 低可信 POI、多候选 POI 和未匹配餐厅。

自动质量规则至少包括：

```text
mention.text == content.slice(mention.start, mention.end)
0 <= start < end <= content.length
同一微博的主 mentions 不得重叠
每个 entity_id 必须存在
图片或高德独有名称不得伪装成 text_exact
IP 属地不得生成地点 mention
```

建议记录以下指标：

- 有效微博中至少包含一个 mention 的比例。
- 各实体类型的 mention 数量。
- 别名匹配占比。
- 重叠冲突数量及解决结果。
- 多候选和低可信餐厅的高亮数量。
- 抽样误标率与漏标率。

如果确定性匹配的漏标率可以接受，不增加文本 LLM。如果漏标主要来自已有字段未覆盖的原文明示实体，再按第 3 节增加一次文本实体补筛。

## 11. 交付物

本步骤完成后应产出：

1. 带稳定实体 ID、规范名称和别名的实体数据。
2. 每条相关微博的 `mentions[]`。
3. 冲突、低可信、多候选和未匹配日志。
4. 抽样质量报告与本次使用的匹配规则版本。
5. 供静态前端读取的冻结 JSON。

建议在分析结果中记录：

```json
{
  "mention_extraction": {
    "method": "deterministic_dictionary_match",
    "rule_version": "1.0.0",
    "generated_at": "YYYY-MM-DDTHH:mm:ssZ"
  }
}
```

这样即使未来修改别名、阈值或冲突规则，也可以定位某条高亮由哪一版规则生成。

## 12. 本项目 v1 实现

本项目当前实现以以下文件为只读输入：

```text
data-processing/data/vlm_results_v2_with_poi_v5.jsonl
```

执行顺序：

```powershell
node .\data-processing\scripts\run-text-entity-extraction-llm.mjs `
  --output .\data-processing\data\analysis\text_entity_mentions_llm_v1 `
  --concurrency 500 `
  --execute `
  --confirm TEXT_ENTITY_EXTRACTION

node .\data-processing\scripts\build-entity-mentions.mjs
node .\data-processing\scripts\validate-entity-mentions.mjs
```

交付文件：

```text
data-processing/data/vlm_results_v2_with_poi_mentions_v1.jsonl
data-processing/data/entities_v1.jsonl
data-processing/data/analysis/entity_mentions_v1/mention_index.jsonl
data-processing/data/analysis/entity_mentions_v1/summary.json
data-processing/data/analysis/entity_mentions_v1/RUN_REPORT.md
```

DeepSeek 只读取微博正文并返回候选字符串与类型。请求响应按微博分别缓存到：

```text
data-processing/data/analysis/text_entity_mentions_llm_v1/raw_responses/
```

为避免模型被迫把食材和非餐饮场所误归类，内部提取还允许：

```text
ingredient
food_category
other_place
other
```

这些类型只用于质检和未来扩展，不进入首版公开 `mentions[]`。例如“毛豆”可以被标记为 `ingredient`，但不能冒充 `dish`；“尤伦斯艺术中心”可以被标记为 `other_place`，但不能冒充 `restaurant`。

当某条 LLM 响应未通过严格校验时，该微博退回 VLM、POI 与明确地区字段的确定性匹配。生成脚本不会采用不在正文中的 LLM 字符串。

餐厅 mention 的 `link_status` 分为：

```text
unique_high
multiple
unmatched
```

`unmatched` 仍可高亮并点击进入实体搜索结果，但不能直接跳转到某个确定分店。`multiple` 应展示候选或进入品牌/搜索页。

完成本步骤后，按 `GUIDE-visit-trip-building.md` 生成分级 Visit、Trip 候选与动态 JourneyView 数据。
