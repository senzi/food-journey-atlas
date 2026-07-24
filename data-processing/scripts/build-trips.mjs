#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const BALANCED_PARAMS = {
  near_km: 100,
  near_days: 5,
  travel_km: 2500,
  travel_days: 2,
  min_samples: 2,
};
const BEIJING_CENTER = { longitude: 116.4074, latitude: 39.9042 };

function readJsonl(filePath) {
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

async function writeAtomic(filePath, content) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.promises.writeFile(temporaryPath, content, "utf8");
  await fs.promises.rename(temporaryPath, filePath);
}

function stableId(prefix, value) {
  return `${prefix}_${crypto.createHash("sha256").update(value).digest("hex").slice(0, 20)}`;
}

function haversineKm(left, right) {
  const radius = 6371.0088;
  const toRadians = (degrees) => degrees * Math.PI / 180;
  const latitude1 = toRadians(left.latitude);
  const latitude2 = toRadians(right.latitude);
  const deltaLatitude = latitude2 - latitude1;
  const deltaLongitude = toRadians(right.longitude - left.longitude);
  const value = Math.sin(deltaLatitude / 2) ** 2
    + Math.cos(latitude1) * Math.cos(latitude2)
    * Math.sin(deltaLongitude / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(value)));
}

function visitCoordinate(visit) {
  if (!visit.points?.length) return null;
  return {
    longitude: Number(visit.points[0].longitude),
    latitude: Number(visit.points[0].latitude),
  };
}

function isHomeVisit(visit) {
  const point = visit.points?.[0];
  if (!point) return false;
  if ([point.province, point.city].some((value) => /北京/.test(value ?? ""))) return true;
  const coordinate = visitCoordinate(visit);
  return coordinate ? haversineKm(coordinate, BEIJING_CENTER) <= 120 : false;
}

function splitAtHomeBoundary(candidateVisits) {
  const visits = [...candidateVisits].sort((a, b) =>
    new Date(a.visited_at_start) - new Date(b.visited_at_start)
  );
  const segments = [];
  let current = [];
  for (const visit of visits) {
    if (!current.length) {
      current.push(visit);
      continue;
    }
    const previous = current.at(-1);
    const gapDays = (new Date(visit.visited_at_start) - new Date(previous.visited_at_start))
      / 86_400_000;
    const distance = haversineKm(visitCoordinate(previous), visitCoordinate(visit));
    const homeBoundary = isHomeVisit(previous) !== isHomeVisit(visit) && distance > 300;
    const durationFromStart = (new Date(visit.visited_at_start) - new Date(current[0].visited_at_start))
      / 86_400_000;
    if (homeBoundary || gapDays > 5 || durationFromStart > 14) {
      segments.push(current);
      current = [visit];
    } else {
      current.push(visit);
    }
  }
  if (current.length) segments.push(current);
  return segments;
}

function classifyTripKind(visits) {
  const homeCount = visits.filter(isHomeVisit).length;
  const hasLongDistanceTransition = visits.some((visit, index) =>
    index > 0
    && haversineKm(visitCoordinate(visits[index - 1]), visitCoordinate(visit)) > 300
  );
  const cities = new Set(visits.map((visit) =>
    visit.points[0].city || visit.points[0].district || visit.points[0].province
  ).filter(Boolean));
  const provinces = new Set(visits.map((visit) => visit.points[0].province).filter(Boolean));
  if (hasLongDistanceTransition) return "travel_route";
  if (homeCount === visits.length) return "local_sequence";
  if (cities.size <= 1 && provinces.size <= 1) return "destination_stay";
  return "travel_route";
}

function closestDistance(visit, anchors) {
  let closest = Infinity;
  for (const point of visit.points ?? []) {
    const coordinate = { longitude: Number(point.longitude), latitude: Number(point.latitude) };
    if (!Number.isFinite(coordinate.longitude) || !Number.isFinite(coordinate.latitude)) continue;
    for (const anchor of anchors) {
      closest = Math.min(closest, haversineKm(coordinate, visitCoordinate(anchor)));
    }
  }
  return closest;
}

function withinWindow(visit, trip, paddingDays = 1) {
  const timestamp = new Date(visit.visited_at_start).valueOf();
  return timestamp >= new Date(trip.start_date).valueOf() - paddingDays * 86_400_000
    && timestamp <= new Date(trip.end_date).valueOf() + paddingDays * 86_400_000;
}

