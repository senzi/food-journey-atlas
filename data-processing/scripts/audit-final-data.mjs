#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const FILES = {
  source: "data-processing/data/vlm_results_v2_repaired_v2.jsonl",
  poi: "data-processing/data/vlm_results_v2_with_poi_v5.jsonl",
  posts: "data-processing/data/vlm_results_v2_with_poi_mentions_v1.jsonl",
  entities: "data-processing/data/entities_v1.jsonl",
  places: "data-processing/data/places_v1.jsonl",
  regions: "data-processing/data/regions_v1.jsonl",
  visits: "data-processing/data/visits_with_trips_v1.jsonl",
  roles: "data-processing/data/journey_post_roles_v1.jsonl",
  trips: "data-processing/data/trips_with_narratives_v2.jsonl",
  candidates: "data-processing/data/trip_membership_candidates_v1.jsonl",
  contexts: "data-processing/data/trip_context_refs_v1.jsonl",
  narratives: "data-processing/data/trip_narratives_v2.jsonl",
};

function readJsonl(filePath) {
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function haversineKm(left, right) {
  const radius = 6371.0088;
  const toRadians = (degrees) => degrees * Math.PI / 180;
  const latitude1 = toRadians(Number(left.latitude));
  const latitude2 = toRadians(Number(right.latitude));
  const deltaLatitude = latitude2 - latitude1;
  const deltaLongitude = toRadians(Number(right.longitude) - Number(left.longitude));
  const value = Math.sin(deltaLatitude / 2) ** 2
    + Math.cos(latitude1) * Math.cos(latitude2)
    * Math.sin(deltaLongitude / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(value)));
}

function increment(object, key, value = 1) {
  object[key] = (object[key] ?? 0) + value;
}

function unique(values) {
  return [...new Set(values)];
}

async function writeAtomic(filePath, content) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.promises.writeFile(temporaryPath, content, "utf8");
  await fs.promises.rename(temporaryPath, filePath);
}

