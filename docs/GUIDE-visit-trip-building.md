# Visit、Trip 与动态旅程构建指南

## 1. 目的

本步骤在 `mentions[]`、POI 和食物实体基本稳定后，把微博整理为可追溯的到访事件（Visit）与系统旅程（Trip），并为网站的动态“重新构建旅程”功能提供基础数据。

Visit / Trip 是微博之上的时空解释层，不是微博筛选器。没有达到到访门槛的吃喝微博仍应保留在 Post、Food、搜索结果和图片档案中。

## 2. 执行时点

推荐顺序：

```text
微博与 VLM 数据冻结
→ 高德 POI 检索与消歧
→ 实体归一化与 mentions[]
→ 构建分级 Visit
→ 使用高置信 Visit 聚类 Trip
→ 添加候选点和其他旅程上下文
→ LLM 生成 Trip 叙事
→ 冻结静态数据
```

以下内容变化时，需要重建相关 Visit / Trip：

- POI 选择、坐标或坐标可信度变化；
- 微博发布时间、实际到访时间或回顾性内容判断变化；
- Place、Food、mentions 或 Post 关联变化；
- Visit 门槛、聚类参数或 Trip 边界规则变化。

仅前端颜色和地图样式变化不要求重建数据。

## 3. Post、Visit 与 Trip 的关系

- 所有微博都是 `Post`，都可以参与全文、餐厅、菜品、菜系和时间搜索。
- 有地点与时间证据的微博可以生成或关联 `Visit`。
- 多条微博可以合并为一次 Visit。
- 一条微博可以提及多个地点，但不等于实际到访多个地点。
- Visit 可以不属于任何 Trip，例如孤立的本地用餐记录。
- Trip 由一组有时间顺序、空间关系合理的 Visit 组成。
- 某条微博可以成为 Trip 的上下文，但不生成 Visit，也不成为路线节点。

不以 Visit / Trip 覆盖率作为唯一优化目标。可信的较低覆盖率优于用保底坐标制造完整但错误的路线。

## 4. Visit 分级

建议先给每条微博生成 `journey_role`：

```text
visit_anchor
region_visit
trip_context
search_only
```

### 4.1 `visit_anchor`

可以成为路线节点，通常满足：

- 具有高德确定 POI、明确地址，或经过异常检查的微博原签到坐标；
- 时间至少可定位到一天或较短范围；
- 正文没有明显“旧图、回忆、转述、推荐但未到访”等冲突；
- 多候选地点不会显著改变路线。

### 4.2 `region_visit`

正文能证明城市或地区，但没有可信的具体地点。可以进入旅程时间线和地区统计，但城市中心点不能伪装成餐厅坐标，也不应参与精确路线距离。

### 4.3 `trip_context`

时间、主题或相邻高置信记录表明它可能与某次旅程有关，但自身不能证明具体地点。可以展示在 Trip 时间线、图片或相关微博中，不作为独立到访事实。

### 4.4 `search_only`

没有足够的到访时空证据。仍参与全文搜索、Food/mentions 筛选、主题统计和原始档案展示。

IP 属地、`global_default` 和纯展示保底点只能用于 `search_only`；`temporal_neighbor` 默认最多为 `trip_context`。

## 5. Visit 数据结构

```json
{
  "id": "visit_xxx",
  "place_id": "place_xxx",
  "region_id": null,
  "visited_at_start": "2018-02-16T00:00:00+08:00",
  "visited_at_end": "2018-02-16T23:59:59+08:00",
  "time_precision": "day",
  "post_ids": ["post_xxx"],
  "media_ids": [],
  "food_ids": [],
  "evidence_type": "amap_poi_and_post_time",
  "confidence": 0.91,
  "route_eligibility": "anchor",
  "trip_id": null,
  "quality_flags": []
}
```

推荐增加：

```text
location_precision
coordinate_source
visit_assertion
time_evidence[]
location_evidence[]
membership_status
```

`visit_assertion` 至少区分：

```text
visited
likely_visited
mentioned_only
delivery_only
historical_reference
unknown
```

只有 `visited` 和高可信 `likely_visited` 默认进入路线聚类。

## 6. 合并和拆分 Visit

可以合并为同一 Visit 的典型条件：