function buildBaseTrips(candidates, visitById) {
  const trips = [];
  const discardedSegmentVisitIds = [];
  for (const candidate of candidates) {
    const candidateVisits = candidate.visit_ids.map((id) => visitById.get(id)).filter(Boolean);
    for (const segment of splitAtHomeBoundary(candidateVisits)) {
      if (segment.length < 2) {
        discardedSegmentVisitIds.push(...segment.map((visit) => visit.id));
        continue;
      }
      const sorted = [...segment].sort((a, b) =>
        new Date(a.visited_at_start) - new Date(b.visited_at_start)
      );
      const start = sorted[0].visited_at_start;
      const end = sorted.at(-1).visited_at_end;
      const visitIds = sorted.map((visit) => visit.id);
      const postIds = [...new Set(sorted.flatMap((visit) => visit.post_ids))];
      const foodCounts = new Map();
      for (const foodId of sorted.flatMap((visit) => visit.food_ids)) {
        foodCounts.set(foodId, (foodCounts.get(foodId) ?? 0) + 1);
      }
      const themeFoodIds = [...foodCounts]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 8)
        .map(([id]) => id);
      const regions = [...new Set(sorted.flatMap((visit) => visit.points.flatMap((point) =>
        [point.province, point.city, point.district].filter(Boolean)
      )))];
      const confidence = Number(
        (sorted.reduce((sum, visit) => sum + visit.confidence, 0) / sorted.length).toFixed(4)
      );
      const tripKind = classifyTripKind(sorted);
      const hasLongDistanceTransition = sorted.some((visit, index) =>
        index > 0
        && haversineKm(visitCoordinate(sorted[index - 1]), visitCoordinate(visit)) > 300
      );
      const id = stableId("trip", [start, end, visitIds.join("|")].join("\0"));
      trips.push({
        id,
        title: null,
        title_source: null,
        trip_kind: tripKind,
        start_date: start,
        end_date: end,
        date_precision: "post_timestamp_proxy",
        visit_ids: visitIds,
        route: sorted.map((visit, sequence) => ({
          sequence,
          visit_id: visit.id,
          longitude: visit.points[0].longitude,
          latitude: visit.points[0].latitude,
          time: visit.visited_at_start,
        })),
        candidate_visit_ids: [],
        region_visit_ids: [],
        post_ids: postIds,
        context_post_ids: [],
        region_labels: regions,
        theme_food_ids: themeFoodIds,
        summary: null,
        cluster_method: "st_dbscan_graph_v1+home_boundary_split_v1",
        cluster_params: BALANCED_PARAMS,
        confidence,
        quality_flags: [
          ...(tripKind === "local_sequence" ? ["system_grouped_local_sequence"] : []),
          ...(hasLongDistanceTransition ? ["long_distance_sequence_transition"] : []),
          "visit_time_uses_post_timestamp_proxy",
        ],
      });
    }
  }
  trips.sort((a, b) => new Date(a.start_date) - new Date(b.start_date));
  return { trips, discardedSegmentVisitIds };
}

function attachSecondaryVisits(trips, allVisits) {
  const membershipCandidates = [];
  for (const trip of trips) {
    const anchors = trip.visit_ids.map((id) => allVisits.find((visit) => visit.id === id));
    for (const visit of allVisits) {
      if (visit.route_eligibility === "anchor" || !withinWindow(visit, trip, 1)) continue;
      const distance = closestDistance(visit, anchors);
      if (visit.route_eligibility === "candidate" && distance <= 100) {
        trip.candidate_visit_ids.push(visit.id);
        membershipCandidates.push({
          trip_id: trip.id,
          visit_id: visit.id,
          map_role: "trip_candidate",
          relation: "time_and_space_near_route",
          distance_to_route_km: Number(distance.toFixed(2)),
          membership_status: "not_in_main_route",
        });
      } else if (visit.route_eligibility === "region_only" && distance <= 150) {
        trip.region_visit_ids.push(visit.id);
        membershipCandidates.push({
          trip_id: trip.id,
          visit_id: visit.id,
          map_role: "trip_candidate",
          relation: "region_level_time_match",
          distance_to_route_km: Number(distance.toFixed(2)),
          membership_status: "timeline_only",
        });
      }
    }
    trip.candidate_visit_ids = [...new Set(trip.candidate_visit_ids)];
    trip.region_visit_ids = [...new Set(trip.region_visit_ids)];
  }
  return membershipCandidates;
}

