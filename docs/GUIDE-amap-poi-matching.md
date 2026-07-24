# VLM 结果盘点、高德 POI 检索与候选消歧指南

## 1. 目的

本指南用于把即将完成的 `vlm_results_v2.jsonl` 转换成可审计的高德 POI 候选和 Place 匹配结果。

完整步骤为：

```text
扫描 vlm_results_v2.jsonl
→ 输出数据质量与覆盖报告
→ 按微博聚合正文、原始 geo 和全部图片分析结果
→ 调用一次 LLM 生成受约束的 POI 检索计划
→ 程序校验并转换为高德 API 请求
→ 调用高德关键字搜索或周边搜索
→ 使用确定性规则评分和消歧
→ 输出候选、匹配状态、证据和质量标记
→ 抽样验收
→ 生成 Place，并交给 Visit / Trip 和原文 mentions 流程
```

这里的“一次 LLM”是指每条候选微博在本阶段调用一次地点检索规划 LLM。默认不再调用第二次 LLM 对高德结果做裁决；高德候选的排序、冲突判断和状态分档使用固定规则，以便复现和审计。

## 2. 什么时候执行

### 开始条件

在以下条件满足后开始本步骤：

1. `vlm_results_v2.jsonl` 已完成或进入不会大幅改动字段结构的冻结状态。
2. VLM 提示词、模型和分析版本可以从记录或运行清单中追溯。
3. 原始微博数据仍可通过稳定的 `post_id`、`id` 或 `mid` 与 VLM 结果关联。
4. 原始微博的 `content`、`geo`、`region_name`、`created_at` 和图片顺序可读取。
5. 转发微博已经排除，或者扫描阶段可以可靠识别并排除。

如果 VLM 任务尚未完全结束，可以先对一个稳定快照执行阶段 0 扫描和小规模试跑，但不要在同一个输出目录混合不同 VLM 版本。

### 在整个项目流水线中的位置

```text
原始微博整理
→ VLM 图片初筛与深度分析
→ 本指南：VLM 扫描、LLM 检索规划、高德检索和 POI 消歧
→ Place 实体归一化
→ 微博原文实体回匹配与 mentions[]
→ Visit 构建
→ Trip 重新聚类
→ 静态站点数据冻结
```

POI 匹配完成后再生成 Visit 和 Trip。不要沿用 POI 匹配前的旅程聚类结果作为最终数据。

## 3. 输入与输出

### 3.1 主要输入

```text
vlm_results_v2.jsonl
原始微博 JSON / JSONL
VLM 运行清单或版本信息
高德 Web 服务 API Key（仅通过环境变量） 本项目根目录 .env 有amap_key和deepseek_key
行政区名称、citycode、adcode 对照数据（如已有）(需要你查下？)
```

本指南不假定 `vlm_results_v2.jsonl` 当前已经存在于仓库。文件到达后必须先完成只读扫描，不能直接把全部记录送入 LLM 或高德。

### 3.2 建议输出目录

```text
data/
  analysis/
    vlm_v2_scan/
      summary.json
      field_coverage.json
      category_counts.json
      invalid_rows.jsonl
      duplicate_rows.jsonl
      suspicious_samples.jsonl
    poi_query_plans/
      poi_query_plans_v1.jsonl
      rejected_query_plans_v1.jsonl
    amap_raw/
      responses/
      request_log.jsonl
      error_log.jsonl
    poi_matching/
      poi_candidates_v1.jsonl
      poi_matches_v1.jsonl
      review_samples_v1.jsonl
      quality_report_v1.json
```

目录名称可以按实际工程调整，但必须区分：

1. LLM 原始输出。
2. 经过程序校验的查询计划。
3. 高德原始响应。
4. 消歧结果。
5. 最终 Place 实体。

不得只保存最终选中的 POI。

## 4. 阶段 0：扫描 `vlm_results_v2.jsonl`

### 4.1 扫描目标

扫描不是 POI 匹配本身，而是判断当前数据是否具备进入 POI 流程的条件，并回答：

- 文件能否逐行解析。
- 一行代表一张图片、一次分析还是一条微博。
- `post_id + pic_index` 是否稳定且唯一。
- VLM 版本是否混杂。
- 地点相关字段覆盖率是多少。
- 哪些地点线索来自正文、图片或文图综合。
- 有多少微博值得调用地点检索 LLM。
- 有多少微博具备调用高德周边搜索的可靠坐标。
- 有多少微博只能调用关键字搜索。
- 有多少记录只具备美食档案价值，不具备地图资格。

### 4.2 文件级完整性检查

至少检查：

```text
文件大小
总行数
空行数
合法 JSON 行数
非法 JSON 行数
顶层值不是 object 的行数
字段结构版本分布
模型版本分布
提示词版本分布
分析时间范围
```

