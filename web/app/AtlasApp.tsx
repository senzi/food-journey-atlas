"use client";

import { FormEvent, ReactNode, useEffect, useMemo, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

type Atlas = {
  manifest: { version: string; generatedAt: string; coverageStart: string; coverageEnd: string; counts: Record<string, number>; years: number[] };
  trips: any[];
  posts: Record<string, any>;
  places: Record<string, any>;
  regions: Record<string, any>;
  entities: any[];
  facets: any[];
};

const kindLabels: Record<string, string> = {
  local_sequence: "本地连续记录",
  destination_stay: "目的地停留",
  travel_route: "跨城路线",
};
const roleLabels: Record<string, string> = {
  anchor: "主线到访",
  candidate: "可能地点",
  region_only: "区域位置",
  context: "上下文记录",
};

function formatDate(value?: string, withTime = false) {
  if (!value) return "时间不详";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(new Date(value));
}
function dateRange(start?: string, end?: string) {
  if (!start) return "时间不详";
  return !end || start.slice(0, 10) === end.slice(0, 10) ? formatDate(start) : `${formatDate(start)} — ${formatDate(end)}`;
}
function Arrow() { return <span aria-hidden="true">↗</span>; }
function Confidence({ value = "中等" }: { value?: string }) {
  const tone = value === "较高" ? "high" : value === "较低" ? "low" : "medium";
  return <span className={`confidence ${tone}`}>{value}可信</span>;
}
function Notice() {
  return <aside className="data-notice"><span className="notice-mark">AI</span><p>本站内容由 AI 辅助整理与筛选，可能存在错误。到访日期通常以微博发布时间代替；地点、食物与旅程聚类均保留来源和可信状态。</p><a href="/about-data">了解数据方法 <Arrow /></a></aside>;
}
function Header() {
  const pathname = usePathname();
  const links = [["/", "首页"], ["/trips", "全部旅程"], ["/recreate", "复刻旅程"], ["/about-data", "关于数据"]];
  return <header className="site-header"><a className="brand" href="/" aria-label="陈晓卿美食足迹地图首页"><span className="brand-seal">食迹</span><span>陈晓卿美食足迹地图</span></a><nav aria-label="主导航">{links.map(([href, label]) => <a key={href} className={pathname === href ? "active" : ""} href={href}>{label}</a>)}</nav><a className="nav-cta" href="/trips">开始探索 <span>→</span></a></header>;
}
function Footer({ atlas }: { atlas: Atlas }) {
  return <footer><div><span className="brand-seal">食迹</span><p>从公开记录出发，沿时间与地点重新阅读一位美食记录者的行旅。</p></div><div className="footer-links"><a href="/trips">全部旅程</a><a href="/recreate">复刻旅程</a><a href="/about-data">数据说明</a></div><small>数据版本 {atlas.manifest.version} · {atlas.manifest.generatedAt}</small></footer>;
}
function TripCard({ trip, index }: { trip: any; index: number }) {
  return <a className="trip-card" href={`/trips/${trip.id}`}><div className={`trip-art art-${index % 4}`} aria-hidden="true"><span>{String(index + 1).padStart(2, "0")}</span><div className="route-motif"><i /><i /><i /></div><b>{trip.regions.slice(0, 2).join(" · ")}</b></div><div className="trip-card-body"><div className="eyebrow-row"><span>{kindLabels[trip.kind] || trip.kind}</span><Confidence value={trip.confidenceLabel} /></div><h3>{trip.title}</h3><p>{trip.subtitle || trip.summary}</p><div className="card-meta"><span>{dateRange(trip.startDate, trip.endDate)}</span><span>{trip.visitCount} 次到访</span><span>{trip.postCount} 条记录</span></div></div></a>;
}
function Home({ atlas }: { atlas: Atlas }) {
  const featured = [...atlas.trips].sort((a, b) => b.visitCount + b.postCount - a.visitCount - a.postCount).slice(0, 4);
  const counts = atlas.manifest.counts;
  const yearGroups = atlas.manifest.years.reduce<number[][]>((groups, year) => {
    const last = groups.at(-1);
    if (!last || year - last.at(-1)! > 2) groups.push([year]); else last.push(year);
    return groups;
  }, []);
  return <main>
    <section className="hero"><div className="hero-copy"><p className="kicker">陈晓卿 · 美食地图 · 足迹 · 跟随</p><h1>沿着味道，<br />重走一段段真实旅程。</h1><p className="hero-lead">一个基于公开微博记录构建的个人美食旅行知识库。从时间、地点与原始记录出发，发现食物背后的行旅脉络。</p><div className="hero-actions"><a className="button primary" href="/trips">浏览全部旅程 <span>→</span></a><a className="button text" href="/recreate">按条件复刻一段旅程 <Arrow /></a></div></div><div className="hero-poster" aria-label="数据覆盖摘要"><div className="poster-orbit orbit-one" /><div className="poster-orbit orbit-two" /><div className="poster-core"><small>记录覆盖</small><strong>{new Date(atlas.manifest.coverageStart).getFullYear()}</strong><span>—</span><strong>{new Date(atlas.manifest.coverageEnd).getFullYear()}</strong></div><span className="poster-label label-north">北京</span><span className="poster-label label-east">江南</span><span className="poster-label label-south">岭南</span><span className="poster-label label-west">西南</span></div></section>
    <section className="stats" aria-label="核心数据">{[["原始记录", counts.posts], ["系统旅程", counts.trips], ["到访事件", counts.visits], ["具体地点", counts.places], ["覆盖城市", counts.cities]].map(([label, value]) => <div key={label}><strong>{Number(value).toLocaleString("zh-CN")}</strong><span>{label}</span></div>)}</section>
    <section className="section-block"><div className="section-heading"><div><p className="kicker">Selected journeys</p><h2>重点旅程</h2></div><p>107 段由系统从连续记录中整理出的旅程。它们是保守策展视图，不代表全部微博。</p></div><div className="featured-grid">{featured.map((trip, index) => <TripCard key={trip.id} trip={trip} index={index} />)}</div><a className="center-link" href="/trips">查看全部 {counts.trips} 段旅程 <span>→</span></a></section>
    <section className="timeline-section"><div className="section-heading"><div><p className="kicker">Across the years</p><h2>从时间进入</h2></div><p>选择一段年份，查看当时留下的旅程记录。</p></div><div className="year-ranges">{yearGroups.map((group) => { const from = group[0], to = group.at(-1)!; return <a key={from} href={`/trips?from=${from}&to=${to}`}><small>{from === to ? "单年记录" : `${group.length} 年跨度`}</small><strong>{from}{from !== to && <>—{to}</>}</strong><span>查看旅程 →</span></a>; })}</div></section><Notice />
  </main>;
}

function Trips({ atlas }: { atlas: Atlas }) {
  const searchParams = useSearchParams();
  const [query, setQuery] = useState(searchParams.get("q") || "");
  const [from, setFrom] = useState(searchParams.get("from") || "");
  const [to, setTo] = useState(searchParams.get("to") || "");
  const [region, setRegion] = useState("");
  const [kind, setKind] = useState("");
  const [sort, setSort] = useState("desc");
  const regions = useMemo(() => { const counts = new Map<string, number>(); atlas.trips.flatMap((trip) => trip.regions).forEach((name) => counts.set(name, (counts.get(name) || 0) + 1)); return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20); }, [atlas]);
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return atlas.trips.filter((trip) => { const year = new Date(trip.startDate).getFullYear(); const haystack = [trip.title, trip.subtitle, trip.summary, ...trip.regions, ...trip.themeFoods.map((x: any) => x.name)].join(" ").toLowerCase(); return (!q || haystack.includes(q)) && (!from || year >= Number(from)) && (!to || year <= Number(to)) && (!region || trip.regions.includes(region)) && (!kind || trip.kind === kind); }).sort((a, b) => (sort === "desc" ? 1 : -1) * (new Date(b.startDate).getTime() - new Date(a.startDate).getTime()));
  }, [atlas, query, from, to, region, kind, sort]);
  return <main><section className="page-intro"><p className="kicker">Journey archive</p><h1>全部旅程</h1><p>按时间、地区与主题浏览系统整理的封版旅程。每个节点都能回到公开原始记录。</p></section><section className="archive-layout"><aside className="filters"><div className="filter-title"><strong>筛选条件</strong><button onClick={() => { setQuery(""); setFrom(""); setTo(""); setRegion(""); setKind(""); }}>清除</button></div><label>关键词<input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="菜名、城市、旅程…" /></label><div className="double-field"><label>起始年份<select value={from} onChange={(e) => setFrom(e.target.value)}><option value="">不限</option>{atlas.manifest.years.map((y) => <option key={y}>{y}</option>)}</select></label><label>结束年份<select value={to} onChange={(e) => setTo(e.target.value)}><option value="">不限</option>{atlas.manifest.years.map((y) => <option key={y}>{y}</option>)}</select></label></div><label>旅程类型<select value={kind} onChange={(e) => setKind(e.target.value)}><option value="">全部类型</option>{Object.entries(kindLabels).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select></label><fieldset><legend>常见地区</legend>{regions.map(([name, count]) => <button className={region === name ? "selected" : ""} key={name} onClick={() => setRegion(region === name ? "" : name)}><span>{name}</span><small>{count}</small></button>)}</fieldset></aside><div className="archive-results"><div className="results-top"><p>找到 <strong>{results.length}</strong> 段旅程</p><label>排序<select value={sort} onChange={(e) => setSort(e.target.value)}><option value="desc">时间从近到远</option><option value="asc">时间从远到近</option></select></label></div>{results.length ? <div className="trip-list">{results.map((trip, index) => <TripCard key={trip.id} trip={trip} index={index} />)}</div> : <div className="empty"><strong>没有匹配的旅程</strong><p>试试放宽年份或移除地区条件。</p></div>}</div></section></main>;
}

