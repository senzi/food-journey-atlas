"use client";

import {
  FormEvent,
  ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePathname, useSearchParams } from "next/navigation";

type Atlas = {
  manifest: {
    version: string;
    generatedAt: string;
    coverageStart: string;
    coverageEnd: string;
    counts: Record<string, number>;
    years: number[];
  };
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
  context: "同行背景",
};

type RegionOption = {
  key: string;
  province: string;
  city: string;
  label: string;
  count: number;
};

function isDomesticCoordinate(longitude?: number, latitude?: number) {
  return (
    Number.isFinite(longitude) &&
    Number.isFinite(latitude) &&
    longitude! >= 73 &&
    longitude! <= 136 &&
    latitude! >= 18 &&
    latitude! <= 54
  );
}

function destinationFromTitle(title = "") {
  return (
    title
      .replace(
        /(?:一日|两日|三日|数日|多日)?(?:寻味|饮食|美食旅程|旅程|记录).*$/,
        "",
      )
      .trim() || "地点待确认"
  );
}

function regionOptionForVisit(atlas: Atlas, trip: any, visit: any) {
  const location = visit.placeId
    ? atlas.places[visit.placeId]
    : visit.regionId
      ? atlas.regions[visit.regionId]
      : null;
  let province = visit.province || location?.province || "";
  let city = visit.city || location?.city || "";
  if (!province && !city) {
    const domestic = isDomesticCoordinate(visit.longitude, visit.latitude);
    province = domestic ? "国内其他地区" : "海外地区";
    city = destinationFromTitle(trip.title);
  } else {
    province = province || city;
    city = city || province;
  }
  return {
    key: `${province}::${city}`,
    province,
    city,
    label: city === province ? province : city,
    count: 0,
  };
}

type Basemap = {
  source: string;
  features: Array<{ name: string; level: string; geometry: any }>;
  rivers: Array<{ name: string; geometry: any }>;
};

let basemapRequest: Promise<Basemap> | null = null;

function loadBasemap() {
  if (!basemapRequest) {
    basemapRequest = fetch("/data/china-basemap.json").then((response) => {
      if (!response.ok) throw new Error("底图数据加载失败");
      return response.json();
    });
  }
  return basemapRequest;
}

function mapCoordinate([longitude, latitude]: number[]) {
  return {
    x: (longitude * Math.PI) / 180,
    y: Math.log(Math.tan(Math.PI / 4 + (latitude * Math.PI) / 360)),
  };
}

function geometryCoordinates(geometry: any) {
  const coordinates: number[][] = [];
  function visit(value: any) {
    if (
      Array.isArray(value) &&
      value.length >= 2 &&
      typeof value[0] === "number" &&
      typeof value[1] === "number"
    ) {
      coordinates.push(value);
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    }
  }
  visit(geometry?.coordinates);
  return coordinates;
}

function geometryContainsCoordinate(
  geometry: any,
  longitude: number,
  latitude: number,
) {
  function inRing(ring: number[][]) {
    let inside = false;
    for (
      let index = 0, previous = ring.length - 1;
      index < ring.length;
      previous = index++
    ) {
      const [x, y] = ring[index];
      const [previousX, previousY] = ring[previous];
      const crosses =
        y > latitude !== previousY > latitude &&
        longitude <
          ((previousX - x) * (latitude - y)) /
            (previousY - y || 1e-12) +
            x;
      if (crosses) inside = !inside;
    }
    return inside;
  }
  const polygons =
    geometry?.type === "Polygon"
      ? [geometry.coordinates]
      : geometry?.type === "MultiPolygon"
        ? geometry.coordinates
        : [];
  return polygons.some(
    (polygon: number[][][]) =>
      polygon[0] &&
      inRing(polygon[0]) &&
      !polygon.slice(1).some((hole: number[][]) => inRing(hole)),
  );
}

function geometryPath(
  geometry: any,
  project: (coordinate: number[]) => { x: number; y: number },
) {
  const line = (coordinates: number[][], close = false) =>
    coordinates
      .map((coordinate, index) => {
        const point = project(coordinate);
        return `${index ? "L" : "M"}${point.x.toFixed(2)},${point.y.toFixed(2)}`;
      })
      .join(" ") + (close ? " Z" : "");
  if (geometry.type === "LineString") return line(geometry.coordinates);
  if (geometry.type === "MultiLineString")
    return geometry.coordinates.map((item: number[][]) => line(item)).join(" ");
  if (geometry.type === "Polygon")
    return geometry.coordinates
      .map((item: number[][]) => line(item, true))
      .join(" ");
  if (geometry.type === "MultiPolygon")
    return geometry.coordinates
      .flatMap((polygon: number[][][]) =>
        polygon.map((item: number[][]) => line(item, true)),
      )
      .join(" ");
  return "";
}

function formatDate(value?: string, withTime = false) {
  if (!value) return "时间不详";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(new Date(value));
}
function dateRange(start?: string, end?: string) {
  if (!start) return "时间不详";
  return !end || start.slice(0, 10) === end.slice(0, 10)
    ? formatDate(start)
    : `${formatDate(start)} — ${formatDate(end)}`;
}