非法行要保存：

```json
{
  "line_number": 128,
  "error": "JSON parse error",
  "raw_excerpt": "最多保留一小段，不泄露密钥或超长内容"
}
```

扫描程序遇到单行错误时继续统计，但只要存在非法 JSON，就不能直接进入全量 LLM 和高德调用。

### 4.3 标识与关联检查

至少检查：

- `post_id`、`id` 或 `mid` 是否存在。
- `pic_index` 是否存在且类型稳定。
- 同一 `post_id + pic_index` 是否重复。
- 同一图片是否有多个分析版本。
- VLM 结果能否关联到原始微博。
- `source_refs` 或媒体 ID 是否存在悬空引用。
- 原始微博中的图片数量与 VLM 结果数量是否一致。
- `retweet_of` 非空的微博是否被误纳入。

如果同一图片存在多个版本，只允许按明确规则选择一个版本，例如：

```text
指定 analysis_version
→ 同版本中选择成功状态
→ 同状态中选择最新 completed_at
```

不能因为某个结果更“像正确答案”而人工挑选版本。

### 4.4 字段覆盖检查

对以下字段分别统计：

```text
summary
image_role
dish_candidates[]
food_categories[]
ingredients_visible[]
cooking_methods[]
cuisine_style[]
restaurant_scene
restaurant_features[]
recording_context[]
visible_text[]
place_clues[]
restaurant_name_candidates[]
importance
notes
```

每个字段至少统计：

- 字段存在率。
- `null` 率。
- 空数组或空字符串率。
- 非空率。
- 类型错误率。
- 枚举非法值数量。
- 置信度缺失、越界或非数字数量。
- `source` 缺失或非法值数量。

置信度必须满足：

```text
0.0 <= confidence <= 1.0
```

来源应限定为：

```text
text
image
combined
```

### 4.5 POI 相关覆盖指标

以图片和微博两个粒度分别统计。微博粒度需要先按 `post_id` 聚合全部图片结果。

建议指标：

```text
有 restaurant_name_candidates 的图片数 / 微博数
有 place_clues 的图片数 / 微博数
有 visible_text 的图片数 / 微博数
三类地点字段至少一个非空的图片数 / 微博数
restaurant_scene.type = restaurant 的图片数
restaurant_scene.type = street_food 的图片数
restaurant_scene.type = market 的图片数
地点候选 source = text / image / combined 的数量
地点候选 confidence 分布
同一微博出现多个不同餐厅候选的数量
同一微博地点线索互相冲突的数量
具备原始 geo 的候选微博数
只有 region_name、没有实际 geo 的微博数
```

`region_name` 是 IP 属地，只单独统计数据覆盖情况，不得计入地点证据或搜索区域。

### 4.6 候选微博分类

扫描结束后，按微博分为以下互斥主类型。每条微博只能有一个主类型，但可以带多个质量标记。

| 类型 | 条件 | 后续动作 |
|---|---|---|
| `A_GEO_RESTAURANT` | 有可靠原始 `geo`，且有餐厅名候选 | LLM 规划后优先周边搜索 |
| `B_GEO_PLACE_CLUE` | 有可靠原始 `geo`，无明确餐厅名，但有地点/OCR 线索 | LLM 判断是否值得周边搜索 |
| `C_NAME_REGION` | 有餐厅名候选和非 IP 的城市/区县证据，无坐标 | LLM 规划后关键字搜索 |
| `D_NAME_ONLY` | 有餐厅名候选，但无可靠坐标和地区证据 | 可谨慎全国关键字搜索，通常保留多候选 |
| `E_AMBIGUOUS_TEXT` | 只有可能与地点有关的 OCR 或地点片段 | LLM 判断是否生成查询 |
| `F_FOOD_ONLY` | 有菜品/菜系/美食场景，但没有地点证据 | 进入美食档案，不调用高德 |
| `G_NON_MAP` | 非美食或明确没有地图价值 | 不进入本阶段 |
| `Q_INVALID` | 数据损坏、关联失败或关键字段冲突 | 修复后再处理 |

分类规则必须版本化。例如：

```json
{
  "classification_version": "poi_input_v1",
  "post_id": "post_001",
  "category": "A_GEO_RESTAURANT",
  "quality_flags": []
}
```

### 4.7 语义质量抽样

自动统计通过后仍需抽样检查。建议每种主类型至少抽取 30 条；数量不足时全看。另从下列边界情况各抽取一组：

