#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const CONFIGS = [
  {
    id: "strict",
    near_km: 50,
    near_days: 3,
    travel_km: 1200,
    travel_days: 1.25,
    min_samples: 2,
  },
  {
    id: "balanced",
    near_km: 100,
    near_days: 5,
    travel_km: 2500,
    travel_days: 2,
    min_samples: 2,
  },
  {
    id: "broad",
    near_km: 150,
    near_days: 7,
    travel_km: 3500,
    travel_days: 3,
    min_samples: 2,
  },
  {
    id: "legacy_100km_7d",
    near_km: 100,
    near_days: 7,
    travel_km: 0,
    travel_days: 0,
    min_samples: 2,
  },
];

function readJsonl(filePath) {
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

async function writeAtomic(filePath, content) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.promises.writeFile(temporaryPath, content, "utf8");
  await fs.promises.rename(temporaryPath, filePath);
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

function timeDays(left, right) {
  return Math.abs(new Date(left.visited_at_start) - new Date(right.visited_at_start))
    / 86_400_000;
}

function coordinate(visit) {
  const point = visit.points[0];
  return {
    longitude: Number(point.longitude),
    latitude: Number(point.latitude),
  };
}

function normalizeName(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/\s+/gu, "");
}

function travelSupported(visit, postById) {
  if (visit.coordinate_source === "source_geo") return true;
  const point = visit.points[0];
  for (const postId of visit.post_ids) {
    const post = postById.get(postId);
    const content = post?.content ?? "";
    if (point.name && point.name.length >= 3 && content.includes(point.name)) return true;
    for (const region of [point.province, point.city, point.district]) {
      if (region && content.includes(region)) return true;
    }
    for (const mention of post?.mentions ?? []) {
      if (mention.entity_type !== "restaurant") continue;
      const term = normalizeName(mention.text);
      const name = normalizeName(point.name);
      if (term.length >= 2 && (name.includes(term) || term.includes(name))) return true;
    }
  }
  return false;
}

function isNeighbor(left, right, config, postById) {
  const days = timeDays(left, right);
  const distance = haversineKm(coordinate(left), coordinate(right));
  if (days <= config.near_days && distance <= config.near_km) {
    return { neighbor: true, kind: "near", days, distance };
  }
  if (
    config.travel_km > 0
    && days <= config.travel_days
    && distance > config.near_km
    && distance <= config.travel_km
    && travelSupported(left, postById)
    && travelSupported(right, postById)
  ) {
    return { neighbor: true, kind: "travel_transition", days, distance };
  }
  return { neighbor: false, kind: null, days, distance };
}

function dbscan(visits, config, postById) {
  const neighbors = visits.map(() => []);
  const edges = [];
  for (let leftIndex = 0; leftIndex < visits.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < visits.length; rightIndex += 1) {
      const relation = isNeighbor(visits[leftIndex], visits[rightIndex], config, postById);
      if (!relation.neighbor) continue;
      neighbors[leftIndex].push(rightIndex);
      neighbors[rightIndex].push(leftIndex);
      edges.push({
        left: leftIndex,
        right: rightIndex,
        kind: relation.kind,
        gap_days: relation.days,
        distance_km: relation.distance,
      });
    }
  }
  const labels = Array(visits.length).fill(null);
  let clusterNumber = 0;
  const minimumNeighborCount = config.min_samples - 1;
  for (let index = 0; index < visits.length; index += 1) {
    if (labels[index] !== null || neighbors[index].length < minimumNeighborCount) continue;
    const clusterId = clusterNumber++;
    labels[index] = clusterId;
    const queue = [...neighbors[index]];
    const queued = new Set(queue);
    while (queue.length) {
      const current = queue.shift();
      if (labels[current] === null) labels[current] = clusterId;
      if (neighbors[current].length < minimumNeighborCount) continue;
      for (const next of neighbors[current]) {
        if (labels[next] === null && !queued.has(next)) {
          queue.push(next);
          queued.add(next);
        }
      }
    }
  }
  const clusters = Array.from({ length: clusterNumber }, () => []);
  const noise = [];
  for (let index = 0; index < labels.length; index += 1) {
    if (labels[index] === null) noise.push(index);
    else clusters[labels[index]].push(index);
  }
  return { clusters, noise, edges };
}