function Graph({ trip, selected, onSelect, mainOnly }: { trip: any; selected: string; onSelect: (id: string) => void; mainOnly: boolean }) {
  const points = trip.visits.filter((v: any) => !mainOnly || v.role === "anchor").filter((v: any) => Number.isFinite(v.longitude) && Number.isFinite(v.latitude));
  if (!points.length) return <div className="empty">这些记录暂时没有可绘制坐标。</div>;
  const lngs = points.map((p: any) => p.longitude), lats = points.map((p: any) => p.latitude);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs), minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const position = (p: any) => ({ x: 10 + ((p.longitude - minLng) / (maxLng - minLng || 1)) * 78, y: 84 - ((p.latitude - minLat) / (maxLat - minLat || 1)) * 68 });
  const anchors = points.filter((p: any) => p.role === "anchor");
  return <div className="geo-graph" aria-label={`${trip.title}地理关系图`}><div className="map-grid" /><div className="map-land land-a" /><div className="map-land land-b" /><svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">{anchors.slice(0, -1).map((point: any, index: number) => { const a = position(point), b = position(anchors[index + 1]); const distance = Math.hypot(a.x - b.x, a.y - b.y); return <line key={point.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={distance > 55 ? "long-edge" : ""} />; })}</svg>{points.map((point: any) => { const pos = position(point); return <button key={point.id} className={`map-node ${point.role} ${selected === point.id ? "selected" : ""}`} style={{ left: `${pos.x}%`, top: `${pos.y}%` }} onClick={() => onSelect(point.id)} aria-label={`${roleLabels[point.role]}：${point.name}`}><i>{point.role === "anchor" ? anchors.indexOf(point) + 1 : "·"}</i><span>{point.name}</span></button>; })}<div className="map-legend"><span><i className="anchor" />主线</span><span><i className="candidate" />可能</span><span><i className="region_only" />区域</span></div>{anchors.length > 1 && <small className="map-caption">连线表达记录时序，不是导航路线</small>}</div>;
}