- 置信度接近拟定阈值。
- 一个微博包含多个餐厅候选。
- `visible_text` 很长，疑似把菜单全文当店名。
- 店名只有两个汉字或是高频通用词。
- `place_clues` 实际是城市、景点、酒店、市场或道路。
- `source = image` 但图片角色不是餐厅、菜单或街景。
- `source = text` 但候选文字不在微博正文中。
- 同一微博不同图片给出冲突店名。
- VLM 输出看似补全了图片中不可见的店名。

抽样结论至少记录：

```text
字段是否适合直接作为 LLM 输入
主要漏标类型
主要误标类型
需要修复 Prompt 还是可以由后处理过滤
哪些类别应该进入试跑
```

### 4.8 阶段 0 放行条件

满足以下条件后再开始 LLM 试跑：

1. JSON 解析错误已修复或从输入中明确隔离。
2. `post_id + pic_index` 的重复和版本选择规则已确定。
3. 原始微博关联成功率达到项目可接受水平。
4. `restaurant_name_candidates`、`place_clues`、`visible_text` 的类型基本稳定。
5. 已完成上述主类型分类。
6. 已人工查看各类型样本，确认至少有一部分数据值得检索。
7. 原始 `geo` 的结构和坐标系已识别；无法识别的坐标不能进入周边搜索。

阶段 0 首次完成后先写一份简短结论，不要立即全量调用：

```text
总微博数
VLM 覆盖微博数
可进入 LLM 地点规划的微博数
可调用 around 的预计数量
可调用 text 的预计数量
仅进入美食档案的数量
损坏或待修复数量
```

## 5. 阶段 1：按微博聚合 LLM 输入

VLM 结果按图片产生，而 POI 搜索应以微博为基本决策单元。先按 `post_id` 聚合：

```json
{
  "post_id": "post_001",
  "content": "微博原文",
  "created_at": "2018-02-15T12:30:00+08:00",
  "original_geo": {
    "coordinates": [116.622603, 23.65695],
    "coordinate_system": "unknown",
    "raw": {}
  },
  "ip_region_name": "北京",
  "images": [
    {
      "pic_index": 0,
      "image_role": "restaurant",
      "visible_text": [],
      "place_clues": [],
      "restaurant_name_candidates": []
    }
  ],
  "input_category": "A_GEO_RESTAURANT"
}
```

注意：

- `ip_region_name` 可以传给 LLM 用于明确告知“禁止使用”，也可以完全不传；绝不能当搜索地区。
- 原始 `geo` 必须保留原始结构，不能只保存转换后的坐标。
- 同一微博的所有图片结果一次性提供给 LLM，避免每张图片各生成一次重复查询。
- 如果正文过长，应优先完整保留与地点有关的上下文，而不是只传 VLM 摘要。

## 6. 阶段 2：调用一次 LLM 生成检索计划

### 6.1 LLM 的职责

LLM 只负责：

- 判断是否值得调用高德。
- 从正文和 VLM 结果中选择有证据的店名或地点查询词。
- 合并同一名称的重复候选。
- 区分餐厅、市场、摊位、酒店餐饮等地点类型。
- 提取非 IP 的省、市、区县、商圈、道路和地标线索。
- 指出证据来源和冲突。
- 建议使用 `around`、`text` 或不搜索。

LLM 不负责：

- 生成或猜测经纬度。
- 生成高德 Key。
- 自由填写高德 typecode。
- 把菜名当作餐厅名。
- 把 IP 属地当作实际位置。
- 宣布某个 POI 已经匹配成功。
- 拼接最终 HTTP URL。
- 在输入证据之外补全店名、分店名或地址。

### 6.2 LLM 输出 Schema

```json
{
  "search_summary": "识别出两个独立地点组",
  "place_groups": [
    {
      "candidate_indexes": [0, 1],
      "relationship": "same_place_alias",
      "place_kind": "restaurant",
      "role": "primary_visit",
      "should_query": true,
      "confidence": 0.94,
      "query": {
        "keyword": "朝外螺师傅",
        "keyword_kind": "restaurant_name",
        "endpoint_hint": "text",
        "region_clues": ["北京", "朝外"],
        "address_clues": []
      },
      "evidence": [
        {
          "source": "text",
          "quote": "去朝外螺师傅吃粉",
          "pic_index": null
        }
      ]
    }
  ],
  "unassigned_candidates": [],
  "conflicts": [],
  "notes": ""
}
```

枚举建议固定为：

```text
place_kind:
restaurant | street_food | market | hotel_food | attraction |
building | region | other | unknown

endpoint_hint:
around | text

keyword_kind:
restaurant_name | place_name | address_fragment | market_name |
building_name | other

relationship:
single_candidate | same_place_alias | same_brand_branch_uncertain |
historical_or_renamed | not_a_place | insufficient_evidence

role:
primary_visit | secondary_visit | comparison_only |
mentioned_only | delivery_only | unknown
```