function attachContextPosts(trips, roleRows, postById) {
  const contextRefs = [];
  for (const trip of trips) {
    const anchorCoordinates = trip.route.map((item) => ({
      longitude: item.longitude,
      latitude: item.latitude,
    }));
    for (const role of roleRows) {
      if (role.journey_role !== "trip_context") continue;
      const post = postById.get(role.post_id);
      if (!post) continue;
      const timestamp = new Date(post.created_at).valueOf();
      if (
        timestamp < new Date(trip.start_date).valueOf() - 86_400_000
        || timestamp > new Date(trip.end_date).valueOf() + 86_400_000
      ) continue;
      if (post.poi_resolution?.method !== "temporal_neighbor") continue;
      const point = post.poi_resolution.points?.[post.poi_resolution.primary_point_index ?? 0];
      if (!point) continue;
      const coordinate = { longitude: Number(point.longitude), latitude: Number(point.latitude) };
      const distance = Math.min(...anchorCoordinates.map((anchor) =>
        haversineKm(coordinate, anchor)
      ));
      if (distance > 150) continue;
      trip.context_post_ids.push(role.post_id);
      contextRefs.push({
        trip_id: trip.id,
        post_id: role.post_id,
        map_role: "trip_candidate",
        relation: "same_trip_temporal_context",
        location_status: "borrowed_temporal_display_only",
        display_point: {
          longitude: coordinate.longitude,
          latitude: coordinate.latitude,
          name: point.name,
        },
        distance_to_route_km: Number(distance.toFixed(2)),
      });
    }
    trip.context_post_ids = [...new Set(trip.context_post_ids)];
  }
  return contextRefs;
}