function RichPost({ post }: { post: any }) {
  if (!post) return <p className="muted">未找到关联原始记录。</p>;
  const segments: ReactNode[] = []; let cursor = 0;
  for (const mention of [...post.mentions].sort((a, b) => a.start - b.start)) { if (mention.start < cursor) continue; segments.push(post.content.slice(cursor, mention.start)); segments.push(<mark key={mention.id} title={`${mention.type} · ${Math.round(mention.confidence * 100)}%`}>{post.content.slice(mention.start, mention.end)}</mark>); cursor = mention.end; }
  segments.push(post.content.slice(cursor));
  return <article className="post-content"><div className="source-label"><span>原始微博正文</span><time>{formatDate(post.createdAt, true)} 发布</time></div><p className="weibo-text">{segments}</p><a className="raw-link" href={post.url} target="_blank" rel="noreferrer">查看 RAW 原微博 <Arrow /></a>{post.analysis.length ? <div className="analysis-block"><div className="source-label"><span>图片分析</span><small>不展示原图</small></div>{post.analysis.map((item: any) => <p key={item.index}>{item.description} <small>{Math.round(item.confidence * 100)}% 可信</small></p>)}<div className="tag-cloud">{post.labels.slice(0, 12).map((label: any, index: number) => <span key={`${label.type}-${label.name}-${index}`} className={label.confidence < .7 ? "tentative" : ""}>{label.confidence < .7 && "可能 · "}{label.name}<small>{label.type}</small></span>)}</div></div> : <div className="no-media">这条记录没有配图分析，原文仍保留在档案中。</div>}</article>;
}

