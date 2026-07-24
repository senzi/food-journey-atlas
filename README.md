# 沿途寻味：陈晓卿美食足迹地图

一个根据陈晓卿公开微博记录整理的个人美食旅行知识库。它以旅程、时间和地图串联到访地点、食物、微博正文与图片分析，让每一条足迹尽可能回到公开来源和具体上下文。

这不是餐厅排行榜，也不是导航软件。站内路线是对历史公开记录的整理与重新组合，不代表实时营业情况、路线建议或完整行程。

## 目前包含

- 按年份、地区浏览全部旅程
- 可缩放、拖动的轻量地理旅程图
- 旅程节点、微博正文、图片分析和食物信息
- 地区、地点及原始记录详情页
- 按地区、年份、食物和节点数量随机复刻一段旅程
- 使用 DeepSeek 将自然语言转换为可编辑的筛选条件
- 对候选地点、推断结果和不同可信状态进行区分

## 技术栈

- React 19、Next.js 16
- [Vinext](https://github.com/cloudflare/vinext)
- Vite 8
- Cloudflare Workers Runtime
- DeepSeek `deepseek-v4-flash`
- 本地行政区轮廓与河流数据，不依赖在线地图 API

## 本地运行

需要 Node.js `>= 22.13.0`。

```bash
cd web
npm install
npm run dev
```

默认地址为 <http://localhost:3000>。

仓库已经包含面向网站的公共数据投影，因此普通开发不需要原始数据处理目录。维护者如需从本地数据源重新生成公共数据，可以运行：

```bash
cd web
npm run data:build
```

## DeepSeek 配置

自然语言旅程条件通过服务端 `/api/journey-query` 调用 DeepSeek，API Key 不会发送到浏览器。

本地开发时，在 `web/.dev.vars` 中配置：

```dotenv
deepseek_key=your_api_key
```

也支持以下可选变量：

```dotenv
DEEPSEEK_MODEL=deepseek-v4-flash
DEEPSEEK_BASE_URL=https://api.deepseek.com
```

部署到 Cloudflare 时，请将 `deepseek_key` 配置为 Secret，不要把 `.dev.vars` 提交到仓库。

## 常用命令

```bash
cd web
npm run dev          # 启动本地开发服务
npm run build        # 构建 Cloudflare 版本
npm test             # 构建并运行测试
npm run data:build   # 从维护者本地数据重新生成公共数据
```

## 项目结构

```text
.
├─ docs/             # 产品、数据流程与提示词文档
├─ data-processing/  # 数据整理、校验和离线 LLM 脚本
└─ web/              # 网站、地图、Cloudflare Worker 与公共数据
```

## 数据与 AI 说明

- 数据来源于公开微博记录，并经过规则、地理信息服务、VLM 与 LLM 辅助整理。
- 微博发布时间通常作为到访日期的代理，不等于准确到店时间。
- 图片原图不随网站发布，站内只展示离线生成的图片分析文字。
- 地点匹配、菜品标签和旅程聚类可能存在错误；原始记录始终优先于 AI 推断。
- 项目不保证餐厅当前仍在营业，也不构成消费或出行建议。

更完整的产品边界与数据设计见 [docs/PRD.md](docs/PRD.md)。

## License

代码以 [MIT License](LICENSE) 发布。仓库中引用或整理的第三方公开内容、地理数据及其相关权利仍归各自权利人所有，不因代码许可证而改变。
