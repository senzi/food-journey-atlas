#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const options = {
    input: "data-processing/data/analysis/amap_poi_full_text_v1",
    output: "data-processing/data/analysis/amap_poi_scored_v1",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") options.input = argv[++index];
    else if (arg === "--output") options.output = argv[++index];
    else if (arg === "--help") {
      console.log(`Usage:
  node data-processing/scripts/score-amap-poi-candidates.mjs \\
    --input data-processing/data/analysis/amap_poi_full_text_v1 \\
    --output data-processing/data/analysis/amap_poi_scored_v1

This script is deterministic and does not call an LLM or AMap.`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase()
    .replace(/[（【〔［]/g, "(")
    .replace(/[）】〕］]/g, ")")
    .replace(/[·•・‧]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function baseName(value) {
  return normalizeText(
    String(value ?? "")
      .replace(
        /[（(][^()（）]*(?:总店|分店|旗舰店|店|馆|商场|中心|广场)[^()（）]*[)）]\s*$/u,
        "",
      )
      .replace(
        /(?:总店|旗舰店|直营店|第\d+分店|分店)$/u,
        "",
      ),
  );
}

function levenshtein(left, right) {
  if (left === right) return 0;
  if (!left) return right.length;
  if (!right) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function similarity(left, right) {
  const normalizedLeft = normalizeText(left);
  const normalizedRight = normalizeText(right);
  const maxLength = Math.max(normalizedLeft.length, normalizedRight.length);
  if (maxLength === 0) return 0;
  if (normalizedLeft === normalizedRight) return 1;
  return 1 - levenshtein(normalizedLeft, normalizedRight) / maxLength;
}

function bestNameSimilarity(keyword, poi) {
  const candidates = [
    poi.name,
    poi.business?.alias,
  ].filter((value) => typeof value === "string" && value.trim());
  const keywordNormalized = normalizeText(keyword);
  const keywordBase = baseName(keyword);
  let best = {
    similarity: 0,
    match_kind: "none",
    matched_text: "",
  };

  for (const candidate of candidates) {
    const candidateNormalized = normalizeText(candidate);
    const candidateBase = baseName(candidate);
    let candidateSimilarity = similarity(keyword, candidate);
    let matchKind = "edit_similarity";
    const baseSimilarity =
      keywordBase && candidateBase
        ? similarity(keywordBase, candidateBase)
        : 0;
    if (baseSimilarity > candidateSimilarity) {
      candidateSimilarity = baseSimilarity;
      matchKind = "base_edit_similarity";
    }
    if (keywordNormalized && keywordNormalized === candidateNormalized) {
      candidateSimilarity = 1;
      matchKind = "exact";
    } else if (
      keywordBase &&
      candidateBase &&
      keywordBase === candidateBase
    ) {
      candidateSimilarity = Math.max(candidateSimilarity, 0.96);
      matchKind = "same_base_name";
    } else if (
      Math.min(keywordBase.length, candidateBase.length) >= 2 &&
      (keywordBase.includes(candidateBase) ||
        candidateBase.includes(keywordBase))
    ) {
      const containment =
        Math.min(keywordBase.length, candidateBase.length) /
        Math.max(keywordBase.length, candidateBase.length);
      candidateSimilarity = Math.max(
        candidateSimilarity,
        0.72 + containment * 0.18,
      );
      matchKind = "contains";
    }
    if (candidateSimilarity > best.similarity) {
      best = {
        similarity: Math.min(1, candidateSimilarity),
        match_kind: matchKind,
        matched_text: candidate,
      };
    }
  }
  return best;
}

function clueMatch(clues, poi) {
  const fields = [
    poi.pname,
    poi.cityname,
    poi.adname,
    poi.address,
    poi.business?.business_area,
    poi.parent,
    poi.name,
  ]
    .map(normalizeText)
    .filter(Boolean);
  const matches = [];
  for (const clue of clues ?? []) {
    const normalizedClue = normalizeText(clue);
    if (
      normalizedClue &&
      fields.some(
        (field) =>
          field.includes(normalizedClue) ||
          normalizedClue.includes(field),
      )
    ) {
      matches.push(clue);
    }
  }
  return matches;
}

function typeCompatibility(placeKind, poi) {
  const code = String(poi.typecode ?? "");
  const type = String(poi.type ?? "");
  if (
    ["restaurant", "street_food", "hotel_food"].includes(placeKind)
  ) {
    return code.startsWith("05") || /餐饮|餐厅|小吃|饭店|酒店/u.test(type);
  }
  if (placeKind === "market") {
    return code.startsWith("06") || /市场|商场|购物/u.test(type);
  }
  if (placeKind === "attraction") {
    return code.startsWith("11") || /景点|风景|公园|博物馆/u.test(type);
  }
  if (placeKind === "building") {
    return code.startsWith("12") || /商务|住宅|楼宇|大厦/u.test(type);
  }
  return true;
}

function parseLocation(value) {
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
  return [longitude, latitude];
}

function haversineMeters(left, right) {
  const radians = (degrees) => (degrees * Math.PI) / 180;
  const [leftLongitude, leftLatitude] = left;
  const [rightLongitude, rightLatitude] = right;
  const latitudeDelta = radians(rightLatitude - leftLatitude);
  const longitudeDelta = radians(rightLongitude - leftLongitude);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(leftLatitude)) *
      Math.cos(radians(rightLatitude)) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function looksGenericKeyword(keyword) {
  return /(?:这家|那家|某家|未具名|朋友的?餐厅|老师的|喜欢的(?:一家)?|一家(?:餐厅|饭店|料理店)|附近的(?:餐厅|饭店)|新开的这家)/u.test(
    keyword,
  );
}

function scorePoi({ poi, request, keyword, index }) {
  const name = bestNameSimilarity(keyword, poi);
  const regionMatches = clueMatch(
    request.context?.region_clues ?? [],
    poi,
  );
  const addressMatches = clueMatch(
    request.context?.address_clues ?? [],
    poi,
  );
  const compatibleType = typeCompatibility(request.place_kind, poi);
  const sourceCoordinates =
    request.context?.original_geo?.usable === true
      ? request.context.original_geo.coordinates_lng_lat
      : null;
  const poiCoordinates = parseLocation(poi.location);
  const distanceMeters =
    sourceCoordinates && poiCoordinates
      ? Math.round(haversineMeters(sourceCoordinates, poiCoordinates))
      : null;

  const components = {
    name: Math.round(name.similarity * 60 * 100) / 100,
    region: regionMatches.length > 0 ? 12 : 0,
    address: addressMatches.length > 0 ? 15 : 0,
    type: compatibleType ? 8 : 0,
    rank: Math.max(0, 3 - index * 0.15),
  };
  const textScore = Math.round(
    Math.min(
      100,
      Object.values(components).reduce((sum, value) => sum + value, 0),
    ) * 100,
  ) / 100;

  return {
    rank: index + 1,
    poi_id: poi.id,
    name: poi.name,
    location: poi.location,
    pname: poi.pname,
    cityname: poi.cityname,
    adname: poi.adname,
    address: poi.address,
    type: poi.type,
    typecode: poi.typecode,
    business_area: poi.business?.business_area ?? null,
    rating: poi.business?.rating ?? null,
    alias: poi.business?.alias ?? null,
    name_similarity: Math.round(name.similarity * 10000) / 10000,
    name_match_kind: name.match_kind,
    matched_name_text: name.matched_text,
    matched_region_clues: regionMatches,
    matched_address_clues: addressMatches,
    type_compatible: compatibleType,
    distance_from_source_m: distanceMeters,
    score_components: components,
    text_score: textScore,
  };
}

function coordinateAssessment(candidates, hasSourceCoordinate) {
  if (!hasSourceCoordinate) {
    return {
      status: "unavailable",
      best_name_supported_distance_m: null,
    };
  }
  const distances = candidates
    .filter(
      (candidate) =>
        candidate.name_similarity >= 0.8 &&
        Number.isFinite(candidate.distance_from_source_m),
    )
    .map((candidate) => candidate.distance_from_source_m);
  if (distances.length === 0) {
    return {
      status: "no_name_supported_candidate",
      best_name_supported_distance_m: null,
    };
  }
  const bestDistance = Math.min(...distances);
  let status;
  if (bestDistance < 500) status = "aligned_under_500m";
  else if (bestDistance < 2000) status = "near_500m_to_2km";
  else status = "conflict_over_2km";
  return {
    status,
    best_name_supported_distance_m: bestDistance,
  };
}

function decide({ keyword, candidates, request }) {
  if (looksGenericKeyword(keyword)) {
    return {
      status: "rejected_invalid_query",
      selected_poi_ids: [],
      reason: "query_is_descriptive_not_a_place_name",
    };
  }
  if (candidates.length === 0) {
    return {
      status: "no_confident_match",
      selected_poi_ids: [],
      reason: "amap_returned_no_candidates",
    };
  }

  const [top, second] = candidates;
  const margin = top.text_score - (second?.text_score ?? 0);
  const credible = candidates.filter(
    (candidate) =>
      candidate.name_similarity >= 0.75 &&
      candidate.text_score >= top.text_score - 6,
  );
  const hasContext =
    (request.context?.region_clues?.length ?? 0) > 0 ||
    (request.context?.address_clues?.length ?? 0) > 0;

  if (top.name_similarity < 0.48 || top.text_score < 38) {
    return {
      status: "no_confident_match",
      selected_poi_ids: [],
      reason: "top_candidate_name_similarity_too_low",
    };
  }
  if (
    credible.length > 1 &&
    (!hasContext || margin < 6)
  ) {
    return {
      status: "multiple_retained",
      selected_poi_ids: credible.slice(0, 5).map((candidate) => candidate.poi_id),
      reason: "multiple_similar_candidates_without_decisive_context",
    };
  }
  if (
    top.name_similarity >= 0.9 &&
    top.text_score >= 62 &&
    margin >= 8
  ) {
    return {
      status: "auto_selected",
      selected_poi_ids: [top.poi_id],
      reason: "strong_name_match_with_clear_score_margin",
    };
  }
  return {
    status: "llm_review_required",
    selected_poi_ids: credible
      .slice(0, 5)
      .map((candidate) => candidate.poi_id),
    reason: "plausible_but_not_decisive",
  };
}

async function readJsonFiles(directory) {
  const files = (await fs.promises.readdir(directory))
    .filter((name) => name.endsWith(".json"))
    .sort();
  const values = [];
  for (const file of files) {
    values.push(
      JSON.parse(
        await fs.promises.readFile(path.join(directory, file), "utf8"),
      ),
    );
  }
  return values;
}

async function writeJson(filePath, value) {
  await fs.promises.writeFile(
    filePath,
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

async function writeJsonl(filePath, values) {
  await fs.promises.writeFile(
    filePath,
    values.length > 0
      ? `${values.map((value) => JSON.stringify(value)).join("\n")}\n`
      : "",
    "utf8",
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(options.input);
  const outputPath = path.resolve(options.output);
  const scoredPath = path.join(outputPath, "scored");
  if (fs.existsSync(outputPath)) {
    const existing = await fs.promises.readdir(outputPath);
    if (existing.length > 0) {
      throw new Error(`Refusing to overwrite non-empty output: ${outputPath}`);
    }
  }
  await fs.promises.mkdir(scoredPath, { recursive: true });

  const [requests, results] = await Promise.all([
    readJsonFiles(path.join(inputPath, "requests")),
    readJsonFiles(path.join(inputPath, "results")),
  ]);
  const requestsById = new Map(
    requests.map((request) => [request.request_id, request]),
  );
  const outputs = [];

  for (const result of results) {
    const request = requestsById.get(result.request_id);
    if (!request) continue;
    const candidates = (result.pois ?? [])
      .map((poi, index) =>
        scorePoi({
          poi,
          request,
          keyword: result.keyword,
          index,
        }),
      )
      .sort(
        (left, right) =>
          right.text_score - left.text_score || left.rank - right.rank,
      );
    const decision = decide({
      keyword: result.keyword,
      candidates,
      request,
    });
    const coordinate = coordinateAssessment(
      candidates,
      request.context?.original_geo?.usable === true,
    );
    const output = {
      request_id: result.request_id,
      post_id: result.post_id,
      group_index: result.group_index,
      keyword: result.keyword,
      place_kind: request.place_kind,
      original_endpoint: result.original_endpoint,
      effective_endpoint: result.effective_endpoint,
      candidate_count: candidates.length,
      decision,
      coordinate_assessment: coordinate,
      candidates,
    };
    outputs.push(output);
    await writeJson(
      path.join(scoredPath, `${result.request_id}.json`),
      output,
    );
  }

  const reviewQueue = outputs.filter(
    (output) => output.decision.status === "llm_review_required",
  );
  const summary = {
    script_version: "amap_candidate_scoring_v2",
    generated_at: new Date().toISOString(),
    input: inputPath,
    output: outputPath,
    request_count: outputs.length,
    decision_counts: Object.fromEntries(
      [
        "auto_selected",
        "multiple_retained",
        "llm_review_required",
        "no_confident_match",
        "rejected_invalid_query",
      ].map((status) => [
        status,
        outputs.filter((output) => output.decision.status === status).length,
      ]),
    ),
    coordinate_counts: Object.fromEntries(
      [
        "aligned_under_500m",
        "near_500m_to_2km",
        "conflict_over_2km",
        "no_name_supported_candidate",
        "unavailable",
      ].map((status) => [
        status,
        outputs.filter(
          (output) => output.coordinate_assessment.status === status,
        ).length,
      ]),
    ),
    llm_called: false,
    amap_called: false,
  };
  await writeJsonl(path.join(outputPath, "scored_results.jsonl"), outputs);
  await writeJsonl(
    path.join(outputPath, "llm_review_queue.jsonl"),
    reviewQueue,
  );
  await writeJson(path.join(outputPath, "summary.json"), summary);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