function TripDetail({ atlas, trip }: { atlas: Atlas; trip: any }) {
  const anchors = trip.visits.filter((v: any) => v.role === "anchor");
  const [selectedId, setSelectedId] = useState(anchors[0]?.id || trip.visits[0]?.id);
  const [postIndex, setPostIndex] = useState(0);
  const [mainOnly, setMainOnly] = useState(false);
  const selected = trip.visits.find((v: any) => v.id === selectedId) || anchors[0];
  const posts = (selected?.postIds || []).map((id: string) => atlas.posts[id]).filter(Boolean);
  useEffect(() => setPostIndex(0), [selectedId]);
  return <main><div className="breadcrumb"><a href="/trips">全部旅程</a><span>/</span><span>{trip.title}</span></div><section className="trip-hero"><div><div className="eyebrow-row"><span>{kindLabels[trip.kind]}</span><Confidence value={trip.confidenceLabel} /></div><h1>{trip.title}</h1><p className="trip-subtitle">{trip.subtitle}</p><p>{trip.summary}</p><div className="trip-facts"><span>{dateRange(trip.startDate, trip.endDate)}</span><span>{trip.regions.join(" · ")}</span><span>{trip.visitCount} 次到访</span><span>{trip.postCount} 条原始记录</span></div></div><aside><small>旅程如何产生</small><p>系统按时间和空间关系聚类；成员关系已冻结，叙事只负责标题与摘要。</p><code>{trip.clusterMethod}</code></aside></section><section className="trip-workspace"><div className="journey-panel"><div className="panel-title"><div><p className="kicker">Geo-Graph</p><h2>旅程地理关系</h2></div><label className="switch"><input type="checkbox" checked={mainOnly} onChange={(e) => setMainOnly(e.target.checked)} /><span />只看主线</label></div><Graph trip={trip} selected={selectedId} onSelect={setSelectedId} mainOnly={mainOnly} /><div className="route-list">{trip.visits.filter((v: any) => !mainOnly || v.role === "anchor").map((visit: any) => <button key={visit.id} className={selectedId === visit.id ? "selected" : ""} onClick={() => setSelectedId(visit.id)}><i>{visit.role === "anchor" ? anchors.indexOf(visit) + 1 : "·"}</i><span><strong>{visit.name}</strong><small>{formatDate(visit.date)} · {roleLabels[visit.role]}</small></span>{visit.confidenceLabel && <Confidence value={visit.confidenceLabel} />}</button>)}</div></div><div className="node-panel">{selected ? <><div className="node-heading"><p className="kicker">Selected node</p><h2>{selected.name}</h2><div className="node-meta"><span>{formatDate(selected.date)}</span><span>{roleLabels[selected.role]}</span>{selected.confidenceLabel && <Confidence value={selected.confidenceLabel} />}</div></div>{selected.food?.length > 0 && <div className="food-strip">{selected.food.map((food: any) => <span key={food.id}>{food.name}<small>{food.type}</small></span>)}</div>}{posts.length > 1 && <div className="post-tabs">{posts.map((post: any, index: number) => <button key={post.id} className={postIndex === index ? "active" : ""} onClick={() => setPostIndex(index)}>记录 {index + 1}</button>)}</div>}<RichPost post={posts[postIndex]} /><p className="proxy-note">日期为微博发布时间代理，不等同于精确到店时间。</p></> : <div className="empty">请选择一个旅程节点。</div>}</div></section></main>;
}

