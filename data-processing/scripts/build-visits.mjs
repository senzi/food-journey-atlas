#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const BLOCKED_LOCATION_METHODS = new Set([
  "temporal_neighbor",
  "ip_region_centroid",
  "global_default",
]);
const PRECISE_LOCATION_METHODS = new Set([
  "amap_deterministic",
  "amap_with_llm_disambiguation",
  "amap_multiple_candidates",
  "explicit_location_amap",
  "source_geo",
]);
const VISIT_ASSERTIONS = new Set(["visited", "likely_visited"]);
const METHOD_WEIGHTS = {
  amap_deterministic: 0.96,
  amap_with_llm_disambiguation: 0.92,
  explicit_location_amap: 0.88,
  amap_multiple_candidates: 0.68,
  source_geo: 0.78,
  explicit_region_geocode: 0.65,
};

function parseArgs(argv) {
  const options = {
    input: "data-processing/data/vlm_results_v2_with_poi_mentions_v1.jsonl",
    assertions: "data-processing/data/analysis/visit_assertion_llm_v1/results.jsonl",
    visits: "data-processing/data/visits_v1.jsonl",
    places: "data-processing/data/places_v1.jsonl",
    regions: "data-processing/data/regions_v1.jsonl",
    roles: "data-processing/data/journey_post_roles_v1.jsonl",
    analysis: "data-processing/data/analysis/visits_v1",
    mergeHours: 12,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") options.input = argv[++index];
    else if (arg === "--assertions") options.assertions = argv[++index];
    else if (arg === "--visits") options.visits = argv[++index];
    else if (arg === "--places") options.places = argv[++index];
    else if (arg === "--regions") options.regions = argv[++index];
    else if (arg === "--roles") options.roles = argv[++index];
    else if (arg === "--analysis") options.analysis = argv[++index];
    else if (arg === "--merge-hours") options.mergeHours = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(options.mergeHours) || options.mergeHours < 0 || options.mergeHours > 48) {
    throw new Error("--merge-hours must be from 0 to 48");
  }
  return options;
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

async function writeAtomic(filePath, content) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.promises.writeFile(temporaryPath, content, "utf8");
  await fs.promises.rename(temporaryPath, filePath);
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function stableId(prefix, value) {
  return `${prefix}_${sha256(value).slice(0, 20)}`;
}

function pointGroupMap(points) {
  const groups = new Map();
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const groupId = point.source_request_id || `ungrouped_${index}`;
    if (!groups.has(groupId)) groups.set(groupId, []);
    groups.get(groupId).push({ point_index: index, point });
  }
  return groups;
}

function placeIdForPoint(point) {
  if (point.poi_id) return `place_amap_${point.poi_id}`;
  return stableId("place_local", [
    point.name,
    point.address,
    point.location,
    point.type,
  ].join("\0"));
}

function regionKeyForPoint(point) {
  return [
    point.pcode ?? "",
    point.adcode ?? "",
    point.province ?? "",
    point.city ?? "",
    point.district ?? "",
    point.name ?? "",
  ].join("\0");
}

function regionIdForPoint(point) {
  return stableId("region", regionKeyForPoint(point));
}

function compactPoint(point, pointIndex) {
  return {
    point_index: pointIndex,
    place_id: placeIdForPoint(point),
    external_provider: point.poi_id ? "amap" : null,
    external_poi_id: point.poi_id ?? null,
    name: point.name ?? "",
    longitude: Number(point.longitude),
    latitude: Number(point.latitude),
    location: point.location,
    address: point.address ?? "",
    province: point.province ?? "",
    city: point.city ?? "",
    district: point.district ?? "",
    type: point.type ?? "",
    typecode: point.typecode ?? null,
    coordinate_status: point.coordinate_status ?? "",
    is_fallback: Boolean(point.is_fallback),
    source_request_id: point.source_request_id ?? null,
  };
}

function locationPrecision(method, point, candidateCount) {
  if (method === "explicit_region_geocode") return "region";
  if (candidateCount > 1) return "candidate_set";
  if (method === "source_geo") return "source_coordinate";
  if (point?.poi_id) return "poi";
  if (/address/i.test(point?.type ?? "") || /address/i.test(point?.coordinate_status ?? "")) {
    return "address";
  }
  return "point";
}

function registerPlace(placeCatalog, compact) {
  const existing = placeCatalog.get(compact.place_id);
  if (!existing) {
    placeCatalog.set(compact.place_id, {
      id: compact.place_id,
      canonical_name: compact.name,
      place_type: compact.type,
      coordinates: {
        longitude: compact.longitude,
        latitude: compact.latitude,
      },
      coordinate_precision: compact.coordinate_status,
      address: compact.address,
      province: compact.province,
      city: compact.city,
      district: compact.district,
      external_provider: compact.external_provider,
      external_poi_id: compact.external_poi_id,
      source_post_ids: new Set(),
      quality_flags: new Set(),
    });
  }
  return placeCatalog.get(compact.place_id);
}