function attachRevisits(trips, visitById) {
  const tripByVisitId = new Map();
  for (const trip of trips) {
    for (const visitId of trip.visit_ids) tripByVisitId.set(visitId, trip.id);
  }
  const byPlace = new Map();
  for (const visit of visitById.values()) {
    if (!visit.place_id) continue;
    if (!byPlace.has(visit.place_id)) byPlace.set(visit.place_id, []);
    byPlace.get(visit.place_id).push(visit);
  }
  const refs = [];
  for (const trip of trips) {
    const own = new Set(trip.visit_ids);
    const seen = new Set();
    for (const visitId of trip.visit_ids) {
      const visit = visitById.get(visitId);
      for (const other of byPlace.get(visit.place_id) ?? []) {
        if (own.has(other.id)) continue;
        const key = `${other.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        refs.push({
          trip_id: trip.id,
          visit_id: other.id,
          other_trip_id: tripByVisitId.get(other.id) ?? null,
          map_role: "revisit_context",
          relation: "same_place_revisit",
          visited_at: other.visited_at_start,
        });
      }
    }
  }
  return refs;
}

async function main() {
  const visits = readJsonl(path.resolve("data-processing/data/visits_v1.jsonl"));
  const visitById = new Map(visits.map((visit) => [visit.id, visit]));
  const posts = readJsonl(path.resolve("data-processing/data/vlm_results_v2_with_poi_mentions_v1.jsonl"));
  const postById = new Map(posts.map((post) => [String(post.id ?? post.mid), post]));
  const roles = readJsonl(path.resolve("data-processing/data/journey_post_roles_v1.jsonl"));
  const candidates = readJsonl(path.resolve(
    "data-processing/data/analysis/trip_parameter_sweep_v1/balanced/trip_candidates.jsonl"
  ));
  const base = buildBaseTrips(candidates, visitById);
  const membershipCandidates = attachSecondaryVisits(base.trips, visits);
  const temporalContextRefs = attachContextPosts(base.trips, roles, postById);
  const revisitRefs = attachRevisits(base.trips, visitById);
  const allContextRefs = [...temporalContextRefs, ...revisitRefs];
  const tripIdByVisitId = new Map();
  for (const trip of base.trips) {
    for (let sequence = 0; sequence < trip.visit_ids.length; sequence += 1) {
      tripIdByVisitId.set(trip.visit_ids[sequence], {
        trip_id: trip.id,
        sequence,
      });
    }
  }
  const visitsWithTrips = visits.map((visit) => {
    const membership = tripIdByVisitId.get(visit.id);
    return {
      ...visit,
      trip_id: membership?.trip_id ?? null,
      sequence: membership?.sequence ?? null,
      sequence_status: membership ? "cluster_order" : "not_in_trip",
    };
  });
  const clusteredVisitIds = new Set([...tripIdByVisitId.keys()]);
  const noiseVisitIds = visits
    .filter((visit) => visit.route_eligibility === "anchor" && !clusteredVisitIds.has(visit.id))
    .map((visit) => visit.id);
  const tripText = base.trips.length
    ? `${base.trips.map((trip) => JSON.stringify(trip)).join("\n")}\n`
    : "";
  const visitsText = `${visitsWithTrips.map((visit) => JSON.stringify(visit)).join("\n")}\n`;
  const membershipText = membershipCandidates.length
    ? `${membershipCandidates.map((item) => JSON.stringify(item)).join("\n")}\n`
    : "";
  const contextText = allContextRefs.length
    ? `${allContextRefs.map((item) => JSON.stringify(item)).join("\n")}\n`
    : "";
  const summary = {
    version: "trips_v1",
    generated_at: new Date().toISOString(),
    input_candidate_config: "balanced",
    dbscan_candidate_count: candidates.length,
    final_trip_count: base.trips.length,
    trip_kind_counts: Object.fromEntries([
      "local_sequence",
      "destination_stay",
      "travel_route",
    ].map((kind) => [
      kind,
      base.trips.filter((trip) => trip.trip_kind === kind).length,
    ])),
    main_route_visit_count: clusteredVisitIds.size,
    noise_anchor_visit_count: noiseVisitIds.length,
    discarded_home_boundary_singletons: base.discardedSegmentVisitIds.length,
    candidate_visit_attachment_count: membershipCandidates.filter((item) =>
      item.map_role === "trip_candidate"
    ).length,
    temporal_context_post_count: temporalContextRefs.length,
    revisit_context_count: revisitRefs.length,
    max_trip_visit_count: Math.max(0, ...base.trips.map((trip) => trip.visit_ids.length)),
    max_trip_duration_days: Math.max(0, ...base.trips.map((trip) =>
      (new Date(trip.end_date) - new Date(trip.start_date)) / 86_400_000
    )),
  };
  const report = `# Trips v1 运行报告

- DBSCAN 候选：${candidates.length}
- 最终 Trip：${base.trips.length}
- 主路线 Visit：${clusteredVisitIds.size}
- 未聚类锚点：${noiseVisitIds.length}
- 本地连续记录：${summary.trip_kind_counts.local_sequence}
- 单目的地停留：${summary.trip_kind_counts.destination_stay}
- 跨城路线：${summary.trip_kind_counts.travel_route}
- 候选/地区 Visit 附着：${summary.candidate_visit_attachment_count}
- 同期上下文微博：${summary.temporal_context_post_count}
- 同地点再次到访关系：${summary.revisit_context_count}

均衡参数先生成 ST-DBSCAN 候选；随后在北京常住地与外地之间的大距离跳转处切断，避免把出发前后的北京日常用餐串入外地旅程。主路线只包含 route_anchor。
`;
  const outputRoot = path.resolve("data-processing/data/analysis/trips_v1");
  await Promise.all([
    writeAtomic(path.resolve("data-processing/data/trips_v1.jsonl"), tripText),
    writeAtomic(path.resolve("data-processing/data/visits_with_trips_v1.jsonl"), visitsText),
    writeAtomic(path.resolve("data-processing/data/trip_membership_candidates_v1.jsonl"), membershipText),
    writeAtomic(path.resolve("data-processing/data/trip_context_refs_v1.jsonl"), contextText),
    writeAtomic(path.resolve("data-processing/data/trip_noise_visit_ids_v1.json"), `${JSON.stringify(noiseVisitIds, null, 2)}\n`),
    writeAtomic(path.join(outputRoot, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`),
    writeAtomic(path.join(outputRoot, "RUN_REPORT.md"), report),
  ]);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