function Recreate({ atlas }: { atlas: Atlas }) {
  const [region, setRegion] = useState(""), [year, setYear] = useState(""), [count, setCount] = useState("3"), [keyword, setKeyword] = useState(""), [includePossible, setIncludePossible] = useState(false), [result, setResult] = useState<any[] | null>(null);
  const regions = useMemo(() => [...new Set<string>(atlas.trips.flatMap((t) => t.regions))].sort().slice(0, 80), [atlas]);
  function submit(event: FormEvent) {
    event.preventDefault(); const q = keyword.trim().toLowerCase();
    const matches = atlas.trips.flatMap((t) => t.visits.map((v: any) => ({ ...v, tripRegions: t.regions }))).filter((v, i, all) => all.findIndex((x) => x.id === v.id) === i).filter((v) => includePossible || v.role === "anchor").filter((v) => !region || v.name.includes(region) || v.tripRegions.includes(region)).filter((v) => !year || String(new Date(v.date).getFullYear()) === year).filter((v) => !q || [v.name, ...(v.food || []).map((x: any) => x.name)].join(" ").toLowerCase().includes(q)).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()).slice(0, Math.max(2, Number(count)));
    setResult(matches);
  }
  return <main><section className="page-intro recreate-intro"><p className="kicker">Build a JourneyView</p><h1>复刻一段美食旅程</h1><p>从已收录的真实足迹中，按条件组合一条临时浏览路线。结果不是实时旅行建议，也不会改变封版旅程。</p></section><section className="recreate-layout"><form onSubmit={submit} className="recreate-form"><div className="form-section"><span>01</span><div><h2>去哪里</h2><p>选择一个已有记录覆盖的地区</p></div></div><label>地区<select value={region} onChange={(e) => setRegion(e.target.value)}><option value="">不限地区</option>{regions.map((name) => <option key={name}>{name}</option>)}</select></label><div className="form-section"><span>02</span><div><h2>什么时候</h2><p>按记录年份缩小范围</p></div></div><div className="double-field"><label>年份<select value={year} onChange={(e) => setYear(e.target.value)}><option value="">不限年份</option>{atlas.manifest.years.map((v) => <option key={v}>{v}</option>)}</select></label><label>节点数量<select value={count} onChange={(e) => setCount(e.target.value)}><option value="2">2 个</option><option value="3">3 个</option><option value="5">5 个</option><option value="7">7 个</option></select></label></div><div className="form-section"><span>03</span><div><h2>想吃什么</h2><p>菜品、食材、菜系或烹饪方式</p></div></div><label>关键词<input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="例如：牛肉、粤菜、炖" /></label><label className="check-row"><input type="checkbox" checked={includePossible} onChange={(e) => setIncludePossible(e.target.checked)} /><span><strong>包含所有可能数据</strong><small>纳入候选地点、区域点与其他较低可信记录</small></span></label><button className="button primary full" type="submit">生成临时 JourneyView <span>→</span></button></form><div className="recreate-result">{!result ? <div className="result-placeholder"><span>路线将在这里出现</span><div className="ghost-route"><i /><i /><i /></div><p>选择条件后，系统只会组合已有来源的到访记录。</p></div> : result.length ? <><div className="panel-title"><div><p className="kicker">Generated view</p><h2>{region || "不限地区"} · {keyword || "综合寻味"}</h2></div><span className="temporary">临时视图</span></div><Graph trip={{ title: "临时旅程", visits: result }} selected={result[0].id} onSelect={() => {}} mainOnly={false} /><div className="generated-list">{result.map((visit, index) => <div key={visit.id}><i>{index + 1}</i><span><strong>{visit.name}</strong><small>{formatDate(visit.date)} · {visit.food?.slice(0, 2).map((x: any) => x.name).join("、") || "原始记录"}</small></span></div>)}</div><p className="proxy-note">基于历史足迹生成，不是导航或实时营业建议。</p></> : <div className="empty"><strong>没有足够的可组合记录</strong><p>请移除部分条件或开启“包含所有可能数据”。</p></div>}</div></section></main>;
}

