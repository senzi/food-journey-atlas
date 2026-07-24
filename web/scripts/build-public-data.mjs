import { createReadStream, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";

const sourceDir = path.resolve(process.cwd(), "..", "data-processing", "data");
const outputDir = path.resolve(process.cwd(), "public", "data");
const atlasPackageDir = path.resolve(
  process.cwd(),
  "node_modules",
  "cn-atlas",
);
const provinceGeoJson = JSON.parse(
  readFileSync(path.join(atlasPackageDir, "provinces.json"), "utf8"),
);
const prefectureGeoJson = JSON.parse(
  readFileSync(path.join(atlasPackageDir, "prefectures.json"), "utf8"),
);

function pointInRing(longitude, latitude, ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [x, y] = ring[index];
    const [previousX, previousY] = ring[previous];
    const crosses =
      y > latitude !== previousY > latitude &&
      longitude <
        ((previousX - x) * (latitude - y)) / (previousY - y || 1e-12) + x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function geometryContainsPoint(geometry, longitude, latitude) {
  const polygons =
    geometry?.type === "Polygon"
      ? [geometry.coordinates]
      : geometry?.type === "MultiPolygon"
        ? geometry.coordinates
        : [];
  return polygons.some(
    (polygon) =>
      polygon[0] &&
      pointInRing(longitude, latitude, polygon[0]) &&
      !polygon
        .slice(1)
        .some((hole) => pointInRing(longitude, latitude, hole)),
  );
}

const inferredAdminCache = new Map();
function inferAdmin(longitude, latitude) {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  const cacheKey = `${longitude.toFixed(4)},${latitude.toFixed(4)}`;
  if (inferredAdminCache.has(cacheKey)) return inferredAdminCache.get(cacheKey);
  const cityFeature = prefectureGeoJson.features.find((feature) =>
    geometryContainsPoint(feature.geometry, longitude, latitude),
  );
  const cityCode = String(cityFeature?.properties?.id || "");
  const provinceFeature =
    provinceGeoJson.features.find(
      (feature) =>
        cityCode &&
        String(feature.properties?.id || "").slice(0, 2) ===
          cityCode.slice(0, 2),
    ) ||
    provinceGeoJson.features.find((feature) =>
      geometryContainsPoint(feature.geometry, longitude, latitude),
    );
  const inferred = provinceFeature
    ? {
        province: provinceFeature.properties?.["地名"] || "",
        city:
          cityFeature?.properties?.["地名"] ||
          provinceFeature.properties?.["地名"] ||
          "",
      }
    : null;
  inferredAdminCache.set(cacheKey, inferred);
  return inferred;
}

async function readJsonl(file) {
  const rows = [];
  const input = createReadStream(path.join(sourceDir, file), {
    encoding: "utf8",
  });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim()) rows.push(JSON.parse(line));
  }
  return rows;
}

const [trips, visits, places, regions, posts, entities, candidates, contexts] =
  await Promise.all([
    readJsonl("trips_with_narratives_v2.jsonl"),
    readJsonl("visits_with_trips_v1.jsonl"),
    readJsonl("places_v1.jsonl"),
    readJsonl("regions_v1.jsonl"),
    readJsonl("vlm_results_v2_with_poi_mentions_v1.jsonl"),
    readJsonl("entities_v1.jsonl"),
    readJsonl("trip_membership_candidates_v1.jsonl"),
    readJsonl("trip_context_refs_v1.jsonl"),
  ]);

const entityMap = new Map(entities.map((item) => [item.entity_id, item]));
const placeMap = new Map(places.map((item) => [item.id, item]));
const regionMap = new Map(regions.map((item) => [item.id, item]));
const visitMap = new Map(visits.map((item) => [item.id, item]));
const postMap = new Map(posts.map((item) => [item.id, item]));

function confidenceLabel(value) {
  if (value >= 0.85) return "较高";
  if (value >= 0.65) return "中等";
  return "较低";
}

function compactEntity(id) {
  const entity = entityMap.get(id);
  if (!entity) return null;
  return {
    id,
    type: entity.entity_type,
    name: entity.canonical_name,
    count: entity.post_count,
  };
}

