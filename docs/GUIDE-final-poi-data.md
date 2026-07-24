# 最终 POI 数据使用指南

## 交付文件

最终数据：

`data-processing/data/vlm_results_v2_with_poi_v5.jsonl`

它以 `data-processing/data/vlm_results_v2_repaired_v2.jsonl` 为只读输入。每一行保留原对象的全部字段，并新增一个 `poi_resolution` 字段。原文件没有被修改。

## `poi_resolution` 结构

```json
{
  "version": "poi_resolution_v5",
  "generated_at": "ISO 时间",
  "status": "resolved | fallback",
  "method": "解析方法",
  "confidence": "high | medium | low | display_only",
  "is_display_fallback": false,
  "primary_point_index": 0,
  "point_count": 1,
  "points": [
    {
      "poi_id": "高德 POI ID 或 null",
      "name": "地点名称",
      "longitude": 116.397499,
      "latitude": 39.908722,
      "location": "116.397499,39.908722",
      "address": "地址",
      "province": "省份",
      "city": "城市",
      "district": "区县",
      "type": "高德类型或保底类型",
      "typecode": "高德类型码或 null",
      "selection_method": "该点的选择方法",
      "selection_confidence": "high | medium | low | display_only",
      "coordinate_status": "坐标状态",
      "is_fallback": false
    }
  ]
}
```

## 解析方法

由高到低大致分为：

1. `amap_deterministic`：确定性评分明确选中高德 POI。
2. `amap_with_llm_disambiguation`：DeepSeek 在限定高德候选 ID 中完成消歧。
3. `amap_multiple_candidates`：多个同名或相近分店均保留。
4. `explicit_location_amap`：从正文/图片提取明确地点，再经高德验证。
5. `source_geo`：没有可信高德候选时使用微博原始签到坐标。
6. `explicit_region_geocode`：正文明确出现城市或地区，只能落到区域展示点。
7. `temporal_neighbor`：借用 72 小时内最近一条有点微博的位置。
8. `ip_region_centroid`：使用 IP 属地对应区域中心，仅作展示。
9. `global_default`：无任何地点证据时使用统一未知地点展示点。

`explicit_region_geocode`、`temporal_neighbor`、`ip_region_centroid` 和 `global_default` 不能解释为真实到访 POI。

## 地图展示策略

完整展示：

- 使用每条微博的 `points[primary_point_index]`。
- 需要显示多地点时，遍历全部 `points`。

较高精度展示：

- 使用 `is_display_fallback=false` 的记录；
- 或额外包含 `method=source_geo` 的原始签到点。

调试时建议根据 `method` 使用不同颜色和透明度：

- 高德确认点：实心、高透明度；
- 原始签到点：普通标记；
- 区域和时间保底：半透明；
- `global_default`：不显示或集中放入“未知地点”图层。

## 多候选

同一条微博可以有多个点，这是预期行为。前端可以：

- 默认使用 `primary_point_index`；
- 点击微博时展示所有候选；
- 用同一 `post_id` 连接多个地图点；
- 后续人工确认后只保留选定 POI ID。

## 验证

```powershell
node .\data-processing\scripts\validate-final-poi-dataset.mjs `
  --source .\data-processing\data\vlm_results_v2_repaired_v2.jsonl `
  --final .\data-processing\data\vlm_results_v2_with_poi_v5.jsonl
```

验证器检查：

- 行数一致；
- 原字段逐行完全相同；
- `post_id` 唯一；
- 每条至少一个点；
- 主点索引合法；
- 经纬度范围合法。

v5 在 v2 的基础上增加了更严格的地点过滤：

- 描述性地点名和候选类型不兼容时拒绝替换；
- 候选名称删除了查询中的关键部分时拒绝；
- 无城市地址被解析到与现有时间/IP 上下文相距超过 300 公里时拒绝；
- 无行政区信息且原上下文只能落到全局默认点的地址，不作为已确认地址使用。