- Place 相同；
- 时间间隔较短；
- 内容没有“再次去、第二天、后来”等明确拆分信号；
- 多条微博显然描述同一餐或同一现场。

应拆分的情况：

- 同一餐厅在不同日期再次到访；
- 一条微博回顾多个历史时点；
- 多个地点只是比较、推荐或列表，不代表连续到访；
- 同名不同分店仍未消歧。

合并必须保留全部 `post_ids[]` 和证据，不能删除来源微博。

## 7. Trip 聚类

DBSCAN 只作为候选生成器，不直接等同于最终事实。输入应优先使用 `route_eligibility=anchor` 的 Visit。

至少比较多组参数：

- 时间窗口；
- 空间距离；
- 最小 Visit 数；
- 同城和跨城使用不同距离阈值；
- 城市级 Visit 是否只参与边界补充；
- 返程、转场和长时间停留的拆分规则。

每次运行记录：

```text
cluster_method
cluster_params
input_visit_version
cluster_version
noise_visit_ids[]
quality_metrics
```

需要抽样检查：

- 同城连续多日是否被错误拆散；
- 相邻城市短途是否被错误拆散；
- 七天内相距很远的记录是否被错误合并；
- 返程后再次出发是否应拆成两个 Trip；
- 微博发布时间是否可能晚于真实到访；
- 一条微博的多个地点是否被误连为路线。

## 8. Trip 地图的三层点

Trip 地图可以展示主路线之外的信息，但需要在数据语义上分层：

| 地图角色 | 含义 | 默认样式 | 是否进入主路线 |
|---|---|---|---|
| `route_anchor` | 本 Trip 的高置信 Visit | 实心 | 是 |
| `trip_candidate` | 时间大致吻合但证据不足 | 空心或虚线 | 否 |
| `revisit_context` | 同一地点附近的其他时间记录或其他 Trip | 半透明 | 否 |

推荐结构：

```json
{
  "visit_ids": ["visit_001", "visit_002"],
  "candidate_visit_ids": ["visit_003"],
  "context_refs": [
    {
      "visit_id": "visit_019",
      "trip_id": "trip_2021_xxx",
      "relation": "same_place_revisit"
    }
  ]
}
```

不属于当前时间段的点不能写入主 `visit_ids[]`。点击 `revisit_context` 时应显示其日期、证据和所属 Trip，并允许跳转。

附近但没有实体或主题关联的 POI 不应默认混入 Trip；如产品需要，可作为单独的“附近探索”图层。

## 9. 路线连线规则

路线连线门槛高于地图点展示门槛：

- 只连接 `route_anchor`；
- 按 `visited_at` 排序，同时展示 `time_precision`；
- 城市级中心点、时间邻居、IP 属地和全局默认点不得进入精确连线；
- 时间顺序不确定时不强画单一路径，可使用分段、虚线或“不确定顺序”；
- 多候选 POI 会显著改变路线时，该 Visit 降级为候选点。

前端不得让连线暗示系统已知真实交通路线。未使用路线规划服务时，应描述为“到访点顺序连线”。

## 10. LLM 生成 Trip 叙事

先由确定性程序冻结 Trip 成员、时间边界、路线顺序、主题统计和证据，再调用 LLM。

LLM 可以生成：

- 标题和副标题；
- 简短摘要；
- 主要菜品、菜系与地区主题；
- 路线亮点；
- 再次到访关系说明；
- 不确定性提示。

LLM 不得：

- 决定 Visit 是否属于 Trip；
- 修改路线顺序、坐标或时间；
- 把候选地点升级为已确认到访；
- 引入输入中不存在的餐厅、菜品和事实；
- 把系统聚类描述成作者本人定义的一次旅行。

建议输出：

```json
{
  "title": "春节里的潮汕寻味",
  "subtitle": "从汕头到潮州的连续饮食记录",
  "summary": "...",
  "themes": ["牛肉火锅", "潮州菜"],
  "highlights": [],
  "uncertainty_note": "部分记录只能定位到城市级别。",
  "evidence_visit_ids": [],
  "evidence_post_ids": []
}
```

所有引用 ID 必须通过程序校验，且叙事结果需要记录模型、提示词版本、输入摘要哈希和生成时间。

## 11. 动态 JourneyView