function PostPage({ post }: { post: any }) { return <main className="narrow"><div className="breadcrumb"><a href="/trips">旅程档案</a><span>/</span><span>原始记录</span></div><section className="detail-title"><p className="kicker">Source record</p><h1>一条可追溯的公开记录</h1><p>完整正文与离线图片分析被分开呈现；原图不在本站展示或分发。</p></section><RichPost post={post} /></main>; }
function PlacePage({ atlas, place }: { atlas: Atlas; place: any }) {
  const posts = place.postIds.map((id: string) => atlas.posts[id]).filter(Boolean), trips = atlas.trips.filter((t) => t.visits.some((v: any) => v.placeId === place.id));
  return <main className="narrow"><div className="breadcrumb"><a href="/trips">旅程档案</a><span>/</span><span>地点</span></div><section className="detail-title"><p className="kicker">Place archive</p><h1>{place.name}</h1><p>{[place.city, place.district, place.address].filter(Boolean).join(" · ")}</p><div className="tag-cloud"><span>{place.type || "具体地点"}<small>地点类型</small></span><span>{place.coordinates.longitude.toFixed(4)}, {place.coordinates.latitude.toFixed(4)}<small>结构化坐标</small></span></div></section><section className="related"><h2>相关旅程</h2>{trips.length ? trips.map((trip, i) => <TripCard key={trip.id} trip={trip} index={i} />) : <p>此地点暂未进入封版主旅程，但仍保留在完整搜索中。</p>}<h2>来源记录</h2>{posts.slice(0, 4).map((post: any) => <RichPost key={post.id} post={post} />)}</section></main>;
}
function RegionPage({ atlas, region }: { atlas: Atlas; region: any }) {
  const posts = region.postIds.map((id: string) => atlas.posts[id]).filter(Boolean);
  return <main className="narrow"><div className="breadcrumb"><a href="/trips">旅程档案</a><span>/</span><span>地区</span></div><section className="detail-title"><p className="kicker">Region archive</p><h1>{region.name}</h1><p>这是区域级位置，只说明记录与该地区有关，不伪装成具体餐厅或精确到访点。</p><Confidence value="中等" /></section><section className="related"><h2>区域来源记录</h2>{posts.slice(0, 6).map((post: any) => <RichPost key={post.id} post={post} />)}</section></main>;
}
function About({ atlas }: { atlas: Atlas }) {
  const rows = [["原始正文", "来自公开微博，可打开 RAW 链接核对。"], ["图片分析", "由视觉模型离线生成，不代表原图本身。"], ["记录时间", "通常采用微博发布时间代理，不等同精确到店时间。"], ["较高 / 中等 / 较低可信", "表达结构化结果的证据强弱，不是权威结论。"], ["时序连线", "表达记录先后，不是步行、驾车或铁路导航。"]];
  return <main className="narrow"><section className="page-intro"><p className="kicker">About the data</p><h1>每一个点，都应该能回到来源。</h1><p>本站不是餐厅推荐榜，也不判断今天是否营业。它整理公开记录中的时间、地点、食物与上下文，并保留推断的不确定性。</p></section><section className="method-grid">{[["01", "公开记录", "只收录公开原创微博。正文可在站内阅读，并提供新页打开的 RAW 原微博链接；原图不公开分发。"], ["02", "结构化整理", "图片只作为离线分析输入。页面展示图片分析描述、候选菜品、食材与场景，不以生成图片替代原图。"], ["03", "到访判断", "地点与到访由文本、定位与 POI 匹配共同支持。只知道城市时展示区域点，多候选时明确写作“可能地点”。"], ["04", "旅程聚类", "系统依照时间和空间关系组合 107 段旅程。成员关系已冻结，叙事模型不改变路线节点。"]].map(([n, title, text]) => <article key={n}><span>{n}</span><h2>{title}</h2><p>{text}</p></article>)}</section><section className="provenance"><h2>字段如何阅读</h2>{rows.map(([term, text]) => <div key={term}><strong>{term}</strong><p>{text}</p></div>)}</section><section className="version-card"><div><p className="kicker">Current release</p><h2>{atlas.manifest.version}</h2></div><p>数据生成日期 {atlas.manifest.generatedAt}<br />一次性全量整理，发布后暂无增量更新计划。</p></section><Notice /></main>;
}
function Loading() { return <main className="loading"><span className="brand-seal">食迹</span><p>正在展开旅程档案…</p></main>; }