function registerRegion(regionCatalog, point) {
  const id = regionIdForPoint(point);
  if (!regionCatalog.has(id)) {
    regionCatalog.set(id, {
      id,
      name: point.name || point.district || point.city || point.province,
      province: point.province ?? "",
      city: point.city ?? "",
      district: point.district ?? "",
      center: {
        longitude: Number(point.longitude),
        latitude: Number(point.latitude),
      },
      precision: "region_centroid",
      source_post_ids: new Set(),
    });
  }
  return regionCatalog.get(id);
}

function chooseGroups(row, result) {
  const assertion = result.assertion;
  const groups = pointGroupMap(row.poi_resolution?.points ?? []);
  const selected = [];
  for (const decision of assertion.point_groups ?? []) {
    if (!["visit_place", "supporting_location"].includes(decision.role)) continue;
    const sourceGroup = groups.get(decision.group_id);
    if (!sourceGroup) continue;
    const allowedIndexes = new Set(sourceGroup.map((entry) => entry.point_index));
    const indexes = (decision.selected_point_indexes ?? []).filter((index) =>
      allowedIndexes.has(index)
    );
    if (indexes.length === 0) continue;
    selected.push({ decision, indexes });
  }
  const visitGroups = selected.filter((item) => item.decision.role === "visit_place");
  if (visitGroups.length) return visitGroups;
  if (
    ["explicit_location_amap", "explicit_region_geocode"].includes(row.poi_resolution?.method)
  ) {
    return selected.filter((item) => item.decision.role === "supporting_location");
  }
  return [];
}

function buildRawVisits(rows, assertionByPostId) {
  const rawVisits = [];
  const roleRows = [];
  const placeCatalog = new Map();
  const regionCatalog = new Map();
  const metrics = {
    invalid_assertion_posts: 0,
    visited_assertion_posts: 0,
    visited_without_usable_location: 0,
    blocked_fallback_posts: 0,
  };
  for (const row of rows) {
    const postId = String(row.id ?? row.mid);
    const result = assertionByPostId.get(postId);
    const valid = Boolean(result?.validation?.valid);
    if (!valid) metrics.invalid_assertion_posts += 1;
    const assertion = valid ? result.assertion : null;
    const isVisitAssertion = assertion && VISIT_ASSERTIONS.has(assertion.visit_assertion);
    if (isVisitAssertion) metrics.visited_assertion_posts += 1;
    const method = row.poi_resolution?.method;
    const blocked = BLOCKED_LOCATION_METHODS.has(method);
    if (blocked && isVisitAssertion) metrics.blocked_fallback_posts += 1;
    const selectedGroups = valid && isVisitAssertion && !blocked
      ? chooseGroups(row, result)
      : [];
    const postVisitIndexes = [];
    for (const group of selectedGroups) {
      const selectedPoints = group.indexes
        .map((pointIndex) => ({
          pointIndex,
          point: row.poi_resolution.points[pointIndex],
        }))
        .filter((entry) =>
          Number.isFinite(Number(entry.point?.longitude))
          && Number.isFinite(Number(entry.point?.latitude))
        );
      if (!selectedPoints.length) continue;
      const isRegion = method === "explicit_region_geocode";
      const compactPoints = selectedPoints.map(({ point, pointIndex }) =>
        compactPoint(point, pointIndex)
      );
      for (const compact of compactPoints) {
        const place = registerPlace(placeCatalog, compact);
        place.source_post_ids.add(postId);
      }
      let regionId = null;
      if (isRegion) {
        const region = registerRegion(regionCatalog, selectedPoints[0].point);
        region.source_post_ids.add(postId);
        regionId = region.id;
      }
      const candidateSet = group.decision.selection_status === "candidate_set"
        || compactPoints.length > 1;
      const precision = locationPrecision(method, selectedPoints[0].point, compactPoints.length);
      const assertionConfidence = Number(assertion.confidence ?? 0);
      const groupConfidence = Number(group.decision.confidence ?? 0);
      const methodWeight = METHOD_WEIGHTS[method] ?? 0.5;
      const confidence = Number(
        Math.min(assertionConfidence, groupConfidence, methodWeight).toFixed(4)
      );
      let routeEligibility = "candidate";
      if (isRegion) routeEligibility = "region_only";
      else if (!candidateSet && PRECISE_LOCATION_METHODS.has(method) && confidence >= 0.7) {
        routeEligibility = "anchor";
      }
      const locationKey = isRegion
        ? regionId
        : candidateSet
          ? compactPoints.map((point) => point.place_id).sort().join("|")
          : compactPoints[0].place_id;
      const foodIds = [...new Set((row.mentions ?? [])
        .filter((mention) => ["dish", "cuisine"].includes(mention.entity_type))
        .map((mention) => mention.entity_id))];
      const rawVisit = {
        id: null,
        location_key: locationKey,
        place_id: !isRegion && !candidateSet ? compactPoints[0].place_id : null,
        place_candidate_ids: !isRegion && candidateSet
          ? compactPoints.map((point) => point.place_id)
          : [],
        region_id: regionId,
        visited_at_start: row.created_at,
        visited_at_end: row.created_at,
        time_precision: "post_timestamp_proxy",
        actual_visit_time_confirmed: false,
        sequence: null,
        sequence_status: "pending_trip_assignment",
        post_ids: [postId],
        media_ids: (row.vlm_analysis ?? []).map((media) => `${postId}:${media.pic_index}`),
        food_ids: foodIds,
        trip_id: null,
        evidence_type: `${method}+visit_assertion_llm`,
        visit_assertion: assertion.visit_assertion,
        assertion_confidence: assertionConfidence,
        time_relation: assertion.time_relation,
        confidence,
        route_eligibility: routeEligibility,
        membership_status: candidateSet ? "candidate_location" : "eligible",
        location_precision: precision,
        coordinate_source: method,
        points: compactPoints,
        evidence: group.decision.evidence ? [{
          post_id: postId,
          quote: group.decision.evidence,
        }] : [],
        quality_flags: [
          ...(candidateSet ? ["ambiguous_place_candidates"] : []),
          ...(isRegion ? ["region_level_only"] : []),
          ...(!["contemporaneous", "recent_relative"].includes(assertion.time_relation)
            ? ["visit_time_uses_post_timestamp"] : []),
        ],
      };
      postVisitIndexes.push(rawVisits.length);
      rawVisits.push(rawVisit);
    }
    if (isVisitAssertion && selectedGroups.length === 0) {
      metrics.visited_without_usable_location += 1;
    }
    let journeyRole = "search_only";
    if (postVisitIndexes.some((index) => rawVisits[index].route_eligibility === "anchor")) {
      journeyRole = "visit_anchor";
    } else if (postVisitIndexes.some((index) => rawVisits[index].route_eligibility === "region_only")) {
      journeyRole = "region_visit";
    } else if (isVisitAssertion) {
      journeyRole = "trip_context";
    }
    roleRows.push({
      post_id: postId,
      journey_role: journeyRole,
      visit_assertion: assertion?.visit_assertion ?? "unvalidated",
      assertion_confidence: assertion?.confidence ?? 0,
      time_relation: assertion?.time_relation ?? "unknown",
      coordinate_method: method,
      visit_ids: [],
      reason: assertion?.reason ?? "LLM assertion did not pass validation",
    });
  }
  return { rawVisits, roleRows, placeCatalog, regionCatalog, metrics };
}

