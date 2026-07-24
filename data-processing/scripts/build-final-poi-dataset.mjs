#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { parseOriginalGeo } from "./test-poi-query-llm.mjs";

const CHINA_REGIONS = new Set([
  "中国",
  "北京",
  "天津",
  "上海",
  "重庆",
  "河北",
  "山西",
  "辽宁",
  "吉林",
  "黑龙江",
  "江苏",
  "浙江",
  "安徽",
  "福建",
  "江西",
  "山东",
  "河南",
  "湖北",
  "湖南",
  "广东",
  "海南",
  "四川",
  "贵州",
  "云南",
  "陕西",
  "甘肃",
  "青海",
  "内蒙古",
  "广西",
  "西藏",
  "宁夏",
  "新疆",
  "中国香港",
  "中国澳门",
  "中国台湾",
]);

function parseArgs(argv) {
  const options = {
    source: "data-processing/data/vlm_results_v2_repaired_v2.jsonl",
    scored: "data-processing/data/analysis/amap_poi_scored_v2_final/scored_results.jsonl",
    llm: "data-processing/data/analysis/poi_llm_disambiguation_v1/results.jsonl",
    regions: "data-processing/data/analysis/amap_region_fallback_v1/results.jsonl",
    extractedAmap:
      "data-processing/data/analysis/fallback_location_amap_v4/results.jsonl",
    output: "data-processing/data/vlm_results_v2_with_poi_v5.jsonl",
    analysis: "data-processing/data/analysis/final_poi_dataset_v5",
    temporalHours: 72,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source") options.source = argv[++index];
    else if (arg === "--scored") options.scored = argv[++index];
    else if (arg === "--llm") options.llm = argv[++index];
    else if (arg === "--regions") options.regions = argv[++index];
    else if (arg === "--extracted-amap") {
      options.extractedAmap = argv[++index];
    }
    else if (arg === "--output") options.output = argv[++index];
    else if (arg === "--analysis") options.analysis = argv[++index];
    else if (arg === "--temporal-hours") {
      options.temporalHours = Number(argv[++index]);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (
    !Number.isFinite(options.temporalHours) ||
    options.temporalHours < 0 ||
    options.temporalHours > 720
  ) {
    throw new Error("--temporal-hours must be from 0 to 720");
  }
  return options;
}

async function readJsonl(filePath) {
  const values = [];
  const input = fs.createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim()) values.push(JSON.parse(line));
  }
  return values;
}

function parsePoiLocation(value) {
  if (typeof value !== "string") return null;
  const [longitude, latitude] = value.split(",").map(Number);
  if (
    !Number.isFinite(longitude) ||
    !Number.isFinite(latitude) ||
    longitude < -180 ||
    longitude > 180 ||
    latitude < -90 ||
    latitude > 90
  ) {
    return null;
  }
  return {
    longitude,
    latitude,
    string: `${longitude.toFixed(6)},${latitude.toFixed(6)}`,
  };
}

function cleanRegion(value) {
  if (typeof value !== "string") return "";
  return value.replace(/^发布于\s*/u, "").trim();
}

function confidenceLabel(value) {
  const confidence = Number(value);
  if (confidence >= 0.85) return "high";
  if (confidence >= 0.65) return "medium";
  return "low";
}

function candidateToPoint({
  candidate,
  requestId,
  selectionMethod,
  decisionConfidence,
  coordinateStatus,
}) {
  const location = parsePoiLocation(candidate.location);
  if (!location) return null;
  return {
    poi_id: candidate.poi_id,
    name: candidate.name,
    longitude: location.longitude,
    latitude: location.latitude,
    location: location.string,
    address: candidate.address ?? "",
    province: candidate.pname ?? "",
    city: candidate.cityname ?? "",
    district: candidate.adname ?? "",
    type: candidate.type ?? "",
    typecode: candidate.typecode ?? "",
    business_area: candidate.business_area ?? null,
    rating: candidate.rating ?? null,
    source_request_id: requestId,
    selection_method: selectionMethod,
    selection_confidence:
      decisionConfidence === null
        ? candidate.text_score >= 70
          ? "high"
          : "medium"
        : confidenceLabel(decisionConfidence),
    candidate_text_score: candidate.text_score,
    name_similarity: candidate.name_similarity,
    distance_from_source_m: candidate.distance_from_source_m,
    coordinate_status: coordinateStatus,
    is_fallback: false,
  };
}

