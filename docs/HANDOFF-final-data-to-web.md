# 最终数据审查与网页开发交接报告

更新时间：2026-07-24
数据审查版本：`final_data_audit_v1`

> 2026-07-24 媒体补丁：`stage1_missing_13_merge_v1` 已修复 13 个未结构化的阶段一结果。  
> 补丁后阶段二成功 7,573、`not_requested` 4,911，阶段一缺失为 0。  
> Entity、Place、Visit、Trip 均未改变。补丁审计见
> `data-processing/data/analysis/stage1_missing_13_merge_v1/`。  
> 补丁后 Post SHA-256：
> `3edd711c0c106cbd5aa7785addc338f3b04266c8d9a6ffdf899b854641ee50da`。

## 1. 交接结论

当前数据已经适合进入网页构建阶段。

最终自动审查结果为 **passed_with_warnings**：

- 20/20 项完整性检查通过
- 0 个阻断错误
- 7 项已知风险或发布注意事项
- 3,236 条 Post 均保留在最终数据中
- 107 个 Trip 均有完整叙事，最终标题全部唯一

这里的“适合构建网页”不等于“可以把内部 JSONL 原样放入 public 目录”。网页应从内部数据生成按页面用途拆分的公开投影，避免公开原图地址、模型响应、处理元数据与密钥。

机器可读审查结果：

- `data-processing/data/analysis/final_data_audit_v1/summary.json`
- `data-processing/data/analysis/final_data_audit_v1/RUN_REPORT.md`

## 2. 数据模型

```text
Post
 ├─ mentions[] ──> Entity
 ├─ poi_resolution
 └─ journey role
       │
       └─> Visit ──> Place / Region
                    │
                    ├─ main membership ──> Trip
                    ├─ candidate membership
                    └─ context / revisit reference
```

职责边界：

- **Post** 是微博、图片分析、POI 解析和 mentions 的完整内容载体。
- **Entity** 是餐厅、菜名、菜系、地区等可检索与高亮的规范实体。
- **Place / Region** 是地图坐标与地点展示层。
- **Visit** 表示一次可地图化的到访判断；时间通常是微博发布时间代理。
- **Trip** 只收录达到保守门槛的主路线，不代表全部微博。
- **candidate/context** 保存不适合画入主线、但仍值得展示的附近点、互斥候选和二次到访关系。

所有关联应使用 ID，不要使用标题或名称做主键。Trip 标题经过唯一化处理，但仍不应作为 URL 的稳定标识。

## 3. 封版数据清单

以下路径均相对于项目根目录。

| 数据 | 文件 | 用途 |
|---|---|---|
| 最终 Post | `data-processing/data/vlm_results_v2_with_poi_mentions_v1.jsonl` | 搜索、原文、图片分析、POI、mentions 的总入口 |
| Entity | `data-processing/data/entities_v1.jsonl` | 关键词高亮、筛选、搜索索引 |
| Place | `data-processing/data/places_v1.jsonl` | POI 地图点 |
| Region | `data-processing/data/regions_v1.jsonl` | 区域级保底地点 |
| Visit + Trip 引用 | `data-processing/data/visits_with_trips_v1.jsonl` | 地图点、主路线归属 |
| Post 旅程角色 | `data-processing/data/journey_post_roles_v1.jsonl` | 判断搜索、上下文、锚点和区域点 |
| 最终 Trip | `data-processing/data/trips_with_narratives_v2.jsonl` | Trip 页面、线路和文案 |
| Trip 候选附着 | `data-processing/data/trip_membership_candidates_v1.jsonl` | 半透明候选点 |
| Trip 上下文关系 | `data-processing/data/trip_context_refs_v1.jsonl` | 同地重访、邻近上下文、其他 Trip 提示 |
| 独立叙事 | `data-processing/data/trip_narratives_v2.jsonl` | 需要独立加载叙事时使用 |

原始、修复中间件、API 缓存和 LLM 原始响应均保存在
`data-processing/data/` 中，但不应被网页运行时代码直接依赖。