function collectAnalysis(post) {
  const summaries = [];
  const labels = [];
  for (const media of post.vlm_analysis || []) {
    const stage1 = media.stage1;
    const analysis = media.stage2?.analysis;
    if (stage1?.description) {
      summaries.push({
        index: media.pic_index,
        description: stage1.description,
        confidence: stage1.confidence,
        source: "图片分析",
      });
    }
    if (!analysis) continue;
    for (const [type, values] of [
      ["菜品", analysis.dish_candidates],
      ["食物品类", analysis.food_categories],
      ["食材", analysis.ingredients_visible],
      ["烹饪方式", analysis.cooking_methods],
      ["菜系", analysis.cuisine_style],
    ]) {
      for (const item of values || []) {
        if (item?.name) {
          labels.push({
            type,
            name: item.name,
            confidence: item.confidence ?? 0.5,
            source: item.source || "image",
          });
        }
      }
    }
  }
  return { summaries: summaries.slice(0, 4), labels: labels.slice(0, 24) };
}

function compactPost(post) {
  const analysis = collectAnalysis(post);
  return {
    id: post.id,
    createdAt: post.created_at,
    url: post.url,
    content: post.content,
    hasMedia: (post.vlm_analysis || []).length > 0,
    analysis: analysis.summaries,
    labels: analysis.labels,
    mentions: (post.mentions || []).map((mention) => ({
      id: mention.mention_id,
      entityId: mention.entity_id,
      type: mention.entity_type,
      text: mention.text,
      start: mention.start,
      end: mention.end,
      confidence: mention.confidence,
      linkStatus: mention.link_status,
      placeRefs: mention.place_refs || [],
    })),
  };
}

function hasFoodEvidence(visit) {
  if ((visit.food_ids || []).length) return true;
  return (visit.post_ids || []).some((postId) => {
    const post = postMap.get(postId);
    if (!post) return false;
    const hasFoodMention = (post.mentions || []).some((mention) =>
      ["dish", "cuisine", "restaurant"].includes(mention.entity_type),
    );
    return hasFoodMention || collectAnalysis(post).labels.length > 0;
  });
}

function inferAdminFromText(text) {
  if (/(?:北京|京城|海淀|朝阳)/.test(text)) {
    return { province: "北京市", city: "北京市" };
  }
  if (/(?:台湾|台北)/.test(text)) {
    return { province: "台湾省", city: "台北市" };
  }
  return null;
}

function compactVisit(visit, role = "anchor", tripTitle = "") {
  const point = visit.points?.[0];
  const place = visit.place_id ? placeMap.get(visit.place_id) : null;
  const region = visit.region_id ? regionMap.get(visit.region_id) : null;
  const longitude =
    point?.longitude ??
    place?.coordinates?.longitude ??
    region?.center?.longitude;
  const latitude =
    point?.latitude ?? place?.coordinates?.latitude ?? region?.center?.latitude;
  const inferredAdmin =
    !place?.province && !region?.province
      ? inferAdmin(longitude, latitude) ||
        inferAdminFromText(
          `${place?.canonical_name || point?.name || ""} ${tripTitle}`,
        )
      : null;
  const displayRole =
    role === "anchor" && !hasFoodEvidence(visit) ? "context" : role;
  return {
    id: visit.id,
    role: displayRole,
    name: place?.canonical_name || region?.name || point?.name || "位置未命名",
    placeId: visit.place_id,
    regionId: visit.region_id,
    date: visit.visited_at_start,
    sequence: visit.sequence,
    longitude,
    latitude,
    province:
      place?.province ||
      region?.province ||
      point?.province ||
      inferredAdmin?.province ||
      "",
    city:
      place?.city ||
      region?.city ||
      point?.city ||
      inferredAdmin?.city ||
      "",
    district: place?.district || region?.district || point?.district || "",
    address: place?.address || point?.address || "",
    coordinateSource:
      visit.coordinate_source ||
      place?.coordinate_precision ||
      region?.precision ||
      "",
    postIds: visit.post_ids || [],
    food: (visit.food_ids || []).map(compactEntity).filter(Boolean),
    confidence: visit.confidence,
    confidenceLabel: confidenceLabel(visit.confidence),
    evidenceType: visit.evidence_type,
    locationPrecision: visit.location_precision,
    evidence: visit.evidence || [],
    contextNote:
      displayRole === "context" && role === "anchor"
        ? "这条记录提供同行背景，但没有发现明确的饮食内容。"
        : null,
  };
}