function dedupePoints(points) {
  const seen = new Set();
  return points.filter((point) => {
    if (!point) return false;
    const key = point.poi_id
      ? `poi:${point.poi_id}`
      : `loc:${point.location}:${point.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sourceGeoPoint(row) {
  const geo = parseOriginalGeo(row.geo);
  if (!geo.usable) return null;
  const [longitude, latitude] = geo.coordinates_lng_lat;
  return {
    poi_id: null,
    name: geo.source_poi ?? "原始签到点",
    longitude,
    latitude,
    location: `${longitude.toFixed(6)},${latitude.toFixed(6)}`,
    address: "",
    province: "",
    city: "",
    district: "",
    type: "source_geo",
    typecode: null,
    business_area: null,
    rating: null,
    source_request_id: null,
    selection_method: "source_geo_fallback",
    selection_confidence: geo.source_poi ? "medium" : "low",
    candidate_text_score: null,
    name_similarity: null,
    distance_from_source_m: null,
    coordinate_status: "source_coordinate_unverified",
    is_fallback: true,
  };
}

function findNearestAnchor(anchors, timestamp) {
  if (!Number.isFinite(timestamp) || anchors.length === 0) return null;
  let low = 0;
  let high = anchors.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (anchors[middle].timestamp < timestamp) low = middle + 1;
    else high = middle;
  }
  const candidates = [anchors[low - 1], anchors[low]].filter(Boolean);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, item) =>
    Math.abs(item.timestamp - timestamp) <
    Math.abs(best.timestamp - timestamp)
      ? item
      : best,
  );
}

async function writeJson(filePath, value) {
  await fs.promises.writeFile(
    filePath,
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sourcePath = path.resolve(options.source);
  const outputPath = path.resolve(options.output);
  const analysisPath = path.resolve(options.analysis);
  if (fs.existsSync(outputPath)) {
    throw new Error(`Refusing to overwrite existing output: ${outputPath}`);
  }
  if (fs.existsSync(analysisPath)) {
    const existing = await fs.promises.readdir(analysisPath);
    if (existing.length > 0) {
      throw new Error(
        `Refusing to overwrite non-empty analysis directory: ${analysisPath}`,
      );
    }
  }
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.promises.mkdir(analysisPath, { recursive: true });

  const [
    rows,
    scoredResults,
    llmResults,
    regionResults,
    extractedAmapResults,
  ] = await Promise.all([
    readJsonl(sourcePath),
    readJsonl(path.resolve(options.scored)),
    readJsonl(path.resolve(options.llm)),
    readJsonl(path.resolve(options.regions)),
    readJsonl(path.resolve(options.extractedAmap)),
  ]);
  const llmByRequest = new Map(
    llmResults
      .filter((item) => item.validation?.valid)
      .map((item) => [item.request_id, item]),
  );
  const scoredByPost = new Map();
  for (const scored of scoredResults) {
    const list = scoredByPost.get(String(scored.post_id)) ?? [];
    list.push(scored);
    scoredByPost.set(String(scored.post_id), list);
  }
  const regionMap = new Map(
    regionResults
      .filter(
        (item) =>
          item.found &&
          item.location &&
          CHINA_REGIONS.has(item.region),
      )
      .map((item) => [item.region, item]),
  );
  const extractedByPost = new Map();
  for (const item of extractedAmapResults.filter(
    (result) => result.accepted && result.resolved?.location,
  )) {
    const list = extractedByPost.get(String(item.post_id)) ?? [];
    list.push(item);
    extractedByPost.set(String(item.post_id), list);
  }

  const baseResolutions = new Map();
  for (const row of rows) {
    const postId = String(row.id ?? row.mid);
    const selectedPoints = [];
    let usedLlm = false;
    for (const scored of scoredByPost.get(postId) ?? []) {
      const llm = llmByRequest.get(scored.request_id);
      let selectedIds = [];
      let selectionMethod;
      let decisionConfidence = null;
      if (llm) {
        usedLlm = true;
        selectedIds = llm.decision.selected_poi_ids;
        selectionMethod = "amap_llm_disambiguated";
        decisionConfidence = llm.decision.confidence;
      } else if (
        ["auto_selected", "multiple_retained"].includes(
          scored.decision.status,
        )
      ) {
        selectedIds = scored.decision.selected_poi_ids;
        selectionMethod =
          scored.decision.status === "auto_selected"
            ? "amap_deterministic"
            : "amap_multiple_retained";
      }
      for (const selectedId of selectedIds) {
        const candidate = scored.candidates.find(
          (item) => item.poi_id === selectedId,
        );
        if (!candidate) continue;
        selectedPoints.push(
          candidateToPoint({
            candidate,
            requestId: scored.request_id,
            selectionMethod,
            decisionConfidence,
            coordinateStatus: scored.coordinate_assessment.status,
          }),
        );
      }
    }

    const points = dedupePoints(selectedPoints);
    if (points.length > 0) {
      baseResolutions.set(postId, {
        status: "resolved",
        method: usedLlm
          ? "amap_with_llm_disambiguation"
          : points.length > 1
            ? "amap_multiple_candidates"
            : "amap_deterministic",
        confidence:
          points.every((point) => point.selection_confidence === "high")
            ? "high"
            : "medium",
        is_display_fallback: false,
        points,
      });
      continue;
    }

    const geoPoint = sourceGeoPoint(row);
    if (geoPoint) {
      baseResolutions.set(postId, {
        status: "fallback",
        method: "source_geo",
        confidence: geoPoint.selection_confidence,
        is_display_fallback: true,
        points: [geoPoint],
      });
    }
  }

  for (const [postId, extractedItems] of extractedByPost.entries()) {
    if (baseResolutions.has(postId)) continue;
    const points = dedupePoints(
      extractedItems.map((item) => {
        const location = parsePoiLocation(item.resolved.location);
        if (!location) return null;
        const coarseRegion = ["city", "region", "country"].includes(item.kind);
        return {
          poi_id: item.resolved.poi_id ?? null,
          name: item.resolved.name || item.text,
          longitude: location.longitude,
          latitude: location.latitude,
          location: location.string,
          address: item.resolved.address ?? "",
          province: item.resolved.province ?? "",
          city: item.resolved.city ?? "",
          district: item.resolved.district ?? "",
          type: item.resolved.type ?? `explicit_${item.kind}`,
          typecode: item.resolved.typecode ?? null,
          business_area: item.resolved.business_area ?? null,
          rating: item.resolved.rating ?? null,
          source_request_id: item.request_id,
          selection_method: coarseRegion
            ? "explicit_region_geocode"
            : "explicit_location_amap",
          selection_confidence:
            item.extraction_confidence >= 0.9 &&
            Number(item.resolved.match_score ?? 1) >= 0.8
              ? "high"
              : "medium",
          candidate_text_score: null,
          name_similarity: item.resolved.match_score ?? null,
          distance_from_source_m: null,
          coordinate_status: coarseRegion
            ? "coarse_explicit_region"
            : "explicit_location_resolved",
          extraction_text: item.text,
          extraction_kind: item.kind,
          extraction_confidence: item.extraction_confidence,
          extraction_evidence: item.evidence,
          is_fallback: coarseRegion,
        };
      }),
    );
    if (points.length === 0) continue;
    const allCoarse = points.every((point) => point.is_fallback);
    baseResolutions.set(postId, {
      status: allCoarse ? "fallback" : "resolved",
      method: allCoarse
        ? "explicit_region_geocode"
        : "explicit_location_amap",
      confidence: allCoarse
        ? "low"
        : points.every((point) => point.selection_confidence === "high")
          ? "high"
          : "medium",
      is_display_fallback: allCoarse,
      points,
    });
  }

  const rowByPost = new Map(
    rows.map((row) => [String(row.id ?? row.mid), row]),
  );
  const anchors = [...baseResolutions.entries()]
    .map(([postId, resolution]) => {
      const row = rowByPost.get(postId);
      const timestamp = Date.parse(row?.created_at);
      const point = resolution.points[0];
      return Number.isFinite(timestamp) && point
        ? { postId, timestamp, point }
        : null;
    })
    .filter(Boolean)
    .sort((left, right) => left.timestamp - right.timestamp);
  const temporalLimitMs = options.temporalHours * 60 * 60 * 1000;
  const fallbackResolutions = new Map();
  const beijing = regionMap.get("北京");
  const defaultLocation =
    parsePoiLocation(beijing?.location) ?? {
      longitude: 116.397499,
      latitude: 39.908722,
      string: "116.397499,39.908722",
    };

  for (const row of rows) {
    const postId = String(row.id ?? row.mid);
    if (baseResolutions.has(postId)) continue;
    const timestamp = Date.parse(row.created_at);
    const nearest = findNearestAnchor(anchors, timestamp);
    const temporalDelta =
      nearest && Number.isFinite(timestamp)
        ? Math.abs(nearest.timestamp - timestamp)
        : Infinity;
    if (nearest && temporalDelta <= temporalLimitMs) {
      const borrowed = nearest.point;
      fallbackResolutions.set(postId, {
        status: "fallback",
        method: "temporal_neighbor",
        confidence: "low",
        is_display_fallback: true,
        points: [
          {
            ...borrowed,
            selection_method: "temporal_neighbor_fallback",
            selection_confidence: "low",
            is_fallback: true,
            borrowed_from_post_id: nearest.postId,
            temporal_distance_hours:
              Math.round((temporalDelta / 3600000) * 10) / 10,
          },
        ],
      });
      continue;
    }

    const region = cleanRegion(row.region_name);
    const regionResult = regionMap.get(region);
    const regionLocation = parsePoiLocation(regionResult?.location);
    if (regionLocation) {
      fallbackResolutions.set(postId, {
        status: "fallback",
        method: "ip_region_centroid",
        confidence: "low",
        is_display_fallback: true,
        points: [
          {
            poi_id: null,
            name: `${region}区域展示点`,
            longitude: regionLocation.longitude,
            latitude: regionLocation.latitude,
            location: regionLocation.string,
            address: regionResult.formatted_address ?? "",
            province: regionResult.province ?? "",
            city: Array.isArray(regionResult.city)
              ? regionResult.city.join("")
              : regionResult.city ?? "",
            district: Array.isArray(regionResult.district)
              ? regionResult.district.join("")
              : regionResult.district ?? "",
            type: "ip_region_display_fallback",
            typecode: null,
            business_area: null,
            rating: null,
            source_request_id: null,
            selection_method: "ip_region_centroid_fallback",
            selection_confidence: "low",
            candidate_text_score: null,
            name_similarity: null,
            distance_from_source_m: null,
            coordinate_status: "not_actual_visit_location",
            is_fallback: true,
          },
        ],
      });
      continue;
    }

    fallbackResolutions.set(postId, {
      status: "fallback",
      method: "global_default",
      confidence: "display_only",
      is_display_fallback: true,
      points: [
        {
          poi_id: null,
          name: "未知地点展示点",
          longitude: defaultLocation.longitude,
          latitude: defaultLocation.latitude,
          location: defaultLocation.string,
          address: "",
          province: "",
          city: "北京",
          district: "",
          type: "global_display_fallback",
          typecode: null,
          business_area: null,
          rating: null,
          source_request_id: null,
          selection_method: "global_default_display_fallback",
          selection_confidence: "display_only",
          candidate_text_score: null,
          name_similarity: null,
          distance_from_source_m: null,
          coordinate_status: "not_actual_visit_location",
          is_fallback: true,
        },
      ],
    });
  }

  const generatedAt = new Date().toISOString();
  const outputLines = [];
  const indexLines = [];
  const methodCounts = new Map();
  let pointCount = 0;
  for (const row of rows) {
    const postId = String(row.id ?? row.mid);
    const resolution =
      baseResolutions.get(postId) ?? fallbackResolutions.get(postId);
    if (!resolution || resolution.points.length === 0) {
      throw new Error(`Missing POI resolution for ${postId}`);
    }
    methodCounts.set(
      resolution.method,
      (methodCounts.get(resolution.method) ?? 0) + 1,
    );
    pointCount += resolution.points.length;
    const poiResolution = {
      version: "poi_resolution_v5",
      generated_at: generatedAt,
      status: resolution.status,
      method: resolution.method,
      confidence: resolution.confidence,
      is_display_fallback: resolution.is_display_fallback,
      primary_point_index: 0,
      point_count: resolution.points.length,
      points: resolution.points,
    };
    outputLines.push(JSON.stringify({ ...row, poi_resolution: poiResolution }));
    indexLines.push(
      JSON.stringify({
        post_id: postId,
        method: resolution.method,
        confidence: resolution.confidence,
        is_display_fallback: resolution.is_display_fallback,
        point_count: resolution.points.length,
        primary_point: resolution.points[0],
      }),
    );
  }

  await fs.promises.writeFile(
    outputPath,
    `${outputLines.join("\n")}\n`,
    "utf8",
  );
  await fs.promises.writeFile(
    path.join(analysisPath, "poi_resolution_index.jsonl"),
    `${indexLines.join("\n")}\n`,
    "utf8",
  );
  const summary = {
    version: "poi_resolution_v5",
    generated_at: generatedAt,
    source: sourcePath,
    output: outputPath,
    source_rows: rows.length,
    output_rows: outputLines.length,
    total_points: pointCount,
    every_post_has_point: outputLines.length === rows.length,
    source_modified: false,
    temporal_fallback_hours: options.temporalHours,
    method_counts: Object.fromEntries(
      [...methodCounts.entries()].sort((left, right) =>
        left[0].localeCompare(right[0]),
      ),
    ),
  };
  await writeJson(path.join(analysisPath, "summary.json"), summary);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