## 4. 最终规模与覆盖

| 对象 | 数量 |
|---|---:|
| Post | 3,236 |
| 含 mentions 的 Post | 1,875 |
| mention | 6,732 |
| Entity | 4,125 |
| Place | 881 |
| Region | 55 |
| Visit | 781 |
| 关联 Visit 的 Post | 772 |
| Trip | 107 |
| 主路线 Visit | 285 |
| 主 Trip 中的 Post | 281 |
| 候选 Trip 归属 | 28 |
| 上下文关系 | 70 |
| Trip 叙事 | 107 |

mention 类型：

- 地区 2,632
- 餐厅 868
- 菜名 2,955
- 菜系 277

Trip 类型：

- 本地连续记录 `local_sequence`：53
- 目的地停留 `destination_stay`：49
- 跨城路线 `travel_route`：5

只有 281 条 Post 进入主 Trip 是刻意采用保守门槛的结果，不是数据丢失。搜索、时间线和实体浏览必须使用全部 3,236 条 Post；Trip 只是高置信度策展视图。

## 5. 网页端建议的数据拆分

不要让浏览器一次加载内部总 JSONL。建议在前端工程中增加一次公开数据构建，至少生成：

```text
public-data/
  manifest.json
  posts.index.json
  posts/{post_id}.json
  entities.index.json
  places.json
  regions.json
  visits.json
  trips.index.json
  trips/{trip_id}.json
  search-index.json
```

具体是否继续按年份、地区或哈希前缀切片，可在选定前端框架后按包体大小决定。公开构建器应拥有明确字段白名单，不要依赖删除黑名单。

公开 Post 至少应移除：

- 原始 `pics` URL 和其他不可公开的远端图片地址
- `_processing` 等流水线内部字段
- 模型原始输入、响应、token 用量和错误堆栈
- API 请求、缓存路径、签名、Key 和 `.env` 内容
- 仅用于审计的中间候选全文

若网页要展示图片，应先建立独立的图片授权、下载、压缩、去重和 CDN/本地静态资源流程，再把公开资源 ID 写入投影。

## 6. 地图和 Trip 的展示规则

建议按语义区分点：

- 主路线 `anchor`：实心点，可参与顺序连线。
- `candidate`：半透明点，不进入主路线；点击后解释“地点存在多个候选”。
- `region_only`：区域级保底点，使用不同图标或较低透明度。
- `context/revisit`：半透明上下文点；可链接到另一 Trip 或另一时间段。
- 搜索结果中的普通 POI：可以显示，但不要自动并入某个 Trip。

线路只表达发帖时间顺序，不是步行、驾车或铁路导航路线。当前有两条大于 500 km 的相邻边，均为真实跨城时序：

- `trip_4011815b0f9053a2948b`：杭州至顺德，约 1,070.48 km
- `trip_be6f26aa342dc271e042`：长沙至顺德，约 596.55 km

地图代码、坐标、点和边都应由结构化数据确定性生成，不需要在浏览器运行时调用 LLM。

## 7. 搜索、原文高亮和动态旅程

原文无需再次提交 LLM。`mentions[]` 已提供原文切片位置、实体类型和实体 ID，可直接渲染可点击高亮：

- 餐厅：链接 Place、候选列表或实体详情
- 菜名：链接同菜名的全部 Post
- 菜系：作为筛选条件
- 地区：联动地图或地区页面

高亮时以 mention 的字符范围为准，不要在浏览器中重新做模糊字符串替换。

用户搜索后“重新构建旅程”应作为单独的 `JourneyView` 或查询结果模型存在，不要修改封版 Trip。它可以组合：

- 全部 Post
- Entity 匹配
- Place/Region
- Visit 主点
- Trip membership
- candidate/context/revisit

这样既能保留人工策展般的 107 个高质量 Trip，也能让全部吃喝微博参与搜索和临时路线。

## 8. 置信度与文案要求