const publicPosts = Object.fromEntries(
  posts.map((post) => [post.id, compactPost(post)]),
);
const publicPlaces = Object.fromEntries(
  places.map((place) => [
    place.id,
    {
      id: place.id,
      name: place.canonical_name,
      type: place.place_type,
      address: place.address,
      province: place.province,
      city: place.city,
      district: place.district,
      coordinates: place.coordinates,
      postIds: place.source_post_ids || [],
      qualityFlags: place.quality_flags || [],
    },
  ]),
);
const publicRegions = Object.fromEntries(
  regions.map((region) => [
    region.id,
    {
      id: region.id,
      name: region.name,
      province: region.province,
      city: region.city,
      district: region.district,
      center: region.center,
      precision: region.precision,
      postIds: region.source_post_ids || [],
    },
  ]),
);

const publicTrips = trips.map((trip) => {
  const mainVisits = trip.visit_ids
    .map((id) => compactVisit(visitMap.get(id), "anchor", trip.title))
    .filter(Boolean);
  const candidateVisits = candidates
    .filter((item) => item.trip_id === trip.id)
    .map((item) =>
      compactVisit(visitMap.get(item.visit_id), "candidate", trip.title),
    )
    .filter(Boolean);
  const regionVisits = trip.region_visit_ids
    .map((id) => compactVisit(visitMap.get(id), "region_only", trip.title))
    .filter(Boolean);
  const contextPoints = contexts
    .filter((item) => item.trip_id === trip.id && item.display_point)
    .map((item, index) => {
      const inferredAdmin =
        inferAdmin(
          item.display_point.longitude,
          item.display_point.latitude,
        ) ||
        inferAdminFromText(
          `${item.display_point.name || ""} ${trip.title}`,
        );
      return {
        id: `${trip.id}-context-${index}`,
        role: "context",
        name: item.display_point.name || "上下文位置",
        longitude: item.display_point.longitude,
        latitude: item.display_point.latitude,
        province: item.display_point.province || inferredAdmin?.province || "",
        city: item.display_point.city || inferredAdmin?.city || "",
        district: item.display_point.district || "",
        postIds: [item.post_id],
        relation: item.relation,
      };
    });
  return {
    id: trip.id,
    title: trip.title,
    subtitle: trip.subtitle,
    summary: trip.summary,
    kind: trip.trip_kind,
    startDate: trip.start_date,
    endDate: trip.end_date,
    datePrecision: trip.date_precision,
    regions: trip.region_labels,
    visitCount: trip.visit_ids.length,
    postCount: trip.post_ids.length,
    postIds: trip.post_ids,
    themeFoods: trip.theme_food_ids.map(compactEntity).filter(Boolean),
    confidence: trip.confidence,
    confidenceLabel: confidenceLabel(trip.confidence),
    uncertaintyNote: trip.uncertainty_note,
    highlights: trip.highlights,
    visits: [
      ...mainVisits,
      ...regionVisits,
      ...candidateVisits,
      ...contextPoints,
    ],
  };
});

const facetBuckets = new Map();
for (const post of posts) {
  for (const label of collectAnalysis(post).labels) {
    if (label.confidence < 0.75) continue;
    const key = `${label.type}:${label.name.trim()}`;
    const current = facetBuckets.get(key) || {
      id: key,
      type: label.type,
      name: label.name.trim(),
      count: 0,
      mappingMethod: "受控原标签精确映射",
    };
    current.count += 1;
    facetBuckets.set(key, current);
  }
}

const facets = [...facetBuckets.values()]
  .sort((a, b) => b.count - a.count)
  .filter(
    (item, index, all) => all.findIndex((x) => x.type === item.type) <= index,
  )
  .slice(0, 240);

const years = [
  ...new Set(publicTrips.map((trip) => new Date(trip.startDate).getFullYear())),
].sort();
const postDates = posts
  .map((post) => post.created_at)
  .filter(Boolean)
  .sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
