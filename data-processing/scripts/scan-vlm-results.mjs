#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";

const ARRAY_FIELDS = [
  "dish_candidates",
  "food_categories",
  "ingredients_visible",
  "cooking_methods",
  "cuisine_style",
  "restaurant_features",
  "recording_context",
  "visible_text",
  "place_clues",
  "restaurant_name_candidates",
];

const SCALAR_FIELDS = ["summary", "image_role", "importance", "notes"];
const OBJECT_FIELDS = ["restaurant_scene"];
const VALID_SOURCES = new Set(["text", "image", "combined"]);
const VALID_IMAGE_ROLES = new Set([
  "dish",
  "person_with_food",
  "food_material",
  "restaurant",
  "menu",
  "food_scene",
  "non_food",
  "unknown",
]);
const VALID_IMPORTANCE = new Set(["high", "medium", "low"]);
const VALID_SCENES = new Set([
  "street_food",
  "restaurant",
  "banquet",
  "home",
  "market",
  "unknown",
]);
const MAX_SUSPICIOUS_SAMPLES = 500;

function parseArgs(argv) {
  const result = {
    input: "data-processing/data/vlm_results_v2.jsonl",
    output: "data-processing/data/analysis/vlm_v2_scan",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") result.input = argv[++index];
    else if (arg === "--output") result.output = argv[++index];
    else if (arg === "--help") {
      console.log(
        "Usage: node data-processing/scripts/scan-vlm-results.mjs " +
          "[--input data-processing/data/vlm_results_v2.jsonl] " +
          "[--output data-processing/data/analysis/vlm_v2_scan]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return result;
}

function increment(object, key, amount = 1) {
  const safeKey = String(key ?? "<missing>");
  object[safeKey] = (object[safeKey] ?? 0) + amount;
}

function createCoverage() {
  return {
    total: 0,
    present: 0,
    missing: 0,
    null: 0,
    empty: 0,
    nonempty: 0,
    wrong_type: 0,
  };
}

function updateCoverage(coverage, object, field, expectedType) {
  const metric = coverage[field] ?? (coverage[field] = createCoverage());
  metric.total += 1;

  if (!Object.hasOwn(object, field)) {
    metric.missing += 1;
    return;
  }

  metric.present += 1;
  const value = object[field];

  if (value === null) {
    metric.null += 1;
    return;
  }

  const isExpected =
    expectedType === "array"
      ? Array.isArray(value)
      : expectedType === "object"
        ? typeof value === "object" && !Array.isArray(value)
        : typeof value === expectedType;

  if (!isExpected) {
    metric.wrong_type += 1;
    return;
  }

  const isEmpty =
    expectedType === "array"
      ? value.length === 0
      : expectedType === "object"
        ? Object.keys(value).length === 0
        : value.trim().length === 0;

  if (isEmpty) metric.empty += 1;
  else metric.nonempty += 1;
}

function isNonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}

function hasValue(value) {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function isLongitude(value) {
  return Number.isFinite(value) && value >= -180 && value <= 180;
}

function isLatitude(value) {
  return Number.isFinite(value) && value >= -90 && value <= 90;
}

function isInChinaBounds([longitude, latitude]) {
  return (
    longitude >= 73 &&
    longitude <= 136 &&
    latitude >= 3 &&
    latitude <= 54
  );
}

function findCoordinatePair(value, depth = 0) {
  if (depth > 5 || value === null || value === undefined) return null;

  if (
    Array.isArray(value) &&
    value.length >= 2 &&
    Number.isFinite(Number(value[0])) &&
    Number.isFinite(Number(value[1]))
  ) {
    const first = Number(value[0]);
    const second = Number(value[1]);
    if (first === second) return null;
    // The source geo.coordinates schema observed in this file is [lat, lng].
    // Prefer that order when both interpretations are numerically possible.
    if (isLatitude(first) && isLongitude(second)) {
      return { coordinates: [second, first], order: "lat_lng" };
    }
    if (isLongitude(first) && isLatitude(second)) {
      return { coordinates: [first, second], order: "lng_lat" };
    }
  }

  if (typeof value === "string") {
    const match = value.match(
      /(-?\d{1,3}(?:\.\d+)?)\s*[,，]\s*(-?\d{1,3}(?:\.\d+)?)/,
    );
    if (match) {
      return findCoordinatePair([Number(match[1]), Number(match[2])], depth + 1);
    }
    return null;
  }

  if (typeof value === "object") {
    const longitude =
      value.longitude ?? value.lng ?? value.lon ?? value.x ?? value.Longitude;
    const latitude =
      value.latitude ?? value.lat ?? value.y ?? value.Latitude;

    if (
      Number.isFinite(Number(longitude)) &&
      Number.isFinite(Number(latitude))
    ) {
      const lng = Number(longitude);
      const lat = Number(latitude);
      if (lng !== lat && isLongitude(lng) && isLatitude(lat)) {
        return { coordinates: [lng, lat], order: "named_fields" };
      }
      return null;
    }

    for (const child of Object.values(value)) {
      const found = findCoordinatePair(child, depth + 1);
      if (found) return found;
    }
  }

  return null;
}

function looksLikeRegion(name) {
  if (typeof name !== "string") return false;
  const normalized = name.trim();
  if (normalized.length < 2 || normalized.length > 20) return false;
  return /(省|市|区|县|州|盟|旗|镇|乡|街道|新区|地区)$/.test(normalized);
}

function getCandidateName(item) {
  if (typeof item === "string") return item.trim();
  if (item && typeof item === "object") {
    return String(item.name ?? item.text ?? "").trim();
  }
  return "";
}

function isUsefulVisibleText(value) {
  if (typeof value !== "string") return false;
  const text = value.trim();
  return (
    text.length >= 3 &&
    !/^@/.test(text) &&
    !/^https?:\/\//i.test(text) &&
    !/^(www\.|t\.sina\.com)/i.test(text) &&
    !/(微博|weibo\.com|陈晓卿)/i.test(text)
  );
}

function checkCandidateArray({
  items,
  field,
  postId,
  picIndex,
  metrics,
  suspicious,
  content,
}) {
  if (!Array.isArray(items)) return;

  for (const item of items) {
    const name = getCandidateName(item);
    if (!name) {
      metrics.candidate_quality.empty_name += 1;
      addSuspicious(suspicious, {
        post_id: postId,
        pic_index: picIndex,
        reason: `${field}:empty_name`,
      });
    }

    if (item && typeof item === "object") {
      if (Object.hasOwn(item, "confidence")) {
        const confidence = Number(item.confidence);
        if (
          !Number.isFinite(confidence) ||
          confidence < 0 ||
          confidence > 1
        ) {
          metrics.candidate_quality.invalid_confidence += 1;
          addSuspicious(suspicious, {
            post_id: postId,
            pic_index: picIndex,
            reason: `${field}:invalid_confidence`,
            value: item.confidence,
          });
        }
      } else {
        metrics.candidate_quality.missing_confidence += 1;
      }

      if (Object.hasOwn(item, "source")) {
        increment(metrics.candidate_sources, item.source);
        if (!VALID_SOURCES.has(item.source)) {
          metrics.candidate_quality.invalid_source += 1;
        }
      } else if (
        [
          "dish_candidates",
          "food_categories",
          "cooking_methods",
          "cuisine_style",
          "place_clues",
          "restaurant_name_candidates",
        ].includes(field)
      ) {
        metrics.candidate_quality.missing_source += 1;
      }
    }

    if (
      name &&
      item &&
      typeof item === "object" &&
      item.source === "text" &&
      typeof content === "string" &&
      !content.includes(name)
    ) {
      metrics.candidate_quality.text_source_not_in_content += 1;
      addSuspicious(suspicious, {
        post_id: postId,
        pic_index: picIndex,
        reason: `${field}:text_source_not_exactly_in_content`,
        candidate: name,
      });
    }
  }
}

function addSuspicious(collection, item) {
  if (collection.length < MAX_SUSPICIOUS_SAMPLES) collection.push(item);
}

function classifyPost(state) {
  if (state.invalid) return "Q_INVALID";
  if (state.hasValidGeo && state.hasRestaurantCandidate) {
    return "A_GEO_RESTAURANT";
  }
  if (
    state.hasValidGeo &&
    (state.hasPlaceClue || state.hasUsefulVisibleText)
  ) {
    return "B_GEO_PLACE_CLUE";
  }
  if (state.hasRestaurantCandidate && state.hasRegionLikeClue) {
    return "C_NAME_REGION";
  }
  if (state.hasRestaurantCandidate) return "D_NAME_ONLY";
  if (state.hasPlaceClue || state.hasUsefulVisibleText) {
    return "E_AMBIGUOUS_TEXT";
  }
  if (state.hasFoodEvidence) return "F_FOOD_ONLY";
  return "G_NON_MAP";
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function writeJson(filePath, value) {
  await fs.promises.writeFile(
    filePath,
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

async function writeJsonl(filePath, rows) {
  const content =
    rows.length > 0 ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "";
  await fs.promises.writeFile(filePath, content, "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(args.input);
  const outputPath = path.resolve(args.output);

  const stat = await fs.promises.stat(inputPath);
  if (!stat.isFile()) throw new Error(`Input is not a file: ${inputPath}`);
  await fs.promises.mkdir(outputPath, { recursive: true });

  const fieldCoverage = {};
  for (const field of ARRAY_FIELDS) fieldCoverage[field] = createCoverage();
  for (const field of SCALAR_FIELDS) fieldCoverage[field] = createCoverage();
  for (const field of OBJECT_FIELDS) fieldCoverage[field] = createCoverage();

  const metrics = {
    rows: {
      total: 0,
      blank: 0,
      valid_json: 0,
      invalid_json: 0,
      top_level_not_object: 0,
    },
    posts: {
      unique: 0,
      duplicate_ids: 0,
      with_pics: 0,
      with_vlm_analysis: 0,
      retweets: 0,
      with_geo_value: 0,
      with_valid_coordinate_pair: 0,
      with_china_coordinate_pair: 0,
      with_outside_china_coordinate_pair: 0,
      geo_lat_lng_order: 0,
      geo_unrecognized: 0,
      geo_placeholder_116_116: 0,
      geo_type_checkin: 0,
      geo_with_source_poi: 0,
      geo_with_source_poiid: 0,
      with_ip_region_name: 0,
      pic_count_mismatch: 0,
    },
    images: {
      declared: 0,
      analyzed: 0,
      duplicate_post_pic_index: 0,
      stage1_food_related_true: 0,
      stage1_food_related_false: 0,
      stage1_need_deep_analysis_true: 0,
      stage1_need_deep_analysis_false: 0,
      stage2_success: 0,
      stage2_not_requested: 0,
      stage2_other: 0,
    },
    poi_coverage_images: {
      with_restaurant_candidates: 0,
      with_place_clues: 0,
      with_visible_text: 0,
      with_any_location_field: 0,
    },
    poi_coverage_posts: {
      with_restaurant_candidates: 0,
      with_place_clues: 0,
      with_visible_text: 0,
      with_any_location_field: 0,
      with_multiple_distinct_restaurant_names: 0,
    },
    stage1_image_types: {},
    stage1_visual_importance: {},
    stage2_statuses: {},
    stage2_models: {},
    prompt_versions: {},
    image_roles: {},
    restaurant_scene_types: {},
    importance: {},
    candidate_sources: {},
    candidate_quality: {
      empty_name: 0,
      missing_confidence: 0,
      invalid_confidence: 0,
      missing_source: 0,
      invalid_source: 0,
      text_source_not_in_content: 0,
    },
    classification: {},
  };

  const invalidRows = [];
  const duplicateRows = [];
  const suspicious = [];
  const seenPostIds = new Map();
  const seenPostPic = new Map();

  const input = fs.createReadStream(inputPath, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;

  for await (const line of lines) {
    lineNumber += 1;
    metrics.rows.total += 1;

    if (line.trim().length === 0) {
      metrics.rows.blank += 1;
      continue;
    }

    let row;
    try {
      row = JSON.parse(line);
      metrics.rows.valid_json += 1;
    } catch (error) {
      metrics.rows.invalid_json += 1;
      invalidRows.push({
        line_number: lineNumber,
        error: error.message,
        raw_excerpt: line.slice(0, 240),
      });
      increment(metrics.classification, "Q_INVALID");
      continue;
    }

    if (!row || typeof row !== "object" || Array.isArray(row)) {
      metrics.rows.top_level_not_object += 1;
      invalidRows.push({
        line_number: lineNumber,
        error: "top_level_not_object",
      });
      increment(metrics.classification, "Q_INVALID");
      continue;
    }

    const postId = String(row.id ?? row.mid ?? `line:${lineNumber}`);
    if (seenPostIds.has(postId)) {
      metrics.posts.duplicate_ids += 1;
      duplicateRows.push({
        kind: "post_id",
        key: postId,
        first_line: seenPostIds.get(postId),
        duplicate_line: lineNumber,
      });
    } else {
      seenPostIds.set(postId, lineNumber);
    }

    if (row.retweet_of !== null && row.retweet_of !== undefined) {
      metrics.posts.retweets += 1;
    }

    const pics = Array.isArray(row.pics) ? row.pics : [];
    const analyses = Array.isArray(row.vlm_analysis) ? row.vlm_analysis : [];
    metrics.images.declared += pics.length;
    metrics.images.analyzed += analyses.length;
    if (pics.length > 0) metrics.posts.with_pics += 1;
    if (analyses.length > 0) metrics.posts.with_vlm_analysis += 1;
    if (pics.length !== analyses.length) {
      metrics.posts.pic_count_mismatch += 1;
      addSuspicious(suspicious, {
        post_id: postId,
        reason: "pics_vlm_analysis_count_mismatch",
        pics: pics.length,
        vlm_analysis: analyses.length,
      });
    }

    const hasGeoValue = hasValue(row.geo);
    const coordinate = hasGeoValue ? findCoordinatePair(row.geo) : null;
    if (hasGeoValue) metrics.posts.with_geo_value += 1;
    if (row.geo?.type === "checkin") metrics.posts.geo_type_checkin += 1;
    const sourcePoi =
      typeof row.geo?.poi === "string" ? row.geo.poi.trim() : "";
    const sourcePoiId =
      typeof row.geo?.poiid === "string" ? row.geo.poiid.trim() : "";
    if (sourcePoi && sourcePoi !== "(null)" && sourcePoi !== "null") {
      metrics.posts.geo_with_source_poi += 1;
    }
    if (sourcePoiId && sourcePoiId !== "(null)" && sourcePoiId !== "null") {
      metrics.posts.geo_with_source_poiid += 1;
    }
    if (
      Array.isArray(row.geo?.coordinates) &&
      Number(row.geo.coordinates[0]) === 116 &&
      Number(row.geo.coordinates[1]) === 116
    ) {
      metrics.posts.geo_placeholder_116_116 += 1;
    }
    if (coordinate) {
      metrics.posts.with_valid_coordinate_pair += 1;
      if (isInChinaBounds(coordinate.coordinates)) {
        metrics.posts.with_china_coordinate_pair += 1;
      } else {
        metrics.posts.with_outside_china_coordinate_pair += 1;
      }
      if (coordinate.order === "lat_lng") {
        metrics.posts.geo_lat_lng_order += 1;
      }
    } else if (hasGeoValue) {
      metrics.posts.geo_unrecognized += 1;
      addSuspicious(suspicious, {
        post_id: postId,
        reason: "geo_present_but_coordinate_unrecognized",
        geo_shape:
          row.geo && typeof row.geo === "object"
            ? Object.keys(row.geo)
            : typeof row.geo,
      });
    }
    if (typeof row.region_name === "string" && row.region_name.trim()) {
      metrics.posts.with_ip_region_name += 1;
    }

    const postState = {
      invalid: false,
      hasValidGeo: Boolean(coordinate),
      hasRestaurantCandidate: false,
      hasPlaceClue:
        Boolean(sourcePoi) &&
        sourcePoi !== "(null)" &&
        sourcePoi !== "null",
      hasUsefulVisibleText: false,
      hasRegionLikeClue: false,
      hasFoodEvidence: false,
    };
    const restaurantNames = new Set();

    for (const media of analyses) {
      const picIndex = media?.pic_index ?? "<missing>";
      const mediaKey = `${postId}:${picIndex}`;
      if (seenPostPic.has(mediaKey)) {
        metrics.images.duplicate_post_pic_index += 1;
        duplicateRows.push({
          kind: "post_id_pic_index",
          key: mediaKey,
          first_line: seenPostPic.get(mediaKey),
          duplicate_line: lineNumber,
        });
      } else {
        seenPostPic.set(mediaKey, lineNumber);
      }

      const stage1 = media?.stage1;
      if (stage1 && typeof stage1 === "object") {
        if (stage1.food_related === true) {
          metrics.images.stage1_food_related_true += 1;
          postState.hasFoodEvidence = true;
        } else if (stage1.food_related === false) {
          metrics.images.stage1_food_related_false += 1;
        }

        if (stage1.need_deep_analysis === true) {
          metrics.images.stage1_need_deep_analysis_true += 1;
        } else if (stage1.need_deep_analysis === false) {
          metrics.images.stage1_need_deep_analysis_false += 1;
        }
        increment(metrics.stage1_image_types, stage1.image_type);
        increment(metrics.stage1_visual_importance, stage1.visual_importance);
      }

      const stage2 = media?.stage2;
      const stage2Status = stage2?.status ?? "<missing>";
      increment(metrics.stage2_statuses, stage2Status);
      if (stage2Status === "success") metrics.images.stage2_success += 1;
      else if (stage2Status === "not_requested") {
        metrics.images.stage2_not_requested += 1;
      } else {
        metrics.images.stage2_other += 1;
      }

      if (stage2?.model) increment(metrics.stage2_models, stage2.model);
      if (stage2?.prompt_version) {
        increment(metrics.prompt_versions, stage2.prompt_version);
      }

      const analysis = stage2?.analysis;
      if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) {
        continue;
      }

      for (const field of ARRAY_FIELDS) {
        updateCoverage(fieldCoverage, analysis, field, "array");
      }
      for (const field of SCALAR_FIELDS) {
        updateCoverage(fieldCoverage, analysis, field, "string");
      }
      for (const field of OBJECT_FIELDS) {
        updateCoverage(fieldCoverage, analysis, field, "object");
      }

      increment(metrics.image_roles, analysis.image_role);
      increment(metrics.importance, analysis.importance);
      increment(metrics.restaurant_scene_types, analysis.restaurant_scene?.type);

      if (
        analysis.image_role !== undefined &&
        !VALID_IMAGE_ROLES.has(analysis.image_role)
      ) {
        addSuspicious(suspicious, {
          post_id: postId,
          pic_index: picIndex,
          reason: "invalid_image_role",
          value: analysis.image_role,
        });
      }
      if (
        analysis.importance !== undefined &&
        !VALID_IMPORTANCE.has(analysis.importance)
      ) {
        addSuspicious(suspicious, {
          post_id: postId,
          pic_index: picIndex,
          reason: "invalid_importance",
          value: analysis.importance,
        });
      }
      if (
        analysis.restaurant_scene?.type !== undefined &&
        !VALID_SCENES.has(analysis.restaurant_scene.type)
      ) {
        addSuspicious(suspicious, {
          post_id: postId,
          pic_index: picIndex,
          reason: "invalid_restaurant_scene_type",
          value: analysis.restaurant_scene.type,
        });
      }

      for (const field of [
        "dish_candidates",
        "food_categories",
        "cooking_methods",
        "cuisine_style",
        "place_clues",
        "restaurant_name_candidates",
        "visible_text",
        "ingredients_visible",
      ]) {
        checkCandidateArray({
          items: analysis[field],
          field,
          postId,
          picIndex,
          metrics,
          suspicious,
          content: row.content,
        });
      }

      const hasRestaurants = isNonEmptyArray(
        analysis.restaurant_name_candidates,
      );
      const hasPlaceClues = isNonEmptyArray(analysis.place_clues);
      const hasVisibleText = isNonEmptyArray(analysis.visible_text);

      if (hasRestaurants) {
        metrics.poi_coverage_images.with_restaurant_candidates += 1;
        postState.hasRestaurantCandidate = true;
        for (const item of analysis.restaurant_name_candidates) {
          const name = getCandidateName(item);
          if (name) restaurantNames.add(name);
        }
      }
      if (hasPlaceClues) {
        metrics.poi_coverage_images.with_place_clues += 1;
        postState.hasPlaceClue = true;
        for (const item of analysis.place_clues) {
          if (looksLikeRegion(getCandidateName(item))) {
            postState.hasRegionLikeClue = true;
          }
        }
      }
      if (hasVisibleText) {
        metrics.poi_coverage_images.with_visible_text += 1;
        postState.hasUsefulVisibleText = analysis.visible_text.some((item) => {
          return isUsefulVisibleText(getCandidateName(item));
        });
      }
      if (hasRestaurants || hasPlaceClues || hasVisibleText) {
        metrics.poi_coverage_images.with_any_location_field += 1;
      }

      if (
        isNonEmptyArray(analysis.dish_candidates) ||
        isNonEmptyArray(analysis.food_categories) ||
        isNonEmptyArray(analysis.cuisine_style) ||
        ["dish", "food_material", "food_scene", "restaurant", "menu"].includes(
          analysis.image_role,
        )
      ) {
        postState.hasFoodEvidence = true;
      }
    }

    if (postState.hasRestaurantCandidate) {
      metrics.poi_coverage_posts.with_restaurant_candidates += 1;
    }
    if (postState.hasPlaceClue) {
      metrics.poi_coverage_posts.with_place_clues += 1;
    }
    if (postState.hasUsefulVisibleText) {
      metrics.poi_coverage_posts.with_visible_text += 1;
    }
    if (
      postState.hasRestaurantCandidate ||
      postState.hasPlaceClue ||
      postState.hasUsefulVisibleText
    ) {
      metrics.poi_coverage_posts.with_any_location_field += 1;
    }
    if (restaurantNames.size > 1) {
      metrics.poi_coverage_posts.with_multiple_distinct_restaurant_names += 1;
      addSuspicious(suspicious, {
        post_id: postId,
        reason: "multiple_distinct_restaurant_candidates",
        names: [...restaurantNames].slice(0, 20),
      });
    }

    const category = classifyPost(postState);
    increment(metrics.classification, category);
  }

  metrics.posts.unique = seenPostIds.size;
  const inputSha256 = await sha256File(inputPath);
  const generatedAt = new Date().toISOString();

  const summary = {
    scan_version: "vlm_v2_scan_v1",
    generated_at: generatedAt,
    input: {
      path: inputPath,
      bytes: stat.size,
      modified_at: stat.mtime.toISOString(),
      sha256: inputSha256,
      encoding: "UTF-8",
    },
    metrics,
    gates: {
      json_parse_clean: metrics.rows.invalid_json === 0,
      no_duplicate_post_ids: metrics.posts.duplicate_ids === 0,
      no_duplicate_post_pic_index:
        metrics.images.duplicate_post_pic_index === 0,
      all_posts_linkable:
        metrics.posts.unique === metrics.rows.valid_json &&
        metrics.rows.top_level_not_object === 0,
      geo_requires_coordinate_system_review:
        metrics.posts.with_valid_coordinate_pair > 0,
      ready_for_limited_llm_pilot:
        metrics.rows.invalid_json === 0 &&
        metrics.posts.duplicate_ids === 0 &&
        metrics.rows.top_level_not_object === 0,
      ready_for_full_run: false,
      full_run_note:
        "This scanner never authorizes a full LLM or AMap run. Explicit user approval is required.",
    },
  };

  await Promise.all([
    writeJson(path.join(outputPath, "summary.json"), summary),
    writeJson(path.join(outputPath, "field_coverage.json"), fieldCoverage),
    writeJson(path.join(outputPath, "category_counts.json"), {
      classification_version: "poi_input_v1",
      generated_at: generatedAt,
      categories: metrics.classification,
    }),
    writeJsonl(path.join(outputPath, "invalid_rows.jsonl"), invalidRows),
    writeJsonl(path.join(outputPath, "duplicate_rows.jsonl"), duplicateRows),
    writeJsonl(
      path.join(outputPath, "suspicious_samples.jsonl"),
      suspicious,
    ),
  ]);

  console.log(
    JSON.stringify(
      {
        output: outputPath,
        rows: metrics.rows,
        posts: metrics.posts,
        images: metrics.images,
        poi_coverage_posts: metrics.poi_coverage_posts,
        classification: metrics.classification,
        gates: summary.gates,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