function haversineKm(a: any, b: any) {
  const radius = 6371;
  const radians = (value: number) => (value * Math.PI) / 180;
  const deltaLat = radians(b.latitude - a.latitude);
  const deltaLng = radians(b.longitude - a.longitude);
  const value =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(radians(a.latitude)) *
      Math.cos(radians(b.latitude)) *
      Math.sin(deltaLng / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function orderByShortestRoute<T>(items: T[]) {
  if (items.length < 3) return [...items];
  let bestDistance = Infinity;
  let bestRoute: T[] = [...items];

  function search(route: T[], remaining: T[], distance: number) {
    if (distance >= bestDistance) return;
    if (!remaining.length) {
      bestDistance = distance;
      bestRoute = [...route];
      return;
    }
    for (let index = 0; index < remaining.length; index += 1) {
      const next = remaining[index];
      const previous = route.at(-1);
      search(
        [...route, next],
        [...remaining.slice(0, index), ...remaining.slice(index + 1)],
        distance + (previous ? haversineKm(previous, next) : 0),
      );
    }
  }

  for (let index = 0; index < items.length; index += 1) {
    search(
      [items[index]],
      [...items.slice(0, index), ...items.slice(index + 1)],
      0,
    );
  }
  return bestRoute;
}

function amapMarkerUrl(point: any) {
  const params = new URLSearchParams({
    position: `${point.longitude},${point.latitude}`,
    name: point.name,
    src: "food-journey-atlas",
    coordinate: "gaode",
    callnative: "0",
  });
  return `https://uri.amap.com/marker?${params.toString()}`;
}

function LocationCard({ point }: { point: any }) {
  if (
    !Number.isFinite(point?.longitude) ||
    !Number.isFinite(point?.latitude)
  )
    return null;
  const area = [point.province, point.city, point.district]
    .filter((value, index, values) => value && values.indexOf(value) === index)
    .join(" · ");
  const source =
    point.coordinateSource === "source_geo"
      ? "微博发布时附带的位置"
      : point.coordinateSource === "explicit_region_geocode"
        ? "微博正文中的地区信息"
        : point.coordinateSource
          ? "微博地点与公开地理信息核对"
          : "公开记录中的地点信息";
  return (
    <div className="location-card">
      <div>
        <small>地理位置</small>
        {area && <strong>{area}</strong>}
        {point.address && <span>{point.address}</span>}
        <span>位置依据：{source}</span>
        <code>
          {point.longitude.toFixed(5)}, {point.latitude.toFixed(5)}
        </code>
      </div>
      <a href={amapMarkerUrl(point)} target="_blank" rel="noreferrer">
        在高德查看 <Arrow />
      </a>
    </div>
  );
}

function tripRegionOptions(atlas: Atlas, trip: any): RegionOption[] {
  const options = new Map<string, RegionOption>();
  for (const visit of trip.visits || []) {
    const option = regionOptionForVisit(atlas, trip, visit);
    options.set(option.key, option);
  }
  if (!options.size) {
    const fallbackGroup = (trip.visits || []).some((visit: any) =>
      isDomesticCoordinate(visit.longitude, visit.latitude),
    )
      ? "国内其他地区"
      : "海外地区";
    const province =
      (trip.regions || []).find(
        (name: string) =>
          name.endsWith("省") ||
          name.endsWith("自治区") ||
          name.endsWith("特别行政区") ||
          name.endsWith("市"),
      ) ||
      trip.regions?.[0] ||
      fallbackGroup;
    const city =
      (trip.regions || []).find(
        (name: string) => name.endsWith("市") && name !== province,
      ) || province;
    const key = `${province}::${city}`;
    options.set(key, {
      key,
      province,
      city,
      label: city === province ? province : city,
      count: 0,
    });
  }
  return [...options.values()];
}

function regionGroups(atlas: Atlas) {
  const options = new Map<string, RegionOption>();
  for (const trip of atlas.trips) {
    for (const option of tripRegionOptions(atlas, trip)) {
      const current = options.get(option.key) || option;
      current.count += 1;
      options.set(option.key, current);
    }
  }
  const provinces = new Map<string, RegionOption[]>();
  for (const option of options.values()) {
    const group = provinces.get(option.province) || [];
    group.push(option);
    provinces.set(option.province, group);
  }
  return [...provinces.entries()]
    .map(([province, cities]) => ({
      province,
      cities: cities.sort(
        (a, b) => b.count - a.count || a.label.localeCompare(b.label, "zh-CN"),
      ),
      count: atlas.trips.filter((trip) =>
        tripRegionOptions(atlas, trip).some(
          (option) => option.province === province,
        ),
      ).length,
    }))
    .sort(
      (a, b) =>
        (a.province === "海外地区" ? 1 : 0) -
          (b.province === "海外地区" ? 1 : 0) ||
        b.count - a.count ||
        a.province.localeCompare(b.province, "zh-CN"),
    );
}
function Arrow() {
  return <span aria-hidden="true">↗</span>;
}
function Confidence({ value = "中等" }: { value?: string }) {
  const tone = value === "较高" ? "high" : value === "较低" ? "low" : "medium";
  return <span className={`confidence ${tone}`}>{value}可信</span>;
}
function Notice({ showLink = true }: { showLink?: boolean }) {
  return (
    <aside className={`data-notice ${showLink ? "" : "without-link"}`}>
      <span className="notice-mark">AI</span>
      <p>
        本站内容由 AI
        辅助整理与筛选，可能存在错误。到访日期通常以微博发布时间代替；地点、食物与旅程聚类均保留来源和可信状态。
      </p>
      {showLink && (
        <a href="/about-data">
          了解数据方法 <Arrow />
        </a>
      )}
    </aside>
  );
}
function Header() {
  const pathname = usePathname();
  const links = [
    ["/", "首页"],
    ["/trips", "全部旅程"],
    ["/recreate", "复刻旅程"],
    ["/about-data", "关于数据"],
  ];
  return (
    <header className="site-header">
      <a className="brand" href="/" aria-label="陈晓卿美食足迹地图首页">
        <span className="brand-seal">食迹</span>
        <span>陈晓卿美食足迹地图</span>
      </a>
      <nav aria-label="主导航">
        {links.map(([href, label]) => (
          <a
            key={href}
            className={pathname === href ? "active" : ""}
            href={href}
          >
            {label}
          </a>
        ))}
      </nav>
      <a className="nav-cta" href="/trips">
        开始探索 <span>→</span>
      </a>
    </header>
  );
}
function Footer({ atlas }: { atlas: Atlas }) {
  return (
    <footer>
      <div>
        <span className="brand-seal">食迹</span>
        <p>从公开记录出发，沿时间与地点重新阅读一位美食记录者的行旅。</p>
      </div>
      <div className="footer-links">
        <a href="/trips">全部旅程</a>
        <a href="/recreate">复刻旅程</a>
        <a href="/about-data">数据说明</a>
      </div>
      <small>
        数据版本 {atlas.manifest.version} · {atlas.manifest.generatedAt}
      </small>
    </footer>
  );
}
function TripCard({ trip, index }: { trip: any; index: number }) {
  return (
    <a className="trip-card" href={`/trips/${trip.id}`}>
      <div className={`trip-art art-${index % 4}`} aria-hidden="true">
        <span>{String(index + 1).padStart(2, "0")}</span>
        <div className="route-motif">
          <i />
          <i />
          <i />
        </div>
        <b>{trip.regions.slice(0, 2).join(" · ")}</b>
      </div>
      <div className="trip-card-body">
        <div className="eyebrow-row">
          <span>{kindLabels[trip.kind] || trip.kind}</span>
          <Confidence value={trip.confidenceLabel} />
        </div>
        <h3>{trip.title}</h3>
        <p>{trip.subtitle || trip.summary}</p>
        <div className="card-meta">
          <span>{dateRange(trip.startDate, trip.endDate)}</span>
          <span>{trip.visitCount} 次到访</span>
          <span>{trip.postCount} 条记录</span>
        </div>
      </div>
    </a>
  );
}
function Home({ atlas }: { atlas: Atlas }) {
  const featured = [...atlas.trips]
    .sort((a, b) => b.visitCount + b.postCount - a.visitCount - a.postCount)
    .slice(0, 4);
  const counts = atlas.manifest.counts;
  const yearGroups = atlas.manifest.years.reduce<number[][]>((groups, year) => {
    const last = groups.at(-1);
    if (!last || year - last.at(-1)! > 2) groups.push([year]);
    else last.push(year);
    return groups;
  }, []);
  return (
    <main>
      <section className="hero">
        <div className="hero-copy">
          <p className="kicker">陈晓卿 · 美食地图 · 足迹 · 跟随</p>
          <h1>
            沿着味道，
            <br />
            重走一段段真实旅程。
          </h1>
          <p className="hero-lead">
            一个基于公开微博记录构建的个人美食旅行知识库。从时间、地点与原始记录出发，发现食物背后的行旅脉络。
          </p>
          <div className="hero-actions">
            <a className="button primary" href="/trips">
              浏览全部旅程 <span>→</span>
            </a>
            <a className="button text" href="/recreate">
              按条件复刻一段旅程 <Arrow />
            </a>
          </div>
        </div>
        <div className="hero-poster" aria-label="数据覆盖摘要">
          <div className="poster-orbit orbit-one" />
          <div className="poster-orbit orbit-two" />
          <div className="poster-core">
            <small>记录覆盖</small>
            <strong>
              {new Date(atlas.manifest.coverageStart).getFullYear()}
            </strong>
            <span>—</span>
            <strong>
              {new Date(atlas.manifest.coverageEnd).getFullYear()}
            </strong>
          </div>
          <span className="poster-label label-north">北京</span>
          <span className="poster-label label-east">江南</span>
          <span className="poster-label label-south">岭南</span>
          <span className="poster-label label-west">西南</span>
        </div>
      </section>
      <section className="stats" aria-label="核心数据">
        {[
          ["原始记录", counts.posts],
          ["系统旅程", counts.trips],
          ["到访事件", counts.visits],
          ["具体地点", counts.places],
          ["覆盖城市", counts.cities],
        ].map(([label, value]) => (
          <div key={label}>
            <strong>{Number(value).toLocaleString("zh-CN")}</strong>
            <span>{label}</span>
          </div>
        ))}
      </section>
      <section className="section-block">
        <div className="section-heading">
          <div>
            <p className="kicker">Selected journeys</p>
            <h2>重点旅程</h2>
          </div>
          <p>
            107
            段由系统从连续记录中整理出的旅程。它们是保守策展视图，不代表全部微博。
          </p>
        </div>
        <div className="featured-grid">
          {featured.map((trip, index) => (
            <TripCard key={trip.id} trip={trip} index={index} />
          ))}
        </div>
        <a className="center-link" href="/trips">
          查看全部 {counts.trips} 段旅程 <span>→</span>
        </a>
      </section>
      <section className="timeline-section">
        <div className="section-heading">
          <div>
            <p className="kicker">Across the years</p>
            <h2>从时间进入</h2>
          </div>
          <p>选择一段年份，查看当时留下的旅程记录。</p>
        </div>
        <div className="year-ranges">
          {yearGroups.map((group) => {
            const from = group[0],
              to = group.at(-1)!;
            return (
              <a key={from} href={`/trips?from=${from}&to=${to}`}>
                <small>
                  {from === to ? "单年记录" : `${group.length} 年跨度`}
                </small>
                <strong>
                  {from}
                  {from !== to && <>—{to}</>}
                </strong>
                <span>查看旅程 →</span>
              </a>
            );
          })}
        </div>
      </section>
      <Notice />
    </main>
  );
}

function Trips({ atlas }: { atlas: Atlas }) {
  const searchParams = useSearchParams();
  const [query, setQuery] = useState(searchParams.get("q") || "");
  const [from, setFrom] = useState(searchParams.get("from") || "");
  const [to, setTo] = useState(searchParams.get("to") || "");
  const [region, setRegion] = useState("");
  const [kind, setKind] = useState("");
  const [sort, setSort] = useState("desc");
  const groupedRegions = useMemo(() => regionGroups(atlas), [atlas]);
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return atlas.trips
      .filter((trip) => {
        const year = new Date(trip.startDate).getFullYear();
        const haystack = [
          trip.title,
          trip.subtitle,
          trip.summary,
          ...trip.regions,
          ...trip.themeFoods.map((x: any) => x.name),
        ]
          .join(" ")
          .toLowerCase();
        return (
          (!q || haystack.includes(q)) &&
          (!from || year >= Number(from)) &&
          (!to || year <= Number(to)) &&
          (!region ||
            tripRegionOptions(atlas, trip).some(
              (option) =>
                option.key === region ||
                (region.endsWith("::*") &&
                  option.province === region.slice(0, -3)),
            )) &&
          (!kind || trip.kind === kind)
        );
      })
      .sort(
        (a, b) =>
          (sort === "desc" ? 1 : -1) *
          (new Date(b.startDate).getTime() - new Date(a.startDate).getTime()),
      );
  }, [atlas, query, from, to, region, kind, sort]);
  return (
    <main>
      <section className="page-intro">
        <p className="kicker">Journey archive</p>
        <h1>全部旅程</h1>
        <p>
          按时间、地区与主题浏览系统整理的封版旅程。每个节点都能回到公开原始记录。
        </p>
      </section>
      <section className="archive-layout">
        <aside className="filters">
          <div className="filter-title">
            <strong>筛选条件</strong>
            <button
              onClick={() => {
                setQuery("");
                setFrom("");
                setTo("");
                setRegion("");
                setKind("");
              }}
            >
              清除
            </button>
          </div>
          <label>
            关键词
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="菜名、城市、旅程…"
            />
          </label>
          <div className="double-field">
            <label>
              起始年份
              <select value={from} onChange={(e) => setFrom(e.target.value)}>
                <option value="">不限</option>
                {atlas.manifest.years.map((y) => (
                  <option key={y}>{y}</option>
                ))}
              </select>
            </label>
            <label>
              结束年份
              <select value={to} onChange={(e) => setTo(e.target.value)}>
                <option value="">不限</option>
                {atlas.manifest.years.map((y) => (
                  <option key={y}>{y}</option>
                ))}
              </select>
            </label>
          </div>
          <label>
            旅程类型
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">全部类型</option>
              {Object.entries(kindLabels).map(([key, value]) => (
                <option key={key} value={key}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="region-filters">
            <legend>按国内或海外地区查找</legend>
            {groupedRegions.map((group) => {
              const directCity =
                ["北京市", "上海市", "天津市", "重庆市"].includes(
                  group.province,
                ) &&
                group.cities.length === 1 &&
                group.cities[0].city === group.province
                  ? group.cities[0]
                  : null;
              const directProvince =
                group.province === "台湾省"
                  ? {
                      key: `${group.province}::*`,
                      count: group.count,
                    }
                  : directCity;
              return (
                <div className="region-group" key={group.province}>
                  {directProvince ? (
                    <button
                      type="button"
                      className={`province-filter ${region === directProvince.key ? "selected" : ""}`}
                      onClick={() =>
                        setRegion(
                          region === directProvince.key
                            ? ""
                            : directProvince.key,
                        )
                      }
                    >
                      <strong>{group.province}</strong>
                      <small>{directProvince.count}</small>
                    </button>
                  ) : (
                    <>
                      <h4>{group.province}</h4>
                      {group.cities.map((city) => (
                        <button
                          type="button"
                          className={region === city.key ? "selected" : ""}
                          key={city.key}
                          onClick={() =>
                            setRegion(region === city.key ? "" : city.key)
                          }
                        >
                          <span>{city.label}</span>
                          <small>{city.count}</small>
                        </button>
                      ))}
                    </>
                  )}
                </div>
              );
            })}
          </fieldset>
        </aside>
        <div className="archive-results">
          <div className="results-top">
            <p>
              找到 <strong>{results.length}</strong> 段旅程
            </p>
            <label>
              排序
              <select value={sort} onChange={(e) => setSort(e.target.value)}>
                <option value="desc">时间从近到远</option>
                <option value="asc">时间从远到近</option>
              </select>
            </label>
          </div>
          {results.length ? (
            <div className="trip-list">
              {results.map((trip, index) => (
                <TripCard key={trip.id} trip={trip} index={index} />
              ))}
            </div>
          ) : (
            <div className="empty">
              <strong>没有匹配的旅程</strong>
              <p>试试放宽年份或移除地区条件。</p>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

function Graph({
  trip,
  selected,
  onSelect,
  mainOnly,
}: {
  trip: any;
  selected: string;
  onSelect: (id: string) => void;
  mainOnly: boolean;
}) {
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [basemap, setBasemap] = useState<Basemap | null>(null);
  const [viewport, setViewport] = useState({ width: 900, height: 340 });
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{
    pointerId: number;
    x: number;
    y: number;
    originX: number;
    originY: number;
  } | null>(null);
  useEffect(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }, [trip.title, trip.visits.map((visit: any) => visit.id).join("|")]);
  useEffect(() => {
    let active = true;
    loadBasemap()
      .then((value) => {
        if (active) setBasemap(value);
      })
      .catch(() => {
        if (active) setBasemap(null);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!canvasRef.current) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width && height) setViewport({ width, height });
    });
    observer.observe(canvasRef.current);
    return () => observer.disconnect();
  }, []);
  const points = trip.visits
    .filter((v: any) => !mainOnly || v.role === "anchor")
    .filter(
      (v: any) => Number.isFinite(v.longitude) && Number.isFinite(v.latitude),
    );
  if (!points.length)
    return <div className="empty">这些记录暂时没有可绘制坐标。</div>;
  const provinceNames = new Set(
    points.map((point: any) => point.province).filter(Boolean),
  );
  const cityNames = new Set(
    points.map((point: any) => point.city).filter(Boolean),
  );
  const districtNames = new Set(
    points.map((point: any) => point.district).filter(Boolean),
  );
  const provinceFeatures =
    basemap?.features.filter(
      (feature) =>
        feature.level === "province" && provinceNames.has(feature.name),
    ) || [];
  const cityFeatures =
    basemap?.features.filter(
      (feature) => feature.level === "city" && cityNames.has(feature.name),
    ) || [];
  const districtFeatures =
    basemap?.features.filter(
      (feature) =>
        feature.level === "district" && districtNames.has(feature.name),
    ) || [];
  const destinationFeatures =
    basemap?.features.filter(
      (feature) =>
        ["country", "admin1"].includes(feature.level) &&
        points.some((point: any) =>
          geometryContainsCoordinate(
            feature.geometry,
            point.longitude,
            point.latitude,
          ),
        ),
    ) || [];
  const routeExtent = points.map((point: any) =>
    mapCoordinate([point.longitude, point.latitude]),
  );
  const minMapX = Math.min(...routeExtent.map((point) => point.x));
  const maxMapX = Math.max(...routeExtent.map((point) => point.x));
  const minMapY = Math.min(...routeExtent.map((point) => point.y));
  const maxMapY = Math.max(...routeExtent.map((point) => point.y));
  const spanX = Math.max(maxMapX - minMapX, 0.00035);
  const spanY = Math.max(maxMapY - minMapY, 0.00035);
  const padding = Math.max(
    28,
    Math.min(70, viewport.width * 0.1, viewport.height * 0.16),
  );
  const mapScale = Math.min(
    (viewport.width - padding * 2) / spanX,
    (viewport.height - padding * 2) / spanY,
  );
  const project = (coordinate: number[]) => {
    const value = mapCoordinate(coordinate);
    return {
      x:
        viewport.width / 2 +
        (value.x - (minMapX + maxMapX) / 2) * mapScale,
      y:
        viewport.height / 2 -
        (value.y - (minMapY + maxMapY) / 2) * mapScale,
    };
  };
  const position = (point: any) =>
    project([point.longitude, point.latitude]);
  const anchors = points.filter((p: any) => p.role === "anchor");
  const relevantRivers =
    basemap?.rivers.filter((river) =>
      geometryCoordinates(river.geometry).some((coordinate) => {
        const value = mapCoordinate(coordinate);
        return (
          value.x >= minMapX &&
          value.x <= maxMapX &&
          value.y >= minMapY &&
          value.y <= maxMapY
        );
      }),
    ) || [];
  const labelGroups = new Map<
    string,
    { longitude: number; latitude: number; count: number }
  >();
  for (const point of points) {
    const name =
      point.district ||
      point.city ||
      point.province ||
      point.destinationLabel ||
      (points.every(
        (item: any) => !item.district && !item.city && !item.province,
      )
        ? destinationFromTitle(trip.title)
        : "");
    if (!name) continue;
    const current = labelGroups.get(name) || {
      longitude: 0,
      latitude: 0,
      count: 0,
    };
    current.longitude += point.longitude;
    current.latitude += point.latitude;
    current.count += 1;
    labelGroups.set(name, current);
  }
  const nodePositions = points.map(position);
  const placedLabelBoxes: Array<{
    left: number;
    right: number;
    top: number;
    bottom: number;
  }> = [];
  const labelOffsets = [
    [0, 0],
    [0, -34],
    [38, 0],
    [-38, 0],
    [0, 34],
    [34, -28],
    [-34, -28],
    [34, 28],
    [-34, 28],
  ];
  const placeLabels = [...labelGroups.entries()]
    .slice(0, 8)
    .map(([name, value]) => {
      const feature = [
        ...districtFeatures,
        ...cityFeatures,
        ...provinceFeatures,
      ].find((item) => item.name === name);
      const featurePoints = feature
        ? geometryCoordinates(feature.geometry).map(project)
        : [];
      const featureOrigin = featurePoints.length
        ? {
            x:
              (Math.min(...featurePoints.map((point) => point.x)) +
                Math.max(...featurePoints.map((point) => point.x))) /
              2,
            y:
              (Math.min(...featurePoints.map((point) => point.y)) +
                Math.max(...featurePoints.map((point) => point.y))) /
              2,
          }
        : null;
      const pointOrigin = project([
        value.longitude / value.count,
        value.latitude / value.count,
      ]);
      const origin =
        featureOrigin &&
        featureOrigin.x > 20 &&
        featureOrigin.x < viewport.width - 20 &&
        featureOrigin.y > 20 &&
        featureOrigin.y < viewport.height - 20
          ? featureOrigin
          : pointOrigin;
      const width = name.length * 13 + 12;
      const height = 20;
      const candidates = labelOffsets.map(([offsetX, offsetY]) => {
        const x = origin.x + offsetX;
        const y = origin.y + offsetY;
        const box = {
          left: x - width / 2,
          right: x + width / 2,
          top: y - height / 2,
          bottom: y + height / 2,
        };
        const inside =
          box.left > 8 &&
          box.right < viewport.width - 8 &&
          box.top > 8 &&
          box.bottom < viewport.height - 8;
        const overlapsLabel = placedLabelBoxes.some(
          (placed) =>
            box.left < placed.right &&
            box.right > placed.left &&
            box.top < placed.bottom &&
            box.bottom > placed.top,
        );
        const nodeClearance = Math.min(
          ...nodePositions.map(
            (point) => Math.hypot(point.x - x, point.y - y) - 30,
          ),
        );
        return {
          x,
          y,
          box,
          score:
            nodeClearance - (inside ? 0 : 1000) - (overlapsLabel ? 600 : 0),
        };
      });
      const selected = candidates.sort((a, b) => b.score - a.score)[0];
      placedLabelBoxes.push(selected.box);
      return { name, x: selected.x, y: selected.y };
    });
  const scope = [
    ...new Set(
      points.flatMap((point: any) =>
        [point.province, point.city, point.district].filter(Boolean),
      ),
    ),
  ].slice(0, 4);
  const totalDistance = anchors
    .slice(0, -1)
    .reduce(
      (sum: number, point: any, index: number) =>
        sum + haversineKm(point, anchors[index + 1]),
      0,
    );

  function updateZoom(next: number) {
    const value = Math.min(2.2, Math.max(0.65, next));
    const ratio = value / zoom;
    setZoom(value);
    setOffset((current) => ({
      x: current.x * ratio,
      y: current.y * ratio,
    }));
  }

  function pointerDown(event: any) {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      originX: offset.x,
      originY: offset.y,
    };
  }

  function pointerMove(event: any) {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    setOffset({
      x: drag.current.originX + event.clientX - drag.current.x,
      y: drag.current.originY + event.clientY - drag.current.y,
    });
  }

  function pointerUp(event: any) {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  }

  return (
    <div className="geo-graph" aria-label={`${trip.title}地理关系图`}>
      <div className="map-toolbar">
        <div className="map-scope">
          <small>图上范围</small>
          <strong>{scope.join(" · ") || "坐标记录"}</strong>
          {totalDistance > 0 && (
            <span>站点直线相距约 {Math.round(totalDistance)} km</span>
          )}
        </div>
        <div className="map-controls" aria-label="地图缩放">
          <button onClick={() => updateZoom(zoom + 0.25)} aria-label="放大">
            +
          </button>
          <button onClick={() => updateZoom(zoom - 0.25)} aria-label="缩小">
            −
          </button>
          <button
            className="reset"
            onClick={() => {
              setZoom(1);
              setOffset({ x: 0, y: 0 });
            }}
          >
            复位
          </button>
          <output>{Math.round(zoom * 100)}%</output>
        </div>
      </div>
      <div
        className="geo-canvas"
        ref={canvasRef}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={pointerUp}
      >
        <div
          className="geo-scene"
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
            "--label-scale": 1 / zoom,
          }}
        >
          <svg
            viewBox={`0 0 ${viewport.width} ${viewport.height}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <g className="admin-map">
              {provinceFeatures.map((feature) => (
                <path
                  key={`province-${feature.name}`}
                  className="province-shape"
                  d={geometryPath(feature.geometry, project)}
                />
              ))}
              {destinationFeatures
                .filter((feature) => feature.level === "country")
                .map((feature) => (
                  <path
                    key={`country-${feature.name}`}
                    className="country-shape"
                    d={geometryPath(feature.geometry, project)}
                  />
                ))}
              {destinationFeatures
                .filter((feature) => feature.level === "admin1")
                .map((feature) => (
                  <path
                    key={`admin1-${feature.name}`}
                    className="admin1-shape"
                    d={geometryPath(feature.geometry, project)}
                  />
                ))}
              {cityFeatures.map((feature) => (
                <path
                  key={`city-${feature.name}`}
                  className="city-shape"
                  d={geometryPath(feature.geometry, project)}
                />
              ))}
              {districtFeatures.map((feature) => (
                <path
                  key={`district-${feature.name}`}
                  className="district-shape"
                  d={geometryPath(feature.geometry, project)}
                />
              ))}
            </g>
            <g className="river-map">
              {relevantRivers.map((river, index) => (
                <path
                  key={`${river.name}-${index}`}
                  d={geometryPath(river.geometry, project)}
                />
              ))}
            </g>
            {anchors.slice(0, -1).map((point: any, index: number) => {
              const a = position(point),
                next = anchors[index + 1],
                b = position(next);
              return (
                <line
                  key={point.id}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  className={haversineKm(point, next) > 500 ? "long-edge" : ""}
                />
              );
            })}
          </svg>
          {placeLabels.map((label) => (
            <span
              key={label.name}
              className="map-place-label"
              style={{ left: label.x, top: label.y }}
            >
              {label.name}
            </span>
          ))}
          {points.map((point: any) => {
            const pos = position(point);
            const edgeClass = [
              pos.x < 100
                ? "label-left"
                : pos.x > viewport.width - 100
                  ? "label-right"
                  : "",
              pos.y > viewport.height - 80 ? "label-above" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <button
                key={point.id}
                className={`map-node ${point.role} ${edgeClass} ${selected === point.id ? "selected" : ""}`}
                style={{ left: pos.x, top: pos.y }}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => onSelect(point.id)}
                aria-label={`${roleLabels[point.role]}：${point.name}`}
              >
                <i>{point.role === "anchor" ? anchors.indexOf(point) + 1 : "·"}</i>
                <span>
                  <strong>{point.name}</strong>
                  {(point.city || point.district) && (
                    <small>
                      {[point.city, point.district].filter(Boolean).join(" · ")}
                    </small>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="map-footer">
        <div className="map-legend">
          <span>
            <i className="anchor" />
            主线
          </span>
          <span>
            <i className="candidate" />
            可能
          </span>
          <span>
            <i className="region_only" />
            区域
          </span>
          <span>
            <i className="context" />
            背景
          </span>
        </div>
        <small title={basemap?.source}>
          拖动浏览 · 地理轮廓随视窗移动 · 连线表示记录时序
        </small>
      </div>
    </div>
  );
}

function RichPost({ post }: { post: any }) {
  if (!post) return <p className="muted">未找到关联原始记录。</p>;
  const segments: ReactNode[] = [];
  let cursor = 0;
  for (const mention of [...post.mentions].sort((a, b) => a.start - b.start)) {
    if (mention.start < cursor) continue;
    segments.push(post.content.slice(cursor, mention.start));
    segments.push(
      <mark
        key={mention.id}
        title={`${mention.type} · ${Math.round(mention.confidence * 100)}%`}
      >
        {post.content.slice(mention.start, mention.end)}
      </mark>,
    );
    cursor = mention.end;
  }
  segments.push(post.content.slice(cursor));
  const labelOrder = ["菜品", "菜系", "食材", "食物品类", "烹饪方式"];
  const groupedLabels = labelOrder
    .map((type) => {
      const values = new Map<string, any>();
      for (const label of post.labels.filter((item: any) => item.type === type)) {
        const current = values.get(label.name);
        if (!current || label.confidence > current.confidence) {
          values.set(label.name, label);
        }
      }
      return {
        type,
        labels: [...values.values()]
          .sort((a, b) => b.confidence - a.confidence)
          .slice(0, 10),
      };
    })
    .filter((group) => group.labels.length);
  return (
    <article className="post-content">
      <div className="source-label">
        <span>微博正文</span>
        <time>{formatDate(post.createdAt, true)} 发布</time>
      </div>
      <p className="weibo-text">{segments}</p>
      <a className="raw-link" href={post.url} target="_blank" rel="noreferrer">
        查看原微博 <Arrow />
      </a>
      {post.analysis.length ? (
        <div className="analysis-block">
          <div className="source-label">
            <span>图片分析</span>
          </div>
          <ul className="analysis-list">
            {post.analysis.map((item: any) => (
              <li key={item.index}>
                <p>{item.description}</p>
                <small>{Math.round(item.confidence * 100)}% 可信</small>
              </li>
            ))}
          </ul>
          <div className="food-evidence-groups">
            {groupedLabels.map((group) => (
              <section key={group.type}>
                <h4>{group.type}</h4>
                <div className="tag-cloud">
                  {group.labels.map((label: any) => (
                    <span
                      key={`${group.type}-${label.name}`}
                      className={label.confidence < 0.7 ? "tentative" : ""}
                    >
                      {label.confidence < 0.7 && "可能 · "}
                      {label.name}
                    </span>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      ) : (
        <div className="no-media">
          这条记录没有配图分析，原文仍保留在档案中。
        </div>
      )}
    </article>
  );
}

function TripDetail({ atlas, trip }: { atlas: Atlas; trip: any }) {
  const anchors = trip.visits.filter((v: any) => v.role === "anchor");
  const [selectedId, setSelectedId] = useState(
    anchors[0]?.id || trip.visits[0]?.id,
  );
  const [postIndex, setPostIndex] = useState(0);
  const [mainOnly, setMainOnly] = useState(false);
  const selected =
    trip.visits.find((v: any) => v.id === selectedId) || anchors[0];
  const posts = (selected?.postIds || [])
    .map((id: string) => atlas.posts[id])
    .filter(Boolean);
  useEffect(() => setPostIndex(0), [selectedId]);
  return (
    <main>
      <div className="breadcrumb">
        <a href="/trips">全部旅程</a>
        <span>/</span>
        <span>{trip.title}</span>
      </div>
      <section className="trip-hero">
        <div>
          <div className="eyebrow-row">
            <span>{kindLabels[trip.kind]}</span>
            <Confidence value={trip.confidenceLabel} />
          </div>
          <h1>{trip.title}</h1>
          <p className="trip-subtitle">{trip.subtitle}</p>
          <p>{trip.summary}</p>
          <div className="trip-facts">
            <span>{dateRange(trip.startDate, trip.endDate)}</span>
            <span>{trip.regions.join(" · ")}</span>
            <span>{trip.visitCount} 次到访</span>
            <span>{trip.postCount} 条记录</span>
          </div>
        </div>
        <aside>
          <small>这段旅程从哪里来</small>
          <p>
            我们把时间相近、地点相连的公开记录整理在一起。路线呈现的是记录之间的脉络，不是对真实行程的完整复原。
          </p>
        </aside>
      </section>
      <section className="trip-workspace">
        <div className="journey-panel">
          <div className="panel-title">
            <div>
              <p className="kicker">Along the way</p>
              <h2>沿途地点</h2>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={mainOnly}
                onChange={(e) => setMainOnly(e.target.checked)}
              />
              <span />
              只看主线
            </label>
          </div>
          <Graph
            trip={trip}
            selected={selectedId}
            onSelect={setSelectedId}
            mainOnly={mainOnly}
          />
          <div className="route-list">
            {trip.visits
              .filter((v: any) => !mainOnly || v.role === "anchor")
              .map((visit: any) => (
                <button
                  key={visit.id}
                  className={selectedId === visit.id ? "selected" : ""}
                  onClick={() => setSelectedId(visit.id)}
                >
                  <i>
                    {visit.role === "anchor" ? anchors.indexOf(visit) + 1 : "·"}
                  </i>
                  <span>
                    <strong>{visit.name}</strong>
                    <small>
                      {formatDate(visit.date)} · {roleLabels[visit.role]}
                    </small>
                  </span>
                  {visit.confidenceLabel && (
                    <Confidence value={visit.confidenceLabel} />
                  )}
                </button>
              ))}
          </div>
        </div>
        <div className="node-panel">
          {selected ? (
            <>
              <div className="node-heading">
                <p className="kicker">这一站</p>
                <h2>{selected.name}</h2>
                <div className="node-meta">
                  <span>{formatDate(selected.date)}</span>
                  <span>{roleLabels[selected.role]}</span>
                  {selected.confidenceLabel && (
                    <Confidence value={selected.confidenceLabel} />
                  )}
                </div>
                {selected.contextNote && (
                  <p className="context-note">{selected.contextNote}</p>
                )}
                <LocationCard point={selected} />
              </div>
              {selected.food?.length > 0 && (
                <div className="food-strip">
                  {selected.food.map((food: any) => (
                    <span key={food.id}>
                      {food.name}
                      <small>{food.type}</small>
                    </span>
                  ))}
                </div>
              )}
              {posts.length > 1 && (
                <div className="post-tabs">
                  {posts.map((post: any, index: number) => (
                    <button
                      key={post.id}
                      className={postIndex === index ? "active" : ""}
                      onClick={() => setPostIndex(index)}
                    >
                      记录 {index + 1}
                    </button>
                  ))}
                </div>
              )}
              <RichPost post={posts[postIndex]} />
              <p className="proxy-note">
                日期为微博发布时间代理，不等同于精确到店时间。
              </p>
            </>
          ) : (
            <div className="empty">请选择一个旅程节点。</div>
          )}
        </div>
      </section>
    </main>
  );
}

function Recreate({ atlas }: { atlas: Atlas }) {
  const [region, setRegion] = useState("");
  const [year, setYear] = useState("");
  const [count, setCount] = useState("3");
  const [keyword, setKeyword] = useState("");
  const [includePossible, setIncludePossible] = useState(false);
  const [result, setResult] = useState<any[] | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [postIndex, setPostIndex] = useState(0);
  const groupedRegions = useMemo(() => regionGroups(atlas), [atlas]);
  const selectedRegionLabel =
    groupedRegions
      .flatMap((group) => group.cities)
      .find((option) => option.key === region)?.label || "不限地区";
  const selected =
    result?.find((visit) => visit.id === selectedId) || result?.[0];
  const selectedPosts = (selected?.postIds || [])
    .map((id: string) => atlas.posts[id])
    .filter(Boolean);

  useEffect(() => setPostIndex(0), [selectedId]);

  function shuffled<T>(items: T[]) {
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
    }
    return copy;
  }

  function createJourney() {
    const q = keyword.trim().toLowerCase();
    const matches = atlas.trips
      .flatMap((trip) =>
        trip.visits.map((visit: any) => {
          const regionOption = regionOptionForVisit(atlas, trip, visit);
          return {
            ...visit,
            sourceTripId: trip.id,
            regionKey: regionOption.key,
            regionGroup: regionOption.province,
            destinationLabel: regionOption.city,
          };
        }),
      )
      .filter(
        (visit, index, all) =>
          all.findIndex((item) => item.id === visit.id) === index,
      )
      .filter((visit) => includePossible || visit.role === "anchor")
      .filter(
        (visit) =>
          Number.isFinite(visit.longitude) && Number.isFinite(visit.latitude),
      )
      .filter((visit) => !region || visit.regionKey === region)
      .filter(
        (visit) => !year || String(new Date(visit.date).getFullYear()) === year,
      )
      .filter(
        (visit) =>
          !q ||
          [visit.name, ...(visit.food || []).map((item: any) => item.name)]
            .join(" ")
            .toLowerCase()
            .includes(q),
      );
    if (!matches.length) {
      setResult([]);
      setSelectedId("");
      return;
    }
    const wanted = Math.max(2, Number(count));
    const radiusKm = region
      ? region.startsWith("海外地区::")
        ? 180
        : 260
      : 320;
    const neighborhoods = shuffled(matches)
      .map((anchor) => ({
        anchor,
        nearby: matches.filter(
          (visit) =>
            visit.id !== anchor.id &&
            visit.regionGroup === anchor.regionGroup &&
            haversineKm(anchor, visit) <= radiusKm,
        ),
      }))
      .sort((a, b) => b.nearby.length - a.nearby.length);
    const viable = neighborhoods.filter(
      (item) => item.nearby.length >= wanted - 1,
    );
    const chosen = viable.length
      ? viable[Math.floor(Math.random() * viable.length)]
      : neighborhoods[0];
    const anchor = chosen.anchor;
    const nearby = chosen.nearby
      .map((visit) => {
        const yearDifference = Math.abs(
          new Date(visit.date).getFullYear() -
            new Date(anchor.date).getFullYear(),
        );
        return {
          visit,
          score:
            haversineKm(anchor, visit) +
            yearDifference * 60 +
            Math.random() * 35,
        };
      })
      .sort((a, b) => a.score - b.score)
      .map((item) => item.visit);
    const generated = orderByShortestRoute(
      [anchor, ...nearby].slice(0, wanted),
    );
    setResult(generated);
    setSelectedId(generated[0]?.id || "");
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    createJourney();
  }
  return (
    <main>
      <section className="page-intro recreate-intro">
        <p className="kicker">按足迹重新组合</p>
        <h1>复刻一段美食旅程</h1>
        <p>
          从已收录的真实足迹中，按条件随机组合一条临时浏览路线。同样的条件可以“换一组”，看看另一种走法。
        </p>
      </section>
      <section className="recreate-layout">
        <form onSubmit={submit} className="recreate-form">
          <div className="form-section">
            <span>01</span>
            <div>
              <h2>去哪里</h2>
              <p>选择一个已有记录覆盖的地区</p>
            </div>
          </div>
          <label>
            地区
            <select value={region} onChange={(e) => setRegion(e.target.value)}>
              <option value="">不限地区</option>
              {groupedRegions.map((group) => (
                <optgroup key={group.province} label={group.province}>
                  {group.cities.map((city) => (
                    <option key={city.key} value={city.key}>
                      {city.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <div className="form-section">
            <span>02</span>
            <div>
              <h2>什么时候</h2>
              <p>按记录年份缩小范围</p>
            </div>
          </div>
          <div className="double-field">
            <label>
              年份
              <select value={year} onChange={(e) => setYear(e.target.value)}>
                <option value="">不限年份</option>
                {atlas.manifest.years.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <label>
              节点数量
              <select value={count} onChange={(e) => setCount(e.target.value)}>
                <option value="2">2 个</option>
                <option value="3">3 个</option>
                <option value="5">5 个</option>
                <option value="7">7 个</option>
              </select>
            </label>
          </div>
          <div className="form-section">
            <span>03</span>
            <div>
              <h2>想吃什么</h2>
              <p>菜品、食材、菜系或烹饪方式</p>
            </div>
          </div>
          <label>
            关键词
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="例如：牛肉、粤菜、炖"
            />
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={includePossible}
              onChange={(e) => setIncludePossible(e.target.checked)}
            />
            <span>
              <strong>包含所有可能数据</strong>
              <small>纳入候选地点、区域点与其他较低可信记录</small>
            </span>
          </label>
          <button className="button primary full" type="submit">
            生成一段旅程 <span>→</span>
          </button>
        </form>
        <div className="recreate-result">
          {!result ? (
            <div className="result-placeholder">
              <span>路线将在这里出现</span>
              <div className="ghost-route">
                <i />
                <i />
                <i />
              </div>
              <p>每次生成都会从符合条件的真实记录中重新组合。</p>
            </div>
          ) : result.length ? (
            <>
              <div className="panel-title">
                <div>
                  <p className="kicker">这一次的组合</p>
                  <h2>
                    {selectedRegionLabel} · {keyword || "综合寻味"}
                  </h2>
                </div>
                <button
                  type="button"
                  className="reroll"
                  onClick={createJourney}
                >
                  换一组 ↻
                </button>
              </div>
              <Graph
                trip={{ title: "临时旅程", visits: result }}
                selected={selected?.id || ""}
                onSelect={setSelectedId}
                mainOnly={false}
              />
              <div className="generated-list">
                {result.map((visit, index) => (
                  <button
                    type="button"
                    key={visit.id}
                    className={selected?.id === visit.id ? "selected" : ""}
                    onClick={() => setSelectedId(visit.id)}
                  >
                    <i>{index + 1}</i>
                    <span>
                      <strong>{visit.name}</strong>
                      <small>
                        {formatDate(visit.date)} ·{" "}
                        {visit.food
                          ?.slice(0, 2)
                          .map((item: any) => item.name)
                          .join("、") || "微博记录"}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
              <p className="proxy-note">
                基于历史足迹在相近地区内随机组合，并按较短动线排列；符合条件的记录不足时不会跨区凑数。不是导航或实时营业建议。
              </p>
            </>
          ) : (
            <div className="empty">
              <strong>没有足够的可组合记录</strong>
              <p>请移除部分条件或开启“包含所有可能数据”。</p>
            </div>
          )}
        </div>
        <aside className="recreate-detail">
          {selected ? (
            <section className="generated-detail">
              <div className="node-heading">
                <p className="kicker">当前一站</p>
                <h2>{selected.name}</h2>
                <div className="node-meta">
                  <span>{formatDate(selected.date)}</span>
                  <span>{roleLabels[selected.role]}</span>
                  {selected.confidenceLabel && (
                    <Confidence value={selected.confidenceLabel} />
                  )}
                </div>
                {selected.contextNote && (
                  <p className="context-note">{selected.contextNote}</p>
                )}
                <LocationCard point={selected} />
              </div>
              {selected.food?.length > 0 && (
                <div className="food-strip">
                  {selected.food.map((food: any) => (
                    <span key={food.id}>
                      {food.name}
                      <small>{food.type}</small>
                    </span>
                  ))}
                </div>
              )}
              {selectedPosts.length > 1 && (
                <div className="post-tabs">
                  {selectedPosts.map((post: any, index: number) => (
                    <button
                      key={post.id}
                      className={postIndex === index ? "active" : ""}
                      onClick={() => setPostIndex(index)}
                    >
                      记录 {index + 1}
                    </button>
                  ))}
                </div>
              )}
              <RichPost post={selectedPosts[postIndex]} />
            </section>
          ) : (
            <div className="detail-placeholder">
              <p className="kicker">当前一站</p>
              <span>生成旅程后，站点内容会显示在这里。</span>
            </div>
          )}
        </aside>
      </section>
    </main>
  );
}

function PostPage({ post }: { post: any }) {
  return (
    <main className="narrow">
      <div className="breadcrumb">
        <a href="/trips">旅程档案</a>
        <span>/</span>
        <span>原始记录</span>
      </div>
      <section className="detail-title">
        <p className="kicker">Source record</p>
        <h1>一条可追溯的公开记录</h1>
        <p>完整正文与离线图片分析被分开呈现；原图不在本站展示或分发。</p>
      </section>
      <RichPost post={post} />
    </main>
  );
}
function PlacePage({ atlas, place }: { atlas: Atlas; place: any }) {
  const posts = place.postIds
      .map((id: string) => atlas.posts[id])
      .filter(Boolean),
    trips = atlas.trips.filter((t) =>
      t.visits.some((v: any) => v.placeId === place.id),
    );
  return (
    <main className="narrow">
      <div className="breadcrumb">
        <a href="/trips">旅程档案</a>
        <span>/</span>
        <span>地点</span>
      </div>
      <section className="detail-title">
        <p className="kicker">Place archive</p>
        <h1>{place.name}</h1>
        <p>
          {[place.city, place.district, place.address]
            .filter(Boolean)
            .join(" · ")}
        </p>
        <div className="tag-cloud">
          <span>
            {place.type || "具体地点"}
            <small>地点类型</small>
          </span>
          <span>
            {place.coordinates.longitude.toFixed(4)},{" "}
            {place.coordinates.latitude.toFixed(4)}
            <small>结构化坐标</small>
          </span>
        </div>
      </section>
      <section className="related">
        <h2>相关旅程</h2>
        {trips.length ? (
          trips.map((trip, i) => (
            <TripCard key={trip.id} trip={trip} index={i} />
          ))
        ) : (
          <p>此地点暂未进入封版主旅程，但仍保留在完整搜索中。</p>
        )}
        <h2>来源记录</h2>
        {posts.slice(0, 4).map((post: any) => (
          <RichPost key={post.id} post={post} />
        ))}
      </section>
    </main>
  );
}
function RegionPage({ atlas, region }: { atlas: Atlas; region: any }) {
  const posts = region.postIds
    .map((id: string) => atlas.posts[id])
    .filter(Boolean);
  return (
    <main className="narrow">
      <div className="breadcrumb">
        <a href="/trips">旅程档案</a>
        <span>/</span>
        <span>地区</span>
      </div>
      <section className="detail-title">
        <p className="kicker">Region archive</p>
        <h1>{region.name}</h1>
        <p>
          这是区域级位置，只说明记录与该地区有关，不伪装成具体餐厅或精确到访点。
        </p>
        <Confidence value="中等" />
      </section>
      <section className="related">
        <h2>区域来源记录</h2>
        {posts.slice(0, 6).map((post: any) => (
          <RichPost key={post.id} post={post} />
        ))}
      </section>
    </main>
  );
}
function About({ atlas }: { atlas: Atlas }) {
  const rows = [
    ["微博正文", "来自公开微博，可打开原微博链接核对。"],
    ["图片分析", "由视觉模型离线生成，不代表原图本身。"],
    ["记录时间", "通常采用微博发布时间代理，不等同精确到店时间。"],
    ["较高 / 中等 / 较低可信", "表达结构化结果的证据强弱，不是权威结论。"],
    ["时序连线", "表达记录先后，不是步行、驾车或铁路导航。"],
  ];
  return (
    <main className="narrow">
      <section className="page-intro">
        <p className="kicker">About the data</p>
        <h1>每一个点，都应该能回到来源。</h1>
        <p>
          本站不是餐厅推荐榜，也不判断今天是否营业。它整理公开记录中的时间、地点、食物与上下文，并保留推断的不确定性。
        </p>
      </section>
      <section className="method-grid">
        {[
          [
            "01",
            "公开记录",
            "只收录公开原创微博。正文可在站内阅读，并提供新页打开的原微博链接；原图不公开分发。",
          ],
          [
            "02",
            "结构化整理",
            "图片只作为离线分析输入。页面展示图片分析描述、候选菜品、食材与场景，不以生成图片替代原图。",
          ],
          [
            "03",
            "到访判断",
            "地点与到访由文本、定位与 POI 匹配共同支持。只知道城市时展示区域点，多候选时明确写作“可能地点”。",
          ],
          [
            "04",
            "旅程聚类",
            "系统依照时间和空间关系组合 107 段旅程。成员关系已冻结，叙事模型不改变路线节点。",
          ],
        ].map(([n, title, text]) => (
          <article key={n}>
            <span>{n}</span>
            <h2>{title}</h2>
            <p>{text}</p>
          </article>
        ))}
      </section>
      <section className="provenance">
        <h2>字段如何阅读</h2>
        {rows.map(([term, text]) => (
          <div key={term}>
            <strong>{term}</strong>
            <p>{text}</p>
          </div>
        ))}
      </section>
      <section className="version-card">
        <div>
          <p className="kicker">本期数据</p>
          <h2>{atlas.manifest.version}</h2>
        </div>
        <p>
          数据生成日期 {atlas.manifest.generatedAt}
          <br />
          一次性全量整理，发布后暂无增量更新计划。
        </p>
      </section>
      <Notice showLink={false} />
    </main>
  );
}
function Loading() {
  return (
    <main className="loading">
      <span className="brand-seal">食迹</span>
      <p>正在展开旅程档案…</p>
    </main>
  );
}

export default function AtlasApp() {
  const pathname = usePathname(),
    [atlas, setAtlas] = useState<Atlas | null>(null),
    [error, setError] = useState(false);
  useEffect(() => {
    fetch("/data/atlas.json")
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then(setAtlas)
      .catch(() => setError(true));
  }, []);
  if (error)
    return (
      <main className="loading">
        <strong>数据暂时无法读取</strong>
        <p>请稍后刷新页面。</p>
      </main>
    );
  if (!atlas) return <Loading />;
  const parts = pathname.split("/").filter(Boolean);
  let page: ReactNode;
  if (pathname === "/") page = <Home atlas={atlas} />;
  else if (pathname === "/trips") page = <Trips atlas={atlas} />;
  else if (parts[0] === "trips" && parts[1]) {
    const trip = atlas.trips.find((x) => x.id === parts[1]);
    page = trip ? (
      <TripDetail atlas={atlas} trip={trip} />
    ) : (
      <div className="empty page-empty">
        <strong>没有找到这段旅程</strong>
        <a href="/trips">返回全部旅程</a>
      </div>
    );
  } else if (pathname === "/recreate") page = <Recreate atlas={atlas} />;
  else if (parts[0] === "posts" && parts[1])
    page = <PostPage post={atlas.posts[parts[1]]} />;
  else if (parts[0] === "places" && parts[1] && atlas.places[parts[1]])
    page = <PlacePage atlas={atlas} place={atlas.places[parts[1]]} />;
  else if (parts[0] === "regions" && parts[1] && atlas.regions[parts[1]])
    page = <RegionPage atlas={atlas} region={atlas.regions[parts[1]]} />;
  else if (pathname === "/about-data") page = <About atlas={atlas} />;
  else
    page = (
      <div className="empty page-empty">
        <strong>页面不存在</strong>
        <a href="/">返回首页</a>
      </div>
    );
  return (
    <>
      <Header />
      {page}
      <Footer atlas={atlas} />
    </>
  );
}