const atlas = {
  manifest: {
    version: "2026年7月封版",
    generatedAt: "2026-07-24",
    coverageStart: postDates[0] || "2010-10-06",
    coverageEnd: postDates.at(-1) || "2026-07-24",
    counts: {
      posts: posts.length,
      trips: trips.length,
      visits: visits.length,
      places: places.length,
      cities: new Set(places.map((place) => place.city).filter(Boolean)).size,
    },
    years,
  },
  trips: publicTrips,
  posts: publicPosts,
  places: publicPlaces,
  regions: publicRegions,
  entities: entities.map(compactEntity).filter(Boolean),
  facets,
};

function geometryBounds(geometry) {
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  function visit(value) {
    if (
      Array.isArray(value) &&
      value.length >= 2 &&
      typeof value[0] === "number" &&
      typeof value[1] === "number"
    ) {
      bounds[0] = Math.min(bounds[0], value[0]);
      bounds[1] = Math.min(bounds[1], value[1]);
      bounds[2] = Math.max(bounds[2], value[0]);
      bounds[3] = Math.max(bounds[3], value[1]);
      return;
    }
    if (Array.isArray(value)) value.forEach(visit);
  }
  if (geometry?.coordinates) visit(geometry.coordinates);
  return bounds;
}

function compactMapFeature(feature, level) {
  return {
    name: feature.properties?.["地名"] || feature.properties?.name || "",
    level,
    geometry: feature.geometry,
  };
}

const usedProvinces = new Set(
  publicTrips.flatMap((trip) =>
    trip.visits.map((visit) => visit.province).filter(Boolean),
  ),
);
const usedCities = new Set(
  publicTrips.flatMap((trip) =>
    trip.visits.map((visit) => visit.city).filter(Boolean),
  ),
);
const usedDistricts = new Set(
  publicTrips.flatMap((trip) =>
    trip.visits.map((visit) => visit.district).filter(Boolean),
  ),
);
const riverGeoJson = JSON.parse(
  readFileSync(
    path.resolve(
      process.cwd(),
      "scripts",
      "vendor",
      "ne_50m_rivers_lake_centerlines.json",
    ),
    "utf8",
  ),
);
const municipalityFeatures = [
  "北京市.json",
  "上海市.json",
  "天津市.json",
  "重庆市.json",
].flatMap((file) => {
  const collection = JSON.parse(
    readFileSync(
      path.resolve(
        process.cwd(),
        "scripts",
        "vendor",
        "municipalities",
        file,
      ),
      "utf8",
    ),
  );
  return collection.features;
});
const chinaBounds = [72, 17, 136, 55];
const intersectsChina = (feature) => {
  const bounds = geometryBounds(feature.geometry);
  return !(
    bounds[2] < chinaBounds[0] ||
    bounds[0] > chinaBounds[2] ||
    bounds[3] < chinaBounds[1] ||
    bounds[1] > chinaBounds[3]
  );
};
const basemap = {
  source:
    "行政区划：cn-atlas 2023；河流：Natural Earth 1:50m（CC0）",
  features: [
    ...provinceGeoJson.features
      .filter((feature) => usedProvinces.has(feature.properties?.["地名"]))
      .map((feature) => compactMapFeature(feature, "province")),
    ...prefectureGeoJson.features
      .filter((feature) => usedCities.has(feature.properties?.["地名"]))
      .map((feature) => compactMapFeature(feature, "city")),
    ...municipalityFeatures
      .filter((feature) => usedDistricts.has(feature.properties?.name))
      .map((feature) => compactMapFeature(feature, "district")),
  ],
  rivers: riverGeoJson.features
    .filter(
      (feature) =>
        feature.geometry &&
        feature.properties?.scalerank <= 6 &&
        intersectsChina(feature),
    )
    .map((feature) => ({
      name: feature.properties?.name || "",
      geometry: feature.geometry,
    })),
};

await mkdir(outputDir, { recursive: true });
await writeFile(
  path.join(outputDir, "atlas.json"),
  JSON.stringify(atlas),
  "utf8",
);
await writeFile(
  path.join(outputDir, "china-basemap.json"),
  JSON.stringify(basemap),
  "utf8",
);
console.log(
  `Public projection built: ${publicTrips.length} trips, ${Object.keys(publicPosts).length} posts`,
);