一条微博可以返回多个 `place_groups`。同店简称和全称放入同一个组，只生成一次查询；真实不同地点拆成多个组。测试阶段最多允许 5 个 `should_query=true` 的地点组。

### 6.3 LLM 提示词要求

提示词至少包含以下硬性规则：

```text
只返回合法 JSON。
只能使用输入中明确存在的地点证据。
不得使用 IP 属地推断实际位置。
不得生成或修正坐标。
菜名、菜系和食材不是餐厅查询词，除非它们明确属于店名的一部分。
图片推断的普通场景特征不是店名。
同店别名合并到同一个地点组。
真实多地点分别生成查询，不能强制只选一个。
人物、泛称和地区上下文不能作为独立餐厅。
无法形成可检索名称时 should_query=false 且 query=null。
每个查询词必须附带原文引用或图片索引证据。
一条微博可能包含多个地点，不能强行合并。
```

### 6.4 程序校验 LLM 输出

LLM 输出必须经过程序校验，不能直接调用高德。`post_id` 不要求模型返回；调用程序使用发起请求时的 `post_id` 包装响应，避免把关联正确性依赖于模型复述：

- JSON Schema 合法。
- 响应中不应出现模型自行生成的 `post_id` 或请求 ID。
- 每个候选索引只能进入一个地点组或未分配列表，不能遗漏或重复。
- `should_query=true` 的地点组不超过 5 个。
- `same_place_alias` 至少包含两个名称候选。
- `not_a_place` 和 `insufficient_evidence` 不得生成查询。
- 查询词非空且长度符合高德限制。
- 查询词确实可以在正文、`visible_text`、`place_clues` 或 `restaurant_name_candidates` 中追溯。
- 查询词不能把店名和地区拼成输入中不存在的新字符串。
- 查询内的 `region_clues` 不是来自 `region_name`。
- 查询的 `endpoint_hint = around` 时存在可靠原始坐标。
- 菜名、菜系和通用词没有被错误当成独立店名。
- 不允许 LLM 输出 `key`、`types`、`radius`、`city_limit` 等最终 API 参数。

校验失败的计划进入 `rejected_query_plans_v1.jsonl`，不得静默修正后调用。

## 7. 阶段 3：程序生成高德请求

高德 POI 2.0 官方提供关键字搜索和周边搜索：

```text
关键字搜索：
GET https://restapi.amap.com/v5/place/text

周边搜索：
GET https://restapi.amap.com/v5/place/around
```

接口细节应以运行时的高德官方文档为准：

```text
https://lbs.amap.com/api/webservice/guide/api/newpoisearch
```

### 7.1 周边搜索 `around`

适用条件：

- 存在可靠中心坐标。
- 坐标系已知并已转换为高德坐标。
- 有餐厅或地点查询词，或者确实需要检索坐标附近的餐饮 POI。

示例：

```text
https://restapi.amap.com/v5/place/around
  ?key=<AMAP_WEB_SERVICE_KEY>
  &location=116.622603,23.656950
  &keywords=XX大饭店
  &types=050000
  &radius=5000
  &sortrule=weight
  &region=潮州市
  &city_limit=true
  &show_fields=business
  &page_size=10
  &page_num=1
```

参数生成规则：

- `location`：来自已验证和转换的原始 `geo`，不能来自 LLM。
- `keywords`：一次请求首版只传一个查询词，便于审计。
- `types`：由程序根据 `place_kind` 映射；餐饮首版使用 `050000`。
- `radius`：由坐标精度和试跑结果决定。
- `region`：只有存在非 IP 的可信行政区证据时才传。
- `city_limit`：只有行政区证据可靠时设为 `true`。
- `show_fields`：首轮使用 `business` 即可；不要默认下载 `photos`。
- `page_size`：首轮建议 10，边界样本可增加到 25。
- `page_num`：默认 1；只有在明确需要扩大召回时才请求下一页。

半径建议作为试跑起点，而不是未经验证的最终阈值：

| 原始坐标精度 | 建议起始半径 |
|---|---:|
| 明确 POI/建筑级 | 500–1000 米 |
| 道路或街区级 | 2000–3000 米 |
| 一般设备定位 | 5000 米 |
| 只有城市中心点 | 不使用 around |

### 7.2 关键字搜索 `text`

适用条件：

- 没有可靠中心坐标。
- 有明确餐厅名、市场名、建筑名或结构化地址。
- 有可信城市/区县时用于缩小召回范围。

示例：

```text
https://restapi.amap.com/v5/place/text
  ?key=<AMAP_WEB_SERVICE_KEY>
  &keywords=XX大饭店
  &types=050000
  &region=潮州市
  &city_limit=true
  &show_fields=business
  &page_size=10
  &page_num=1
```

