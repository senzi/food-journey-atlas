# 地图数据来源

- `ne_50m_rivers_lake_centerlines.json` 来自 Natural Earth 的 1:50m
  Rivers and Lake Centerlines 数据，经
  `martynafford/natural-earth-geojson` 转换为 GeoJSON。
- Natural Earth 数据为 public domain；转换仓库采用 CC0-1.0。
- 行政区划由构建脚本从 `cn-atlas` npm 包读取，不在此目录重复保存。
- `municipalities/` 中的直辖市区级轮廓来自
  `zhChuXiao/ChinaGeoJson`，原始数据源为 DataV.GeoAtlas，仓库采用 MIT
  License。这里只保留北京、上海、天津、重庆四个直辖市文件，用于补足区级轮廓。
- `journey_destination_boundaries.json` 由
  `npm run basemap:update-destinations` 从 Natural Earth 1:50m 数据生成，只保留
  当前海外旅程点实际落入的国家与州/省级轮廓，不包含完整全球数据。

这些数据只用于生成低密度的叙事地图底图，不用于导航或精确边界判定。