function mergeRawVisits(rawVisits, mergeHours) {
  const thresholdMs = mergeHours * 3600 * 1000;
  const byLocation = new Map();
  for (const visit of rawVisits) {
    if (!byLocation.has(visit.location_key)) byLocation.set(visit.location_key, []);
    byLocation.get(visit.location_key).push(visit);
  }
  const merged = [];
  for (const visits of byLocation.values()) {
    visits.sort((a, b) => new Date(a.visited_at_start) - new Date(b.visited_at_start));
    let current = null;
    for (const visit of visits) {
      if (
        current
        && new Date(visit.visited_at_start) - new Date(current.visited_at_end) <= thresholdMs
        && visit.route_eligibility === current.route_eligibility
      ) {
        current.visited_at_end = visit.visited_at_end;
        current.post_ids.push(...visit.post_ids);
        current.media_ids.push(...visit.media_ids);
        current.food_ids.push(...visit.food_ids);
        current.evidence.push(...visit.evidence);
        current.confidence = Math.max(current.confidence, visit.confidence);
        current.assertion_confidence = Math.max(
          current.assertion_confidence,
          visit.assertion_confidence,
        );
        current.quality_flags.push("merged_same_place_near_time");
      } else {
        if (current) merged.push(current);
        current = structuredClone(visit);
      }
    }
    if (current) merged.push(current);
  }
  for (const visit of merged) {
    visit.post_ids = [...new Set(visit.post_ids)].sort();
    visit.media_ids = [...new Set(visit.media_ids)].sort();
    visit.food_ids = [...new Set(visit.food_ids)].sort();
    visit.quality_flags = [...new Set(visit.quality_flags)].sort();
    visit.id = stableId("visit", [
      visit.location_key,
      visit.visited_at_start,
      visit.post_ids.join("|"),
    ].join("\0"));
    delete visit.location_key;
  }
  return merged.sort((a, b) =>
    new Date(a.visited_at_start) - new Date(b.visited_at_start)
    || a.id.localeCompare(b.id)
  );
}