使用规则：

- 明确店名 + 城市，但没有坐标：优先 `text`。
- 只有店名，没有城市：可以试跑全国检索，但不得自动判为唯一地点。
- 只有城市名：不搜索具体餐厅，保留城市级地点。
- 只有菜名：不作为 POI 查询词。
- 只有结构化地址：可以使用 `text`，但需要在结果中保留地址证据。

### 7.3 坐标系

高德坐标属于 GCJ-02。原始 `geo` 的坐标系未知时，不得直接调用 `around`。

建议保存：

```json
{
  "coordinates_raw": [116.622603, 23.65695],
  "coordinate_system_raw": "WGS84",
  "coordinates_amap": [116.6287, 23.6512],
  "coordinate_system_amap": "GCJ02",
  "coordinate_conversion": {
    "method": "amap_coordinate_convert",
    "version": "v3",
    "converted_at": "YYYY-MM-DDTHH:mm:ssZ"
  }
}
```

高德 Web 服务坐标转换接口：

```text
GET https://restapi.amap.com/v3/assistant/coordinate/convert
```

官方文档：

```text
https://lbs.amap.com/api/webservice/guide/api/convert
```

转换前必须先确认原始坐标系，不能通过“看起来差不多”猜测。

### 7.4 Key 与请求安全

- Key 只保存在环境变量，例如 `AMAP_WEB_SERVICE_KEY`。
- 不把 Key 写入 JSONL、请求日志、Git、前端代码或错误报告。
- 请求日志中的 URL 必须移除或遮盖 `key` 和 `sig`。
- 后端或离线脚本负责调用，公开静态网页不直接携带 Web 服务 Key。
- 记录接口版本、请求时间、响应状态、`infocode` 和重试次数。

### 7.5 缓存、限速和重试

使用规范化请求指纹去重：

```text
endpoint
+ keyword
+ types
+ normalized region
+ city_limit
+ rounded location
+ radius
+ page_size
+ page_num
```

相同请求直接读取本地缓存。对超时和可重试服务错误采用有限次数指数退避；对参数错误、权限错误和配额错误停止重试并记录。

开始全量调用前，确认高德账户当前配额和使用条款。POI 2.0 官方文档提示上线使用前需要确认流量配额。

## 8. 阶段 4：保存高德原始响应

每次请求至少记录：

```json
{
  "request_id": "amap_req_001",
  "post_id": "post_001",
  "query_plan_version": "poi_query_plan_v1",
  "endpoint": "around",
  "params_redacted": {
    "keywords": "XX大饭店",
    "types": "050000",
    "location": "116.622603,23.656950",
    "radius": 5000,
    "region": "潮州市",
    "city_limit": true,
    "page_size": 10,
    "page_num": 1
  },
  "requested_at": "YYYY-MM-DDTHH:mm:ssZ",
  "http_status": 200,
  "amap_status": "1",
  "infocode": "10000",
  "response_file": "responses/amap_req_001.json"
}
```

原始 `pois[]` 不做覆盖式清洗。派生出的规范字段另存，确保以后可以重新运行评分规则而无需再次消耗 API。

## 9. 阶段 5：候选标准化与确定性评分

### 9.1 候选标准化

从高德响应中至少保留：

```text
id
name
parent
location
distance
type
typecode
pname
cityname
adname
address
pcode
citycode
adcode
business.alias
business.business_area
```

`rating`、`cost` 和当前营业信息不是“是否到访”的匹配证据，不应提高 POI 匹配分数。

### 9.2 建议评分维度

评分以固定特征组成：

```text
name_similarity
alias_similarity
region_consistency
address_clue_similarity
distance_score
type_consistency
evidence_strength
conflict_penalty
```

首轮试跑可以采用：

```text
总分 =
  0.35 × 名称相似度
+ 0.10 × 高德别名相似度
+ 0.15 × 行政区一致性
+ 0.10 × 地址/商圈线索一致性
+ 0.15 × 距离得分
+ 0.05 × POI 类型一致性
+ 0.10 × 原始证据强度
- 冲突惩罚
```

这只是待验证的基线。正式阈值必须由试跑样本确定，并随规则版本冻结。

名称相似度应同时比较：

- LLM 选择的原始查询词。
- VLM/OCR 原始文字。
- 高德 `name`。
- 高德 `business.alias`。

不能只用模糊编辑距离。还需要识别括号内分店名、数字店号、酒店餐厅、总店/分店等结构。

### 9.3 硬冲突规则

以下情况不得自动选为高可信：