前端应保留并表达数据不确定性：

- 781 个 Visit 的时间都以微博发布时间作为代理，不应写成精确到店时间。
- 199 个主路线锚点来自未逐点人工核对的 `source_geo`。
- 115 个 Visit 保留互斥地点候选，不能画进主路线。
- 餐厅 mention 中 606 个未匹配、80 个有多个候选。
- 地区保底点只代表区域，不代表具体餐厅。

用户界面宜使用“发布于”“记录时间约为”“可能地点”“区域位置”等表达，不要把推断包装成精确事实。

## 9. 叙事生成说明

Trip 成员关系在生成叙事前已经冻结，LLM 只负责标题、副标题、摘要和亮点，不参与改变路线成员。

叙事 v2 的确定性后处理包括：

- 重复标题追加年月，必要时追加 Trip ID 后缀
- 最终 107 个标题全部唯一
- 2 条响应中越出允许集合的 8 个主题 Entity ID 被白名单过滤
- 原始响应单独缓存，便于追溯

网页以 `trips_with_narratives_v2.jsonl` 中的结果为准，不要直接读取 LLM 原始响应。

## 10. 已知风险

1. 内部 Post 中仍有 12,484 个原始图片 URL，禁止直接公开。
2. Visit 时间是微博发布时间代理。
3. `source_geo` 路线点尚未全部人工核验。
4. 互斥地点候选不能进入主线路。
5. 餐厅 mention 仍有未匹配和多候选。
6. 长距离边只是顺序连线，不是导航路线。
7. 主 Trip 覆盖率低是保守门槛的预期结果；搜索必须覆盖全部 Post。

## 11. 数据指纹

| 数据 | SHA-256 |
|---|---|
| repaired source | `8d867d412726a266dc0290667735f5d1aae13fbc149a67f8a289c7f5d93bc2b2` |
| POI v5 | `d3d3b70a97b31159496659583227d41aeaa9a785b8b787f9aef6373e2226e1b4` |
| final Posts | `3edd711c0c106cbd5aa7785addc338f3b04266c8d9a6ffdf899b854641ee50da`（媒体补丁后） |
| Entities | `22af88e24be7757564c89693361638e7db9d6ecec018f196f3ff60a5445b2229` |
| Places | `9bafff3960bd20fcca6afadfdd6bbc7bcb87d2c3860a579a9813ae3de1c5eda9` |
| Regions | `903c803f05f94b1e6dedbbbb74c21997814c5f5c97c19a5734e3c2c929a0f017` |
| Visits | `17f6d185e548d879b4d8f654a813949e9131d84f24679bf1bcdc56892dff71da` |
| Journey roles | `5cbed9c6f5958385f56773f5c8f23788e68c62cfe3d39c76e5f8498c30ff6754` |
| Trips + narratives | `8e215fa70573d7bd1bbefbaa2b6f54ae9b8f980cf0e613c8346ef584edcbbe1f` |
| Candidate memberships | `68d5b7dca4cf657542e7a70436b0bd79f1a018eb48685d44a99eb5a1b15e81b7` |
| Context refs | `d52f64bc6dd39166e7f0ea366e26ecee6c71bd7984debda2d1449ad0ca360b8e` |
| Narratives | `d74fc2ebdf8fc4f2936db0fe0980e024c1a300d64bd17a3d4d098e77ba42b650` |

## 12. 建议的网页开发顺序

1. 确定页面模型和公开字段白名单。
2. 编写内部 JSONL 到公开 JSON 的构建器。
3. 完成全量 Post 搜索与 mention 高亮。
4. 完成 Place/Region/Visit 地图点。
5. 完成 Trip 列表、详情、主路线和上下文点。
6. 增加用户搜索后的动态 JourneyView。
7. 单独解决图片资源发布流程。
8. 在部署前运行数据审查、公开数据泄露检查和前端构建测试。

前端可以自由重构和拆分数据，但应保持 ID 关系、来源字段、置信度语义和本报告列出的发布边界。