function finalizeCatalog(catalog) {
  return [...catalog.values()].map((item) => ({
    ...item,
    source_post_ids: [...item.source_post_ids].sort(),
    ...(item.quality_flags
      ? { quality_flags: [...item.quality_flags].sort() }
      : {}),
  })).sort((a, b) => a.id.localeCompare(b.id));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(options.input);
  const [inputText, rows, assertionRows] = await Promise.all([
    fs.promises.readFile(inputPath, "utf8"),
    Promise.resolve(readJsonl(inputPath)),
    Promise.resolve(readJsonl(path.resolve(options.assertions))),
  ]);
  const assertionByPostId = new Map(assertionRows.map((result) => [
    String(result.post_id),
    result,
  ]));
  const built = buildRawVisits(rows, assertionByPostId);
  const visits = mergeRawVisits(built.rawVisits, options.mergeHours);
  const visitIdsByPost = new Map();
  for (const visit of visits) {
    for (const postId of visit.post_ids) {
      if (!visitIdsByPost.has(postId)) visitIdsByPost.set(postId, []);
      visitIdsByPost.get(postId).push(visit.id);
    }
  }
  for (const role of built.roleRows) {
    role.visit_ids = (visitIdsByPost.get(role.post_id) ?? []).sort();
  }
  const places = finalizeCatalog(built.placeCatalog);
  const regions = finalizeCatalog(built.regionCatalog);
  const toJsonl = (items) => items.length
    ? `${items.map((item) => JSON.stringify(item)).join("\n")}\n`
    : "";
  const visitText = toJsonl(visits);
  const placeText = toJsonl(places);
  const regionText = toJsonl(regions);
  const roleText = toJsonl(built.roleRows);
  const counts = {
    route_anchor: visits.filter((visit) => visit.route_eligibility === "anchor").length,
    region_only: visits.filter((visit) => visit.route_eligibility === "region_only").length,
    candidate: visits.filter((visit) => visit.route_eligibility === "candidate").length,
  };
  const journeyRoleCounts = Object.fromEntries([
    "visit_anchor",
    "region_visit",
    "trip_context",
    "search_only",
  ].map((role) => [
    role,
    built.roleRows.filter((item) => item.journey_role === role).length,
  ]));
  const summary = {
    version: "visits_v1",
    generated_at: new Date().toISOString(),
    input_file: inputPath,
    input_sha256: sha256(inputText),
    assertion_file: path.resolve(options.assertions),
    post_count: rows.length,
    raw_visit_count: built.rawVisits.length,
    merged_visit_count: visits.length,
    merge_hours: options.mergeHours,
    route_eligibility_counts: counts,
    journey_role_counts: journeyRoleCounts,
    place_count: places.length,
    region_count: regions.length,
    ...built.metrics,
    visits_sha256: sha256(visitText),
    places_sha256: sha256(placeText),
    regions_sha256: sha256(regionText),
    roles_sha256: sha256(roleText),
  };
  const report = `# Visits v1 运行报告

- 输入微博：${rows.length}
- LLM 判定为 visited / likely_visited：${built.metrics.visited_assertion_posts}
- 原始 Visit：${built.rawVisits.length}
- 合并后 Visit：${visits.length}
- 路线锚点：${counts.route_anchor}
- 城市/地区级 Visit：${counts.region_only}
- 分店或地点候选 Visit：${counts.candidate}
- 有到访行为但无可用地点：${built.metrics.visited_without_usable_location}
- 被禁止使用的展示保底点：${built.metrics.blocked_fallback_posts}

## Post 角色

- visit_anchor：${journeyRoleCounts.visit_anchor}
- region_visit：${journeyRoleCounts.region_visit}
- trip_context：${journeyRoleCounts.trip_context}
- search_only：${journeyRoleCounts.search_only}

## 强制边界

- temporal_neighbor、IP 属地和 global_default 不生成路线 Visit。
- 分店未消歧时保留 place_candidate_ids，不选一个伪精确分店。
- 城市级中心点只生成 region_only Visit，不参与精确距离聚类。
- 时间统一标为 post_timestamp_proxy，不把发帖时间伪装成准确到店时间。
`;
  await Promise.all([
    writeAtomic(path.resolve(options.visits), visitText),
    writeAtomic(path.resolve(options.places), placeText),
    writeAtomic(path.resolve(options.regions), regionText),
    writeAtomic(path.resolve(options.roles), roleText),
    writeAtomic(path.join(path.resolve(options.analysis), "summary.json"), `${JSON.stringify(summary, null, 2)}\n`),
    writeAtomic(path.join(path.resolve(options.analysis), "RUN_REPORT.md"), report),
  ]);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