- 可靠城市证据与高德城市冲突。
- 原始坐标与候选距离明显超出设定半径。
- 原文出现分店名，但候选是另一分店。
- 一个查询得到多个名称高度相似、距离也接近的分店。
- 店名只有通用词，无法形成身份区分。
- 高德结果是商场、住宅或景点，而证据明确指向餐厅。
- 微博时间与 POI 当前信息之间可能存在迁址、改名或闭店问题。
- 一条微博包含多个地点，却被合并成一个候选。
- 查询地区仅来自 IP 属地。

### 9.4 匹配状态

对外和对内使用固定状态：

```text
unique_high
multiple
low
unmatched
not_searched
invalid_input
api_error
```

建议的判定逻辑：

```text
unique_high：
最高分达到高阈值
且与第二名存在足够分差
且没有硬冲突

multiple：
有两个或以上合理候选
或同名分店无法区分

low：
存在候选，但证据不足或有可解释冲突

unmatched：
请求成功但没有可接受候选

not_searched：
LLM 或规则判断不应调用高德
```

在没有大规模人工校验的情况下，`unique_high` 表示“唯一高可信候选”，不等于“人工确认地点”。

### 9.5 消歧输出

```json
{
  "post_id": "post_001",
  "query_plan_id": "plan_001",
  "request_ids": ["amap_req_001"],
  "match_status": "unique_high",
  "selected_poi_id": "B0FF123456",
  "match_score": 0.91,
  "score_version": "poi_score_v1",
  "match_evidence": [
    {
      "type": "name",
      "detail": "原文店名与高德名称主体一致"
    },
    {
      "type": "distance",
      "detail": "距原始 geo 286 米"
    },
    {
      "type": "region",
      "detail": "城市和区县一致"
    }
  ],
  "quality_flags": [],
  "candidates": [
    {
      "poi_id": "B0FF123456",
      "score": 0.91,
      "rank": 1,
      "features": {}
    }
  ]
}
```

即使 `unique_high`，也必须保留全部返回候选、查询词、请求参数、评分特征和选取依据。

## 10. 试跑与全量执行

### 10.1 第一轮试跑

不要直接全量执行。建议从阶段 0 的分类中分层抽取 100–200 条：

```text
A_GEO_RESTAURANT
B_GEO_PLACE_CLUE
C_NAME_REGION
D_NAME_ONLY
E_AMBIGUOUS_TEXT
F_FOOD_ONLY 作为不应搜索的负样本
```

重点覆盖：

- 明确店名。
- 图片招牌 OCR。
- 同名分店。
- 市场和街边摊。
- 酒店内餐厅。
- 老微博、疑似改名或迁址。
- 一条微博多个地点。
- 只有菜名的负样本。
- 只有 IP 属地的负样本。

### 10.2 试跑指标

```text
LLM should_search 通过率
LLM 查询计划 Schema 合法率
无证据查询词比例
错误使用 IP 属地比例
around / text / 不搜索的数量
高德成功响应率
零结果率
Top 1 抽样正确率
Top 3 抽样召回率
unique_high / multiple / low / unmatched 分布
错城市比例
错分店比例
不该搜索却调用高德的比例
同一请求缓存命中率
单条候选微博平均 LLM 与高德调用次数
```

### 10.3 全量放行条件

只有在以下内容确定后进行全量：

1. `vlm_results_v2.jsonl` 的扫描报告已归档。
2. LLM 输出 Schema 和提示词版本已冻结。
3. 高德请求生成规则已冻结。
4. 坐标系处理方法已验证。
5. 评分特征和状态阈值已根据试跑调整。
6. 负样本不会被大量送入高德。
7. 缓存、脱敏、限速、错误恢复和断点续跑可用。
8. 抽样结果达到项目接受标准。

全量过程中按固定批次保存检查点。中断后从最后成功批次继续，不能覆盖已保存的原始响应。

## 11. Place 生成和后续衔接

只有完成候选消歧后，才生成或更新 Place：

```json
{
  "id": "place_001",
  "canonical_name": "XX大饭店（人民路店）",
  "raw_names": ["XX大饭店"],
  "place_type": "restaurant",
  "region_ids": ["region_chaozhou", "region_xiangqiao"],
  "coordinates": [116.622603, 23.65695],
  "coordinate_system": "GCJ02",
  "coordinate_precision": "poi",
  "match_status": "unique_high",
  "external_provider": "amap",
  "external_poi_id": "B0FF123456",
  "source_refs": ["post_001", "media_001"],
  "match_confidence": 0.91,
  "match_evidence": [],
  "quality_flags": []
}
```

后续规则：