export default function AtlasApp() {
  const pathname = usePathname(), [atlas, setAtlas] = useState<Atlas | null>(null), [error, setError] = useState(false);
  useEffect(() => { fetch("/data/atlas.json").then((r) => { if (!r.ok) throw new Error(); return r.json(); }).then(setAtlas).catch(() => setError(true)); }, []);
  if (error) return <main className="loading"><strong>数据暂时无法读取</strong><p>请稍后刷新页面。</p></main>;
  if (!atlas) return <Loading />;
  const parts = pathname.split("/").filter(Boolean); let page: ReactNode;
  if (pathname === "/") page = <Home atlas={atlas} />; else if (pathname === "/trips") page = <Trips atlas={atlas} />; else if (parts[0] === "trips" && parts[1]) { const trip = atlas.trips.find((x) => x.id === parts[1]); page = trip ? <TripDetail atlas={atlas} trip={trip} /> : <div className="empty page-empty"><strong>没有找到这段旅程</strong><a href="/trips">返回全部旅程</a></div>; } else if (pathname === "/recreate") page = <Recreate atlas={atlas} />; else if (parts[0] === "posts" && parts[1]) page = <PostPage post={atlas.posts[parts[1]]} />; else if (parts[0] === "places" && parts[1] && atlas.places[parts[1]]) page = <PlacePage atlas={atlas} place={atlas.places[parts[1]]} />; else if (parts[0] === "regions" && parts[1] && atlas.regions[parts[1]]) page = <RegionPage atlas={atlas} region={atlas.regions[parts[1]]} />; else if (pathname === "/about-data") page = <About atlas={atlas} />; else page = <div className="empty page-empty"><strong>页面不存在</strong><a href="/">返回首页</a></div>;
  return <><Header />{page}<Footer atlas={atlas} /></>;
}