function quantile(values, q) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function clusterRecord(indexes, visits, config, edges, number) {
  const clusterVisits = indexes.map((index) => visits[index]).sort((a, b) =>
    new Date(a.visited_at_start) - new Date(b.visited_at_start)
  );
  const indexSet = new Set(indexes);
  const clusterEdges = edges.filter((edge) =>
    indexSet.has(edge.left) && indexSet.has(edge.right)
  );
  const start = clusterVisits[0].visited_at_start;
  const end = clusterVisits.at(-1).visited_at_end;
  const durationDays = (new Date(end) - new Date(start)) / 86_400_000;
  const cities = [...new Set(clusterVisits.flatMap((visit) =>
    visit.points.map((point) => point.city || point.district || point.province).filter(Boolean)
  ))];
  const provinces = [...new Set(clusterVisits.flatMap((visit) =>
    visit.points.map((point) => point.province).filter(Boolean)
  ))];
  const maxEdgeDistance = Math.max(0, ...clusterEdges.map((edge) => edge.distance_km));
  const travelTransitionCount = clusterEdges.filter((edge) =>
    edge.kind === "travel_transition"
  ).length;
  return {
    candidate_id: `trip_candidate_${config.id}_${String(number + 1).padStart(4, "0")}`,
    config_id: config.id,
    start_date: start,
    end_date: end,
    duration_days: Number(durationDays.toFixed(3)),
    visit_ids: clusterVisits.map((visit) => visit.id),
    post_ids: [...new Set(clusterVisits.flatMap((visit) => visit.post_ids))],
    cities,
    provinces,
    visit_count: clusterVisits.length,
    city_count: cities.length,
    province_count: provinces.length,
    travel_transition_count: travelTransitionCount,
    max_neighbor_edge_km: Number(maxEdgeDistance.toFixed(2)),
    confidence_hint: durationDays <= 14 && clusterVisits.length >= 2 ? "reviewable" : "boundary_risk",
    quality_flags: [
      ...(durationDays > 14 ? ["long_cluster_duration"] : []),
      ...(clusterVisits.length > 20 ? ["large_cluster"] : []),
      ...(maxEdgeDistance > 2000 ? ["very_long_transition"] : []),
    ],
  };
}

async function main() {
  const posts = readJsonl(path.resolve("data-processing/data/vlm_results_v2_with_poi_mentions_v1.jsonl"));
  const postById = new Map(posts.map((post) => [String(post.id ?? post.mid), post]));
  const visits = readJsonl(path.resolve("data-processing/data/visits_v1.jsonl"))
    .filter((visit) => visit.route_eligibility === "anchor")
    .sort((a, b) => new Date(a.visited_at_start) - new Date(b.visited_at_start));
  const outputRoot = path.resolve("data-processing/data/analysis/trip_parameter_sweep_v1");
  const summaries = [];
  for (const config of CONFIGS) {
    const clustered = dbscan(visits, config, postById);
    const records = clustered.clusters.map((indexes, index) =>
      clusterRecord(indexes, visits, config, clustered.edges, index)
    );
    const clusterSizes = records.map((record) => record.visit_count);
    const durations = records.map((record) => record.duration_days);
    const clusteredVisits = records.reduce((sum, record) => sum + record.visit_count, 0);
    const summary = {
      config,
      input_anchor_visits: visits.length,
      cluster_count: records.length,
      clustered_visit_count: clusteredVisits,
      noise_visit_count: clustered.noise.length,
      coverage: Number((clusteredVisits / visits.length).toFixed(6)),
      visit_count_median: Number(quantile(clusterSizes, 0.5).toFixed(3)),
      visit_count_p90: Number(quantile(clusterSizes, 0.9).toFixed(3)),
      visit_count_max: Math.max(0, ...clusterSizes),
      duration_days_median: Number(quantile(durations, 0.5).toFixed(3)),
      duration_days_p90: Number(quantile(durations, 0.9).toFixed(3)),
      duration_days_max: Math.max(0, ...durations),
      cross_city_cluster_count: records.filter((record) => record.city_count > 1).length,
      cross_province_cluster_count: records.filter((record) => record.province_count > 1).length,
      long_duration_cluster_count: records.filter((record) => record.duration_days > 14).length,
      very_long_transition_cluster_count: records.filter((record) =>
        record.quality_flags.includes("very_long_transition")
      ).length,
    };
    summaries.push(summary);
    const configPath = path.join(outputRoot, config.id);
    await Promise.all([
      writeAtomic(path.join(configPath, "trip_candidates.jsonl"),
        records.length ? `${records.map((record) => JSON.stringify(record)).join("\n")}\n` : ""),
      writeAtomic(path.join(configPath, "noise_visit_ids.json"),
        `${JSON.stringify(clustered.noise.map((index) => visits[index].id), null, 2)}\n`),
      writeAtomic(path.join(configPath, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`),
    ]);
  }
  const reportLines = [
    "# Trip 参数扫描 v1",
    "",
    "| config | clusters | coverage | noise | median size | max size | median days | max days | cross-city | >14d |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...summaries.map((summary) =>
      `| ${summary.config.id} | ${summary.cluster_count} | ${(summary.coverage * 100).toFixed(1)}% | ${summary.noise_visit_count} | ${summary.visit_count_median} | ${summary.visit_count_max} | ${summary.duration_days_median} | ${summary.duration_days_max.toFixed(1)} | ${summary.cross_city_cluster_count} | ${summary.long_duration_cluster_count} |`
    ),
    "",
    "说明：`near` 邻域要求时间和空间同时接近；`travel_transition` 允许短时间内的跨城移动。旧版基线没有跨城转场规则。",
  ];
  await Promise.all([
    writeAtomic(path.join(outputRoot, "summary.json"), `${JSON.stringify({ summaries }, null, 2)}\n`),
    writeAtomic(path.join(outputRoot, "RUN_REPORT.md"), `${reportLines.join("\n")}\n`),
  ]);
  console.log(JSON.stringify({ summaries }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