- `unique_high` 可以生成具体 Place，但产品文案仍不得写成“人工确认”。
- `multiple` 不默认创建某个确定分店的 Place。
- `low` 默认不生成公开地图点，除非产品采用明确的弱可信展示。
- `unmatched` 可以保留原文地点候选，不生成虚构坐标。
- 只有城市级证据时使用 Region，不创建假 POI。
- Place 稳定后执行 `GUIDE-entity-mentions.md`，把原文确实出现的店名回匹配成可点击 mention。
- Place、Visit 和 Trip 的公开数据不得包含高德 Key、请求签名或不应公开的处理输入。

## 12. 版本与可复现性

每次运行至少记录：

```json
{
  "pipeline": "amap_poi_matching",
  "pipeline_version": "1.0.0",
  "vlm_input_file": "vlm_results_v2.jsonl",
  "vlm_input_sha256": "sha256...",
  "input_classification_version": "poi_input_v1",
  "llm_model": "运行时填写",
  "llm_prompt_version": "poi_query_plan_v1",
  "query_schema_version": "poi_query_plan_v1",
  "amap_api_version": "v5",
  "score_version": "poi_score_v1",
  "started_at": "YYYY-MM-DDTHH:mm:ssZ",
  "completed_at": "YYYY-MM-DDTHH:mm:ssZ"
}
```

必须固定输入文件哈希。否则同名 `vlm_results_v2.jsonl` 被替换后，旧的覆盖报告、LLM 输出和高德结果将无法复现。

## 13. 完成交付标准

本步骤完成时应具备：

1. `vlm_results_v2.jsonl` 数据质量与覆盖报告。
2. 按微博划分的 A–G/Q 类型统计及抽样结论。
3. 版本化的 LLM 检索规划提示词、Schema 和原始输出。
4. 通过程序校验的高德请求计划。
5. 脱敏请求日志和完整高德原始响应缓存。
6. 带全部候选、评分特征、状态和证据的消歧结果。
7. 试跑质量报告和全量放行记录。
8. 可供 Place、mentions、Visit 和 Trip 使用的稳定结果。

如果只得到一份“最终 POI ID 列表”，但不能追溯 VLM 线索、LLM 查询计划、高德候选和评分依据，则本步骤不算完成。

## 14. 当前项目脚本

只读扫描：

```powershell
node .\data-processing\scripts\scan-vlm-results.mjs `
  --input .\data-processing\data\vlm_results_v2.jsonl `
  --output .\data-processing\data\analysis\vlm_v2_scan
```

扫描器不会调用 LLM 或高德，也不会修改输入文件。

生成 10 条分层 LLM 测试输入，默认只做 dry-run：

```powershell
node .\data-processing\scripts\test-poi-query-llm.mjs `
  --input .\data-processing\data\vlm_results_v2_repaired_v2.jsonl `
  --output .\data-processing\data\analysis\poi_llm_pilot_repaired_v2 `
  --limit 10 `
  --concurrency 3 `
  --retries 2
```

网络测试必须同时提供：

```text
--execute
--confirm TEST_ONLY
```

`--concurrency` 取值为 1–5，默认 3；结果仍按输入顺序写入。`--retries` 取值为 0–2，默认 2，只对失败的 LLM 请求做有限重试。

网络中断后如只需补测失败样本，可使用 `--post-ids` 定点选择，避免重复请求已经成功的样本：

```powershell
node .\data-processing\scripts\test-poi-query-llm.mjs `
  --limit 2 `
  --post-ids POST_ID_1,POST_ID_2 `
  --concurrency 2 `
  --retries 2 `
  --output .\data-processing\data\analysis\poi_llm_retry_2 `
  --execute `
  --confirm TEST_ONLY
```

测试脚本硬限制最多 20 条，并且不包含高德调用逻辑。每次测试必须写入新的空输出目录，脚本拒绝覆盖已有结果。全量处理应使用未来单独编写并经过明确批准的生产脚本，不能通过修改测试参数绕过限制。

### 14.1 全量 LLM 查询规划

仅在小批提示词验证完成、并获得明确全量授权后使用：

```powershell
node .\data-processing\scripts\run-poi-query-llm-full.mjs `
  --input .\data-processing\data\vlm_results_v2_repaired_v2.jsonl `
  --output .\data-processing\data\analysis\poi_llm_full_v2 `
  --concurrency 500 `
  --retries 2 `
  --execute `
  --confirm FULL_LLM_RUN
```

该脚本不会修改输入文件，并支持断点续跑。目录结构：

- `raw_responses/<post_id>.json`：模型 API 的原始 JSON 响应，每条微博一个文件。
- `results/<post_id>.json`：解析、关联并校验后的查询计划。
- `errors/<post_id>.json`：失败记录；续跑时会重新处理。
- `results.jsonl`、`errors.jsonl`：结束后按输入顺序汇总。
- `manifest.json`、`progress.json`、`run_summary.json`：参数、实时进度和最终统计。