async function main() {
  const resolved = Object.fromEntries(Object.entries(FILES).map(([key, value]) => [
    key,
    path.resolve(value),
  ]));
  const data = Object.fromEntries(Object.entries(resolved).map(([key, value]) => [
    key,
    readJsonl(value),
  ]));
  const errors = [];
  const warnings = [];
  const checks = {};
  const check = (name, condition, detail = "") => {
    checks[name] = { passed: Boolean(condition), detail };
    if (!condition) errors.push(`${name}: ${detail}`);
  };

  check("post_row_counts_equal",
    data.source.length === data.poi.length && data.poi.length === data.posts.length,
    `${data.source.length}/${data.poi.length}/${data.posts.length}`);
  let poiPreserved = true;
  let sourcePreserved = true;
  let mentionSlicesValid = true;
  let mentionOverlapFree = true;
  const postIds = new Set();
  const entityIds = new Set(data.entities.map((entity) => entity.entity_id));
  const mentionIds = new Set();
  const mentionTypeCounts = {};
  const restaurantLinkCounts = {};
  let postsWithMentions = 0;
  let imageUrlCount = 0;
  for (let index = 0; index < data.posts.length; index += 1) {
    const post = data.posts[index];
    const poi = structuredClone(post);
    delete poi.mentions;
    delete poi.mention_extraction;
    if (!deepEqual(poi, data.poi[index])) poiPreserved = false;
    const source = structuredClone(data.poi[index]);
    delete source.poi_resolution;
    if (!deepEqual(source, data.source[index])) sourcePreserved = false;
    const postId = String(post.id ?? post.mid);
    if (postIds.has(postId)) errors.push(`duplicate post_id ${postId}`);
    postIds.add(postId);
    if ((post.pics ?? []).some((url) => /^https?:\/\//.test(url))) {
      imageUrlCount += (post.pics ?? []).filter((url) => /^https?:\/\//.test(url)).length;
    }
    if (post.mentions?.length) postsWithMentions += 1;
    let previousEnd = -1;
    for (const mention of post.mentions ?? []) {
      if (post.content.slice(mention.start, mention.end) !== mention.text) mentionSlicesValid = false;
      if (mention.start < previousEnd) mentionOverlapFree = false;
      previousEnd = mention.end;
      if (!entityIds.has(mention.entity_id)) errors.push(`unknown mention entity ${mention.entity_id}`);
      if (mentionIds.has(mention.mention_id)) errors.push(`duplicate mention ${mention.mention_id}`);
      mentionIds.add(mention.mention_id);
      increment(mentionTypeCounts, mention.entity_type);
      if (mention.entity_type === "restaurant") increment(restaurantLinkCounts, mention.link_status);
    }
  }
  check("source_values_preserved", sourcePreserved, "POI v5 minus poi_resolution equals repaired v2");
  check("poi_values_preserved", poiPreserved, "mentions v1 minus mention fields equals POI v5");
  check("unique_post_ids", postIds.size === data.posts.length, `${postIds.size}`);
  check("mention_slices_valid", mentionSlicesValid, `${mentionIds.size} mentions`);
  check("mention_overlap_free", mentionOverlapFree, `${mentionIds.size} mentions`);

  const placeIds = new Set();
  let invalidPlaceCoordinateCount = 0;
  for (const place of data.places) {
    if (placeIds.has(place.id)) errors.push(`duplicate place ${place.id}`);
    placeIds.add(place.id);
    const longitude = Number(place.coordinates?.longitude);
    const latitude = Number(place.coordinates?.latitude);
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)
      || longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
      invalidPlaceCoordinateCount += 1;
    }
    for (const postId of place.source_post_ids ?? []) {
      if (!postIds.has(postId)) errors.push(`unknown place source post ${postId}`);
    }
  }
  check("place_coordinates_valid", invalidPlaceCoordinateCount === 0,
    `${invalidPlaceCoordinateCount} invalid`);

  const regionIds = new Set();
  for (const region of data.regions) {
    if (regionIds.has(region.id)) errors.push(`duplicate region ${region.id}`);
    regionIds.add(region.id);
  }

  const visitIds = new Set();
  const visitById = new Map();
  const visitEligibilityCounts = {};
  const coordinateSourceCounts = {};
  let visitReferencesValid = true;
  let visitTimesValid = true;
  let forbiddenFallbackAnchors = 0;
  let sourceGeoAnchors = 0;
  for (const visit of data.visits) {
    if (visitIds.has(visit.id)) errors.push(`duplicate visit ${visit.id}`);
    visitIds.add(visit.id);
    visitById.set(visit.id, visit);
    increment(visitEligibilityCounts, visit.route_eligibility);
    increment(coordinateSourceCounts, visit.coordinate_source);
    if (new Date(visit.visited_at_start) > new Date(visit.visited_at_end)) visitTimesValid = false;
    if (!visit.post_ids?.length) visitReferencesValid = false;
    for (const postId of visit.post_ids ?? []) if (!postIds.has(postId)) visitReferencesValid = false;
    if (visit.place_id && !placeIds.has(visit.place_id)) visitReferencesValid = false;
    for (const placeId of visit.place_candidate_ids ?? []) {
      if (!placeIds.has(placeId)) visitReferencesValid = false;
    }
    if (visit.region_id && !regionIds.has(visit.region_id)) visitReferencesValid = false;
    if (visit.route_eligibility === "anchor") {
      if (["temporal_neighbor", "ip_region_centroid", "global_default"].includes(
        visit.coordinate_source
      )) forbiddenFallbackAnchors += 1;
      if (visit.coordinate_source === "source_geo") sourceGeoAnchors += 1;
    }
  }
  check("unique_visit_ids", visitIds.size === data.visits.length, `${visitIds.size}`);
  check("visit_references_valid", visitReferencesValid, `${data.visits.length} visits`);
  check("visit_times_valid", visitTimesValid, `${data.visits.length} visits`);
  check("no_forbidden_fallback_route_anchors", forbiddenFallbackAnchors === 0,
    `${forbiddenFallbackAnchors}`);

  const rolePostIds = new Set();
  const roleCounts = {};
  let roleReferencesValid = true;
  for (const role of data.roles) {
    rolePostIds.add(role.post_id);
    increment(roleCounts, role.journey_role);
    if (!postIds.has(role.post_id)) roleReferencesValid = false;
    for (const visitId of role.visit_ids ?? []) if (!visitIds.has(visitId)) roleReferencesValid = false;
  }
  check("roles_cover_all_posts",
    rolePostIds.size === postIds.size && data.roles.length === data.posts.length,
    `${rolePostIds.size}/${postIds.size}`);
  check("role_references_valid", roleReferencesValid, `${data.roles.length} roles`);

  const tripIds = new Set();
  const mainVisitMembership = new Map();
  const tripKindCounts = {};
  const titleCounts = {};
  let tripReferencesValid = true;
  let tripTimesValid = true;
  let tripRoutesValid = true;
  let narrativeIdsValid = true;
  let maxTripDurationDays = 0;
  let maxTripVisitCount = 0;
  let longRouteEdgeCount = 0;
  let veryLongRouteEdgeCount = 0;
  const suspiciousEdges = [];
  for (const trip of data.trips) {
    if (tripIds.has(trip.id)) errors.push(`duplicate trip ${trip.id}`);
    tripIds.add(trip.id);
    increment(tripKindCounts, trip.trip_kind);
    increment(titleCounts, trip.title);
    if (new Date(trip.start_date) > new Date(trip.end_date)) tripTimesValid = false;
    const duration = (new Date(trip.end_date) - new Date(trip.start_date)) / 86_400_000;
    maxTripDurationDays = Math.max(maxTripDurationDays, duration);
    maxTripVisitCount = Math.max(maxTripVisitCount, trip.visit_ids.length);
    if (trip.visit_ids.length < 2 || trip.route.length !== trip.visit_ids.length) {
      tripRoutesValid = false;
    }
    const allowedVisits = new Set(trip.visit_ids);
    const allowedThemes = new Set(trip.theme_food_ids ?? []);
    for (let index = 0; index < trip.visit_ids.length; index += 1) {
      const visitId = trip.visit_ids[index];
      const visit = visitById.get(visitId);
      if (!visit || visit.route_eligibility !== "anchor") tripReferencesValid = false;
      if (mainVisitMembership.has(visitId)) tripReferencesValid = false;
      mainVisitMembership.set(visitId, trip.id);
      if (trip.route[index]?.visit_id !== visitId) tripRoutesValid = false;
      if (index > 0) {
        const previous = trip.route[index - 1];
        const current = trip.route[index];
        const distance = haversineKm(previous, current);
        if (distance > 500) longRouteEdgeCount += 1;
        if (distance > 1500) veryLongRouteEdgeCount += 1;
        if (distance > 500) {
          suspiciousEdges.push({
            trip_id: trip.id,
            title: trip.title,
            from_visit_id: previous.visit_id,
            to_visit_id: current.visit_id,
            distance_km: Number(distance.toFixed(2)),
            gap_hours: Number(((new Date(current.time) - new Date(previous.time)) / 3_600_000).toFixed(2)),
          });
        }
      }
    }
    for (const postId of [...(trip.post_ids ?? []), ...(trip.context_post_ids ?? [])]) {
      if (!postIds.has(postId)) tripReferencesValid = false;
    }
    for (const highlight of trip.highlights ?? []) {
      if (!allowedVisits.has(highlight.visit_id)) narrativeIdsValid = false;
    }
    for (const entityId of trip.narrative_theme_entity_ids ?? []) {
      if (!allowedThemes.has(entityId) || !entityIds.has(entityId)) narrativeIdsValid = false;
    }
  }
  check("unique_trip_ids", tripIds.size === data.trips.length, `${tripIds.size}`);
  check("trip_references_valid", tripReferencesValid, `${data.trips.length} trips`);
  check("trip_times_valid", tripTimesValid, `${data.trips.length} trips`);
  check("trip_routes_valid", tripRoutesValid, `${mainVisitMembership.size} route visits`);
  check("narrative_ids_valid", narrativeIdsValid, `${data.narratives.length} narratives`);

  let secondaryReferencesValid = true;
  const candidateVisitTripPairs = new Set();
  for (const item of data.candidates) {
    if (!tripIds.has(item.trip_id) || !visitIds.has(item.visit_id)) secondaryReferencesValid = false;
    candidateVisitTripPairs.add(`${item.trip_id}\0${item.visit_id}`);
  }
  for (const item of data.contexts) {
    if (!tripIds.has(item.trip_id)) secondaryReferencesValid = false;
    if (item.post_id && !postIds.has(item.post_id)) secondaryReferencesValid = false;
    if (item.visit_id && !visitIds.has(item.visit_id)) secondaryReferencesValid = false;
    if (item.other_trip_id && !tripIds.has(item.other_trip_id)) secondaryReferencesValid = false;
  }
  check("secondary_references_valid", secondaryReferencesValid,
    `${data.candidates.length} candidate + ${data.contexts.length} context`);

  const narrativeTripIds = new Set(data.narratives.map((item) => item.trip_id));
  check("narratives_cover_all_trips",
    narrativeTripIds.size === tripIds.size
      && [...tripIds].every((id) => narrativeTripIds.has(id)),
    `${narrativeTripIds.size}/${tripIds.size}`);

  const duplicateTitleCount = Object.values(titleCounts).filter((count) => count > 1).length;
  const mainTripPosts = new Set(data.trips.flatMap((trip) => trip.post_ids));
  const visitPosts = new Set(data.visits.flatMap((visit) => visit.post_ids));
  const timeProxyVisitCount = data.visits.filter((visit) =>
    visit.time_precision === "post_timestamp_proxy"
  ).length;
  const candidateLocationVisitCount = data.visits.filter((visit) =>
    visit.membership_status === "candidate_location"
  ).length;
  const unmatchedRestaurantMentions = restaurantLinkCounts.unmatched ?? 0;
  const multipleRestaurantMentions = restaurantLinkCounts.multiple ?? 0;

  if (imageUrlCount > 0) {
    warnings.push(`${imageUrlCount} 个原始图片 URL 仍在内部 Post 数据中，不能直接发布到前端。`);
  }
  if (timeProxyVisitCount > 0) {
    warnings.push(`${timeProxyVisitCount} 个 Visit 的时间是微博发布时间代理，不是精确到店时间。`);
  }
  if (sourceGeoAnchors > 0) {
    warnings.push(`${sourceGeoAnchors} 个路线锚点来自未经逐点人工确认的 source_geo。`);
  }
  if (candidateLocationVisitCount > 0) {
    warnings.push(`${candidateLocationVisitCount} 个 Visit 保留了互斥地点候选，不能进入主路线。`);
  }
  if (unmatchedRestaurantMentions + multipleRestaurantMentions > 0) {
    warnings.push(`${unmatchedRestaurantMentions} 个餐厅 mention 未匹配，${multipleRestaurantMentions} 个为多候选。`);
  }
  if (longRouteEdgeCount > 0) {
    warnings.push(`${longRouteEdgeCount} 条 Trip 相邻点连线超过 500 km，其中 ${veryLongRouteEdgeCount} 条超过 1500 km；它们表示顺序连线，不是导航路线。`);
  }
  if (mainTripPosts.size / data.posts.length < 0.2) {
    warnings.push(`只有 ${mainTripPosts.size} 条微博进入主 Trip，覆盖率较低但符合保守门槛；搜索必须读取全部 Post。`);
  }

  const llmSummaries = {};
  const optionalSummaries = {
    entity_llm: "data-processing/data/analysis/text_entity_mentions_llm_v1/summary.json",
    visit_llm: "data-processing/data/analysis/visit_assertion_llm_v1/summary.json",
    trip_narrative_llm: "data-processing/data/analysis/trip_narratives_llm_v2/summary.json",
  };
  for (const [key, filePath] of Object.entries(optionalSummaries)) {
    if (fs.existsSync(filePath)) llmSummaries[key] = JSON.parse(fs.readFileSync(filePath, "utf8"));
  }

  const summary = {
    version: "final_data_audit_v1",
    generated_at: new Date().toISOString(),
    status: errors.length === 0 ? "passed_with_warnings" : "failed",
    errors,
    warnings,
    checks,
    hashes: Object.fromEntries(Object.entries(resolved).map(([key, filePath]) => [
      key,
      sha256File(filePath),
    ])),
    counts: {
      posts: data.posts.length,
      posts_with_mentions: postsWithMentions,
      mentions: mentionIds.size,
      entities: data.entities.length,
      places: data.places.length,
      regions: data.regions.length,
      visits: data.visits.length,
      visit_posts: visitPosts.size,
      trips: data.trips.length,
      main_route_visits: mainVisitMembership.size,
      main_trip_posts: mainTripPosts.size,
      candidate_memberships: data.candidates.length,
      context_refs: data.contexts.length,
      narratives: data.narratives.length,
      original_image_urls: imageUrlCount,
    },
    distributions: {
      mention_types: mentionTypeCounts,
      restaurant_link_status: restaurantLinkCounts,
      visit_eligibility: visitEligibilityCounts,
      coordinate_sources: coordinateSourceCounts,
      journey_roles: roleCounts,
      trip_kinds: tripKindCounts,
    },
    quality: {
      time_proxy_visit_count: timeProxyVisitCount,
      source_geo_anchor_count: sourceGeoAnchors,
      candidate_location_visit_count: candidateLocationVisitCount,
      long_route_edge_count: longRouteEdgeCount,
      very_long_route_edge_count: veryLongRouteEdgeCount,
      suspicious_route_edges: suspiciousEdges,
      duplicate_trip_title_count: duplicateTitleCount,
      max_trip_duration_days: Number(maxTripDurationDays.toFixed(3)),
      max_trip_visit_count: maxTripVisitCount,
    },
    llm_runs: llmSummaries,
  };

  const passCount = Object.values(checks).filter((item) => item.passed).length;
  const report = `# 最终数据完整审查 v1

## 结论

审查状态：**${summary.status}**

- 自动检查：${passCount}/${Object.keys(checks).length} 通过
- 阻断错误：${errors.length}
- 已知风险/发布提醒：${warnings.length}

## 核心规模

- Post：${summary.counts.posts}
- mentions：${summary.counts.mentions}，覆盖 ${summary.counts.posts_with_mentions} 条 Post
- Entity：${summary.counts.entities}
- Place / Region：${summary.counts.places} / ${summary.counts.regions}
- Visit：${summary.counts.visits}，关联 ${summary.counts.visit_posts} 条 Post
- Trip：${summary.counts.trips}
- 主路线 Visit / Post：${summary.counts.main_route_visits} / ${summary.counts.main_trip_posts}
- 候选附着 / 上下文关系：${summary.counts.candidate_memberships} / ${summary.counts.context_refs}
- Trip 叙事：${summary.counts.narratives}

## 完整性

${Object.entries(checks).map(([name, result]) =>
  `- ${result.passed ? "PASS" : "FAIL"} — ${name}${result.detail ? `：${result.detail}` : ""}`
).join("\n")}

## 已知风险

${warnings.map((warning) => `- ${warning}`).join("\n")}

## 路线长距离边

${suspiciousEdges.length
  ? suspiciousEdges.map((edge) =>
    `- ${edge.trip_id}（${edge.title}）：${edge.distance_km} km / ${edge.gap_hours} h`
  ).join("\n")
  : "- 无"}

## 发布判断

数据适合进入网页构建阶段，但不能把内部 Post JSONL 直接作为公开静态资源。网页构建前必须生成公开投影，移除原图 URL、模型原始响应、处理元数据和密钥，并保留置信度、来源类型与不确定性文案。
`;

  const outputPath = path.resolve("data-processing/data/analysis/final_data_audit_v1");
  await Promise.all([
    writeAtomic(path.join(outputPath, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`),
    writeAtomic(path.join(outputPath, "RUN_REPORT.md"), report),
  ]);
  console.log(JSON.stringify({
    status: summary.status,
    checks_passed: passCount,
    checks_total: Object.keys(checks).length,
    errors: errors.length,
    warnings: warnings.length,
    counts: summary.counts,
  }, null, 2));
  if (errors.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