网站中用户重新构建的“旅程”建议使用独立对象 `JourneyView`，不要直接改写系统 Trip。

```text
全部 Post / Food / mentions 检索
→ 召回相关微博
→ 提取可用 Visit
→ 组合一个或多个基础 Trip
→ 添加 region_visit 和 trip_context
→ 可选调用 LLM 取名和总结
```

动态结果可能跨越多个年份和多个基础 Trip，例如“历年在潮州吃过的牛肉”。它是用户主题视图，不应被表述为一次真实连续行程。

没有 Visit 的吃喝微博仍可作为 JourneyView 的主题资料、图片、菜品证据和相关记录展示，只是不进入主路线。

## 12. 质量检查与交付

自动检查至少包括：

- 每个 Visit 至少引用一个有效 Post；
- 每个具体 Place 至少有来源证据；
- 主路线只包含合格 Visit；
- Trip 开始时间不晚于结束时间；
- `context_refs` 不会被计入主 Visit 数；
- 引用的 Post、Place、Food、Visit 和 Trip ID 均存在；
- IP 和全局默认点不参与聚类及连线；
- LLM 引用 ID 均来自其输入；
- 原始微博数据保持不变，所有步骤输出新文件。

交付物建议包括：

1. `visits.jsonl`
2. `trips.jsonl`
3. `trip_membership_candidates.jsonl`
4. `trip_context_refs.jsonl`
5. `trip_narratives.jsonl`
6. 聚类参数对比与抽样报告
7. 供前端使用的冻结索引

## 13. 本项目 v1 实现

当前实现以带 `mentions[]` 的微博副本为输入：

```text
data-processing/data/vlm_results_v2_with_poi_mentions_v1.jsonl
```

执行命令：

```powershell
node .\data-processing\scripts\run-visit-assertion-llm.mjs `
  --output .\data-processing\data\analysis\visit_assertion_llm_v1 `
  --concurrency 500 `
  --execute `
  --confirm VISIT_ASSERTION

node .\data-processing\scripts\build-visits.mjs
node .\data-processing\scripts\validate-visits.mjs
node .\data-processing\scripts\cluster-trip-candidates.mjs
node .\data-processing\scripts\build-trips.mjs

node .\data-processing\scripts\run-trip-narrative-llm.mjs `
  --output .\data-processing\data\analysis\trip_narratives_llm_v2 `
  --concurrency 100 `
  --execute `
  --confirm TRIP_NARRATIVES

node .\data-processing\scripts\build-trip-narratives.mjs
node .\data-processing\scripts\validate-trips.mjs
```

主要交付：

```text
data-processing/data/places_v1.jsonl
data-processing/data/regions_v1.jsonl
data-processing/data/visits_v1.jsonl
data-processing/data/visits_with_trips_v1.jsonl
data-processing/data/journey_post_roles_v1.jsonl
data-processing/data/trips_v1.jsonl
data-processing/data/trip_membership_candidates_v1.jsonl
data-processing/data/trip_context_refs_v1.jsonl
data-processing/data/trip_narratives_v2.jsonl
data-processing/data/trips_with_narratives_v2.jsonl
```

参数扫描位于：

```text
data-processing/data/analysis/trip_parameter_sweep_v1/
```

当前 v1 使用 `balanced` 组生成候选：

```text
near_km=100
near_days=5
travel_km=2500
travel_days=2
min_samples=2
```

跨城连接额外要求两个 Visit 均有正文、签到或餐厅实体支持。随后在北京常住地与外地之间的大距离跳转处切断，避免把出发前后的北京日常用餐串入外地旅程。该切断规则是产品规则，不是 DBSCAN 参数本身。

LLM 到访判定不能突破以下程序约束：

- `temporal_neighbor`、`ip_region_centroid` 和 `global_default` 永远不能成为路线 Visit；
- 多分店候选保留为 `candidate_location`；
- 城市中心点只能成为 `region_only`；
- LLM Trip 叙事读取已经冻结的成员，不能改变 `visit_ids[]` 或路线顺序。

叙事 v2 使用确定性年月后缀消除重复标题，`base_title` 保留模型原始标题。Trip 类型除行政区字段外，还会在相邻路线点超过 300 km 时标记为 `travel_route`，以覆盖缺少城市字段的 `source_geo`。