已有 `results/<post_id>.json` 的记录会被跳过；输入路径、模型、提示词哈希或样本总数变化时，脚本拒绝在同一目录续跑。

### 14.2 高德 POI 小批测试

高德测试脚本只读取 `validation.valid=true` 且 `should_query=true` 的地点组，单次最多发送 20 个请求：

```powershell
node .\data-processing\scripts\test-amap-poi-search.mjs `
  --plans .\data-processing\data\analysis\poi_llm_full_v2\results.jsonl `
  --output .\data-processing\data\analysis\amap_poi_test_v1 `
  --limit 10
```

上述命令只生成请求计划，不访问高德。默认排除 `region`、`other` 和 `unknown` 类型，也不会在坐标系未确认时生成周边搜索请求。

高德请求固定串行执行（`--concurrency 1`），不允许通过参数提高并发。

如已经确认源坐标为高德使用的 GCJ-02，可先生成周边与文本混合 dry-run：

```powershell
node .\data-processing\scripts\test-amap-poi-search.mjs `
  --limit 10 `
  --coordinate-system gcj02 `
  --output .\data-processing\data\analysis\amap_poi_test_v1_mixed
```

`--coordinate-system gcj02` 是调用方对源数据的明确断言，不是脚本自动推断。高德使用 GCJ-02；如果源坐标是 WGS84、百度或其他坐标系，应先完成坐标转换，不能直接添加该参数。

实际小批请求必须使用新的空目录，并同时提供：

```text
--execute
--confirm AMAP_TEST_ONLY
```

脚本不会把 Key 写入 manifest、请求计划或日志；URL 中的 Key 使用 `<redacted>`。成功响应会逐请求保存在 `raw_responses/<request_id>.json`。

### 14.3 全量高德文本召回

只有在小批高德测试成功并获得明确全量授权后，才运行：

```powershell
node .\data-processing\scripts\run-amap-poi-search-full.mjs `
  --output .\data-processing\data\analysis\amap_poi_full_text_v1 `
  --retries 2 `
  --execute `
  --confirm FULL_AMAP_RUN
```

该脚本固定串行执行并支持断点续跑。坐标系尚未确认时，原 `around` 计划临时降级为 `text`，但每条请求保留 `original_endpoint`、`fallback_reason` 和原坐标上下文。

目录结构：

- `requests/<request_id>.json`：不含 Key 的完整请求计划。
- `raw_responses/<request_id>.json`：高德原始响应。
- `results/<request_id>.json`：解析后的候选。
- `errors/<request_id>.json`：失败记录，续跑时会重试。
- `results.jsonl`、`errors.jsonl`、`run_summary.json`：聚合结果。

### 14.4 确定性候选评分

高德候选完成后，先运行不依赖 LLM 的评分：

```powershell
node .\data-processing\scripts\score-amap-poi-candidates.mjs `
  --input .\data-processing\data\analysis\amap_poi_full_text_v1 `
  --output .\data-processing\data\analysis\amap_poi_scored_v2_final
```

评分特征包括：

- 店名精确、基础名称、包含关系和编辑相似度；
- 省市区、商圈和地址线索；
- POI 类型兼容性；
- 高德返回排序；
- 原始坐标与名称可信候选的直线距离。

距离当前只用于坐标诊断，不主导文本候选选择。输出状态：

- `auto_selected`：名称与上下文强匹配且领先明显；
- `multiple_retained`：多个同名分店或相近候选均值得保留；
- `llm_review_required`：存在合理候选但证据不足；
- `no_confident_match`：没有可信候选；
- `rejected_invalid_query`：查询词本身是描述性指代而非地点名。

只有 `llm_review_required` 默认进入后续 LLM 消歧。LLM 只能从传入的高德 POI ID 中选择、保留多个或拒绝，不能创建新 POI。

参考代码，不过是python的。
import json
from openai import OpenAI

client = OpenAI(
    api_key="<your api key>",
    base_url="https://api.deepseek.com",
)

system_prompt = """
The user will provide some exam text. Please parse the "question" and "answer" and output them in JSON format.

EXAMPLE INPUT:
Which is the highest mountain in the world? Mount Everest.

EXAMPLE JSON OUTPUT:
{
    "question": "Which is the highest mountain in the world?",
    "answer": "Mount Everest"
}
"""

user_prompt = "Which is the longest river in the world? The Nile River."

messages = [{"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}]

response = client.chat.completions.create(
    model="deepseek-v4-flash",
    messages=messages,
    response_format={
        'type': 'json_object'
    }
)

print(json.loads(response.choices[0].message.content))
