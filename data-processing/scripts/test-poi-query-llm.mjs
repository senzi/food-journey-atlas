#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const ALLOWED_CATEGORIES = new Set([
  "A_GEO_RESTAURANT",
  "B_GEO_PLACE_CLUE",
  "C_NAME_REGION",
  "D_NAME_ONLY",
  "E_AMBIGUOUS_TEXT",
]);
const VALID_PLACE_KINDS = new Set([
  "restaurant",
  "street_food",
  "market",
  "hotel_food",
  "attraction",
  "building",
  "region",
  "other",
  "unknown",
]);
const VALID_ENDPOINTS = new Set(["around", "text", "none"]);
const VALID_KEYWORD_KINDS = new Set([
  "restaurant_name",
  "place_name",
  "address_fragment",
  "market_name",
  "building_name",
  "other",
]);
const VALID_RELATIONSHIPS = new Set([
  "single_candidate",
  "same_place_alias",
  "same_brand_branch_uncertain",
  "historical_or_renamed",
  "not_a_place",
  "insufficient_evidence",
]);
const VALID_ROLES = new Set([
  "primary_visit",
  "secondary_visit",
  "comparison_only",
  "mentioned_only",
  "delivery_only",
  "unknown",
]);
const MAX_TEST_LIMIT = 20;
const MAX_QUERIES_PER_POST = 5;
const MAX_CONCURRENCY = 5;

function parseArgs(argv) {
  const options = {
    input: "data-processing/data/vlm_results_v2_repaired_v2.jsonl",
    output: "data-processing/data/analysis/poi_llm_pilot_groups_v2",
    prompt: "data-processing/prompts/poi-query-plan-v2.md",
    model: "deepseek-v4-flash",
    baseUrl: "https://api.deepseek.com",
    limit: 10,
    concurrency: 3,
    retries: 2,
    postIds: [],
    seed: "poi-pilot-v1",
    execute: false,
    confirm: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") options.input = argv[++index];
    else if (arg === "--output") options.output = argv[++index];
    else if (arg === "--prompt") options.prompt = argv[++index];
    else if (arg === "--model") options.model = argv[++index];
    else if (arg === "--base-url") options.baseUrl = argv[++index];
    else if (arg === "--limit") options.limit = Number(argv[++index]);
    else if (arg === "--concurrency") {
      options.concurrency = Number(argv[++index]);
    }
    else if (arg === "--retries") options.retries = Number(argv[++index]);
    else if (arg === "--post-ids") {
      options.postIds = argv[++index]
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    }
    else if (arg === "--seed") options.seed = argv[++index];
    else if (arg === "--execute") options.execute = true;
    else if (arg === "--confirm") options.confirm = argv[++index];
    else if (arg === "--help") {
      console.log(`Usage:
  Dry run:
    node data-processing/scripts/test-poi-query-llm.mjs --limit 10

  Execute a small test after explicit approval:
    node data-processing/scripts/test-poi-query-llm.mjs --limit 10 --execute --confirm TEST_ONLY

Options:
  --input <jsonl>       Default: data-processing/data/vlm_results_v2_repaired_v2.jsonl
  --output <dir>        Default: data-processing/data/analysis/poi_llm_pilot_groups_v2
  --prompt <file>       Default: data-processing/prompts/poi-query-plan-v2.md
  --model <name>        Default: deepseek-v4-flash
  --base-url <url>      Default: https://api.deepseek.com
  --limit <1-20>        Hard-capped at 20
  --concurrency <1-5>   Concurrent LLM requests; default: 3
  --retries <0-2>       Retries per failed LLM request; default: 2
  --post-ids <ids>      Comma-separated post IDs for a targeted test/retry
  --seed <text>         Deterministic sample seed
  --execute             Actually call the LLM
  --confirm TEST_ONLY   Required together with --execute
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(options.limit) || options.limit < 1) {
    throw new Error("--limit must be a positive integer");
  }
  if (options.limit > MAX_TEST_LIMIT) {
    throw new Error(
      `Refusing limit ${options.limit}; this test script is hard-capped at ${MAX_TEST_LIMIT}`,
    );
  }
  if (
    !Number.isInteger(options.concurrency) ||
    options.concurrency < 1 ||
    options.concurrency > MAX_CONCURRENCY
  ) {
    throw new Error(
      `--concurrency must be an integer from 1 to ${MAX_CONCURRENCY}`,
    );
  }
  if (
    !Number.isInteger(options.retries) ||
    options.retries < 0 ||
    options.retries > 2
  ) {
    throw new Error("--retries must be an integer from 0 to 2");
  }
  if (options.postIds.length > MAX_TEST_LIMIT) {
    throw new Error(
      `Refusing ${options.postIds.length} post IDs; hard limit is ${MAX_TEST_LIMIT}`,
    );
  }
  if (options.execute && options.confirm !== "TEST_ONLY") {
    throw new Error(
      "Network execution requires both --execute and --confirm TEST_ONLY",
    );
  }

  return options;
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!Object.hasOwn(process.env, key)) process.env[key] = value;
  }
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

function isInChinaBounds(longitude, latitude) {
  return (
    longitude >= 73 &&
    longitude <= 136 &&
    latitude >= 3 &&
    latitude <= 54
  );
}

function parseOriginalGeo(geo) {
  if (!hasValue(geo) || !Array.isArray(geo.coordinates)) {
    return {
      usable: false,
      reason: "missing_or_unrecognized",
      raw_type: geo?.type ?? null,
    };
  }

  const [firstRaw, secondRaw] = geo.coordinates;
  const first = Number(firstRaw);
  const second = Number(secondRaw);

  if (first === second) {
    return {
      usable: false,
      reason: "equal_coordinate_placeholder",
      coordinates_source_order: [firstRaw, secondRaw],
      raw_type: geo.type || null,
    };
  }

  if (isLatitude(first) && isLongitude(second)) {
    return {
      usable: true,
      source_order: "lat_lng",
      coordinates_source_order: [first, second],
      coordinates_lng_lat: [second, first],
      in_china_bounds: isInChinaBounds(second, first),
      coordinate_system: "unknown_requires_review",
      raw_type: geo.type || null,
      source_poi: normalizeNullableText(geo.poi),
      source_poiid: normalizeNullableText(geo.poiid),
    };
  }

  if (isLongitude(first) && isLatitude(second)) {
    return {
      usable: true,
      source_order: "lng_lat",
      coordinates_source_order: [first, second],
      coordinates_lng_lat: [first, second],
      in_china_bounds: isInChinaBounds(first, second),
      coordinate_system: "unknown_requires_review",
      raw_type: geo.type || null,
      source_poi: normalizeNullableText(geo.poi),
      source_poiid: normalizeNullableText(geo.poiid),
    };
  }

  return {
    usable: false,
    reason: "out_of_range_or_placeholder",
    coordinates_source_order: [firstRaw, secondRaw],
    raw_type: geo.type || null,
  };
}

function normalizeNullableText(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text === "(null)" || text.toLowerCase() === "null") return null;
  return text;
}

function getName(item) {
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

function looksLikeRegion(name) {
  return (
    typeof name === "string" &&
    name.length >= 2 &&
    name.length <= 20 &&
    /(省|市|区|县|州|盟|旗|镇|乡|街道|新区|地区)$/.test(name)
  );
}

function collectPostState(row) {
  const geo = parseOriginalGeo(row.geo);
  let hasRestaurant = false;
  let hasPlace = Boolean(geo.source_poi);
  let hasVisibleText = false;
  let hasRegion = false;
  let hasFood = false;

  for (const media of Array.isArray(row.vlm_analysis) ? row.vlm_analysis : []) {
    const stage1 = media?.stage1;
    const analysis = media?.stage2?.analysis;
    if (stage1?.food_related === true) hasFood = true;
    if (!analysis || typeof analysis !== "object") continue;

    if (Array.isArray(analysis.restaurant_name_candidates)) {
      hasRestaurant ||= analysis.restaurant_name_candidates.length > 0;
    }
    if (Array.isArray(analysis.place_clues)) {
      hasPlace ||= analysis.place_clues.length > 0;
      hasRegion ||= analysis.place_clues.some((item) =>
        looksLikeRegion(getName(item)),
      );
    }
    if (Array.isArray(analysis.visible_text)) {
      hasVisibleText ||= analysis.visible_text.some((item) =>
        isUsefulVisibleText(getName(item)),
      );
    }
    hasFood ||=
      ["dish", "food_material", "food_scene", "restaurant", "menu"].includes(
        analysis.image_role,
      ) ||
      (Array.isArray(analysis.dish_candidates) &&
        analysis.dish_candidates.length > 0);
  }

  let category;
  if (geo.usable && hasRestaurant) category = "A_GEO_RESTAURANT";
  else if (geo.usable && (hasPlace || hasVisibleText)) {
    category = "B_GEO_PLACE_CLUE";
  } else if (hasRestaurant && hasRegion) category = "C_NAME_REGION";
  else if (hasRestaurant) category = "D_NAME_ONLY";
  else if (hasPlace || hasVisibleText) category = "E_AMBIGUOUS_TEXT";
  else if (hasFood) category = "F_FOOD_ONLY";
  else category = "G_NON_MAP";

  return { geo, category };
}

function compactAnalysis(media) {
  const analysis = media?.stage2?.analysis;
  return {
    pic_index: media?.pic_index ?? null,
    stage1: {
      food_related: media?.stage1?.food_related ?? null,
      image_type: media?.stage1?.image_type ?? null,
      description: media?.stage1?.description ?? "",
      confidence: media?.stage1?.confidence ?? null,
    },
    stage2_status: media?.stage2?.status ?? "missing",
    analysis:
      analysis && typeof analysis === "object"
        ? {
            summary: analysis.summary ?? "",
            image_role: analysis.image_role ?? "unknown",
            restaurant_scene: analysis.restaurant_scene ?? null,
            visible_text: analysis.visible_text ?? [],
            place_clues: analysis.place_clues ?? [],
            restaurant_name_candidates:
              analysis.restaurant_name_candidates ?? [],
            dish_candidates: analysis.dish_candidates ?? [],
            cuisine_style: analysis.cuisine_style ?? [],
            notes: analysis.notes ?? "",
          }
        : null,
  };
}

function buildPoiCandidates(row, geo) {
  const candidatesByName = new Map();

  function addCandidate({
    name,
    candidateKind,
    source,
    confidence = null,
    picIndex = null,
  }) {
    const cleanName = typeof name === "string" ? name.trim() : "";
    if (!cleanName) return;
    const record = candidatesByName.get(cleanName) ?? {
      name: cleanName,
      candidate_kinds: new Set(),
      sources: new Set(),
      confidences: [],
      pic_indexes: new Set(),
      occurrences: 0,
    };
    record.candidate_kinds.add(candidateKind);
    if (source) record.sources.add(source);
    if (Number.isFinite(Number(confidence))) {
      record.confidences.push(Number(confidence));
    }
    if (Number.isInteger(picIndex)) record.pic_indexes.add(picIndex);
    record.occurrences += 1;
    candidatesByName.set(cleanName, record);
  }

  if (geo.source_poi) {
    addCandidate({
      name: geo.source_poi,
      candidateKind: "source_geo_poi",
      source: "source_geo",
    });
  }

  for (const media of Array.isArray(row.vlm_analysis)
    ? row.vlm_analysis
    : []) {
    const analysis = media?.stage2?.analysis;
    if (!analysis || typeof analysis !== "object") continue;
    for (const item of Array.isArray(analysis.restaurant_name_candidates)
      ? analysis.restaurant_name_candidates
      : []) {
      addCandidate({
        name: getName(item),
        candidateKind: "restaurant_name",
        source: item?.source ?? "unknown",
        confidence: item?.confidence,
        picIndex: media.pic_index,
      });
    }
    for (const item of Array.isArray(analysis.place_clues)
      ? analysis.place_clues
      : []) {
      addCandidate({
        name: getName(item),
        candidateKind: "place_clue",
        source: item?.source ?? "unknown",
        confidence: item?.confidence,
        picIndex: media.pic_index,
      });
    }
  }

  return [...candidatesByName.values()].map((record, candidateIndex) => ({
    candidate_index: candidateIndex,
    name: record.name,
    candidate_kinds: [...record.candidate_kinds],
    sources: [...record.sources],
    confidence_min:
      record.confidences.length > 0
        ? Math.min(...record.confidences)
        : null,
    confidence_max:
      record.confidences.length > 0
        ? Math.max(...record.confidences)
        : null,
    pic_indexes: [...record.pic_indexes].sort((left, right) => left - right),
    occurrences: record.occurrences,
    exact_in_content:
      typeof row.content === "string" && row.content.includes(record.name),
  }));
}

function buildInput(row, state) {
  return {
    post_id: String(row.id ?? row.mid),
    content: typeof row.content === "string" ? row.content : "",
    created_at: row.created_at ?? null,
    original_geo: state.geo,
    ip_region_name:
      typeof row.region_name === "string" ? row.region_name : "",
    input_category: state.category,
    poi_candidates: buildPoiCandidates(row, state.geo),
    images: (Array.isArray(row.vlm_analysis) ? row.vlm_analysis : []).map(
      compactAnalysis,
    ),
  };
}

function hashRank(seed, postId) {
  return crypto
    .createHash("sha256")
    .update(`${seed}:${postId}`)
    .digest("hex");
}

function selectStratified(rows, limit, seed) {
  const grouped = new Map(
    [...ALLOWED_CATEGORIES].map((category) => [category, []]),
  );

  for (const item of rows) {
    if (grouped.has(item.state.category)) {
      grouped.get(item.state.category).push(item);
    }
  }

  for (const items of grouped.values()) {
    items.sort((left, right) =>
      hashRank(seed, left.postId).localeCompare(hashRank(seed, right.postId)),
    );
  }

  const selected = [];
  const categories = [...ALLOWED_CATEGORIES];
  let cursor = 0;
  while (selected.length < limit) {
    let added = false;
    for (let offset = 0; offset < categories.length; offset += 1) {
      const category = categories[(cursor + offset) % categories.length];
      const item = grouped.get(category).shift();
      if (item) {
        selected.push(item);
        added = true;
        if (selected.length === limit) break;
      }
    }
    if (!added) break;
    cursor = (cursor + 1) % categories.length;
  }

  return selected;
}

function buildEvidenceCorpus(input) {
  const values = [
    input.content,
    input.original_geo?.source_poi ?? "",
    ...(input.poi_candidates ?? []).map((item) => item.name),
  ];
  for (const image of input.images) {
    values.push(image.stage1?.description ?? "", image.analysis?.summary ?? "");
    for (const field of [
      "visible_text",
      "place_clues",
      "restaurant_name_candidates",
    ]) {
      for (const item of image.analysis?.[field] ?? []) {
        values.push(getName(item));
      }
    }
  }
  return values.filter(Boolean);
}

function validatePlan(plan, input) {
  const errors = [];
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return ["top_level_not_object"];
  }
  if (Object.hasOwn(plan, "post_id")) errors.push("unexpected_post_id");
  if (!Array.isArray(plan.place_groups)) {
    return [...errors, "place_groups_not_array"];
  }
  if (!Array.isArray(plan.unassigned_candidates)) {
    errors.push("unassigned_candidates_not_array");
  }

  const validIndexes = new Set(
    (input.poi_candidates ?? []).map((item) => item.candidate_index),
  );
  const usedIndexes = new Set();
  const corpus = buildEvidenceCorpus(input);
  let queryCount = 0;

  for (const [groupIndex, group] of plan.place_groups.entries()) {
    if (!group || typeof group !== "object" || Array.isArray(group)) {
      errors.push(`group_${groupIndex}_not_object`);
      continue;
    }
    if (
      !Array.isArray(group.candidate_indexes) ||
      group.candidate_indexes.length === 0
    ) {
      errors.push(`group_${groupIndex}_candidate_indexes_invalid`);
    } else {
      for (const candidateIndex of group.candidate_indexes) {
        if (!Number.isInteger(candidateIndex) || !validIndexes.has(candidateIndex)) {
          errors.push(`group_${groupIndex}_unknown_candidate_index`);
        } else if (usedIndexes.has(candidateIndex)) {
          errors.push(`candidate_${candidateIndex}_assigned_more_than_once`);
        } else {
          usedIndexes.add(candidateIndex);
        }
      }
    }
    if (!VALID_RELATIONSHIPS.has(group.relationship)) {
      errors.push(`group_${groupIndex}_invalid_relationship`);
    }
    if (
      group.relationship === "same_place_alias" &&
      group.candidate_indexes?.length < 2
    ) {
      errors.push(`group_${groupIndex}_alias_group_has_fewer_than_two_candidates`);
    }
    if (group.relationship === "same_place_alias") {
      for (const candidateIndex of group.candidate_indexes ?? []) {
        const candidate = input.poi_candidates.find(
          (item) => item.candidate_index === candidateIndex,
        );
        if (
          candidate?.candidate_kinds?.length === 1 &&
          candidate.candidate_kinds[0] === "place_clue"
        ) {
          errors.push(
            `group_${groupIndex}_alias_contains_place_clue_only_candidate_${candidateIndex}`,
          );
        }
      }
    }
    if (!VALID_PLACE_KINDS.has(group.place_kind)) {
      errors.push(`group_${groupIndex}_invalid_place_kind`);
    }
    if (!VALID_ROLES.has(group.role)) {
      errors.push(`group_${groupIndex}_invalid_role`);
    }
    if (typeof group.should_query !== "boolean") {
      errors.push(`group_${groupIndex}_should_query_not_boolean`);
    }
    const confidence = Number(group.confidence);
    if (
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1
    ) {
      errors.push(`group_${groupIndex}_invalid_confidence`);
    }
    if (!Array.isArray(group.evidence) || group.evidence.length === 0) {
      errors.push(`group_${groupIndex}_missing_evidence`);
    }

    if (group.should_query === false) {
      if (group.query !== null) {
        errors.push(`group_${groupIndex}_query_should_be_null`);
      }
      continue;
    }

    if (
      ["not_a_place", "insufficient_evidence"].includes(group.relationship)
    ) {
      errors.push(`group_${groupIndex}_weak_relationship_must_not_query`);
    }

    queryCount += 1;
    const query = group.query;
    if (!query || typeof query !== "object" || Array.isArray(query)) {
      errors.push(`group_${groupIndex}_query_not_object`);
      continue;
    }
    const keyword =
      typeof query.keyword === "string" ? query.keyword.trim() : "";
    if (!keyword) errors.push(`group_${groupIndex}_empty_keyword`);
    if (keyword.length > 80) {
      errors.push(`group_${groupIndex}_keyword_too_long`);
    }
    if (!VALID_KEYWORD_KINDS.has(query.keyword_kind)) {
      errors.push(`group_${groupIndex}_invalid_keyword_kind`);
    }
    if (!VALID_ENDPOINTS.has(query.endpoint_hint) || query.endpoint_hint === "none") {
      errors.push(`group_${groupIndex}_invalid_endpoint_hint`);
    }
    if (keyword && !corpus.some((text) => text.includes(keyword))) {
      errors.push(`group_${groupIndex}_keyword_not_in_evidence`);
    }
    if (
      query.keyword_kind === "restaurant_name" &&
      /(未具名|这家(?:餐厅|店)|一家(?:餐厅|料理店|饭店)|喜欢的(?:餐厅|料理店|饭店))/.test(
        keyword,
      )
    ) {
      errors.push(`group_${groupIndex}_generic_restaurant_description_as_keyword`);
    }
    if (query.endpoint_hint === "around" && !input.original_geo.usable) {
      errors.push(`group_${groupIndex}_around_without_usable_geo`);
    }
  }

  for (const [index, item] of (plan.unassigned_candidates ?? []).entries()) {
    const candidateIndex = item?.candidate_index;
    if (!Number.isInteger(candidateIndex) || !validIndexes.has(candidateIndex)) {
      errors.push(`unassigned_${index}_unknown_candidate_index`);
    } else if (usedIndexes.has(candidateIndex)) {
      errors.push(`candidate_${candidateIndex}_assigned_more_than_once`);
    } else {
      usedIndexes.add(candidateIndex);
    }
    if (typeof item?.reason !== "string" || !item.reason.trim()) {
      errors.push(`unassigned_${index}_missing_reason`);
    }
  }

  for (const candidateIndex of validIndexes) {
    if (!usedIndexes.has(candidateIndex)) {
      errors.push(`candidate_${candidateIndex}_not_accounted_for`);
    }
  }
  if (queryCount > MAX_QUERIES_PER_POST) errors.push("too_many_queries");
  return errors;
}

async function readCandidates(inputPath) {
  const candidates = [];
  const input = fs.createReadStream(inputPath, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });

  for await (const line of lines) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    const state = collectPostState(row);
    if (!ALLOWED_CATEGORIES.has(state.category)) continue;
    candidates.push({
      postId: String(row.id ?? row.mid),
      row,
      state,
    });
  }
  return candidates;
}

async function callDeepSeek({ baseUrl, apiKey, model, systemPrompt, input }) {
  const modelInput = { ...input };
  delete modelInput.post_id;
  const response = await fetch(
    `${baseUrl.replace(/\/+$/, "")}/chat/completions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content:
              "请根据以下输入生成 JSON 检索计划：\n" +
              JSON.stringify(modelInput),
          },
        ],
        response_format: { type: "json_object" },
        thinking: { type: "disabled" },
        temperature: 0.1,
        max_tokens: 3000,
        stream: false,
      }),
      signal: AbortSignal.timeout(120_000),
    },
  );

  const rawResponseText = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(rawResponseText);
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const safeMessage =
      payload?.error?.message ?? `HTTP ${response.status}`;
    throw new Error(safeMessage);
  }

  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("LLM returned empty content");
  }

  return {
    plan: JSON.parse(content),
    usage: payload.usage ?? null,
    response_id: payload.id ?? null,
    response_model: payload.model ?? model,
    finish_reason: payload.choices?.[0]?.finish_reason ?? null,
    raw_response_text: rawResponseText,
  };
}

async function callDeepSeekWithRetry(args, retries) {
  let lastError;
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    try {
      const response = await callDeepSeek(args);
      return { ...response, attempt_count: attempt };
    } catch (error) {
      lastError = error;
      if (attempt <= retries) {
        const jitterMs = Math.floor(Math.random() * 1000);
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            (attempt === 1 ? 1000 : 2500) + jitterMs,
          ),
        );
      }
    }
  }
  lastError.attempt_count = retries + 1;
  throw lastError;
}

async function writeJson(filePath, value) {
  await fs.promises.writeFile(
    filePath,
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

async function writeJsonl(filePath, values) {
  const content = values.length
    ? `${values.map((value) => JSON.stringify(value)).join("\n")}\n`
    : "";
  await fs.promises.writeFile(filePath, content, "utf8");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(options.input);
  const outputPath = path.resolve(options.output);
  const promptPath = path.resolve(options.prompt);
  loadEnvFile(path.resolve("data-processing/.env"));

  const apiKey = process.env.deepseek_key ?? process.env.DEEPSEEK_API_KEY;
  if (options.execute && !apiKey) {
    throw new Error(
      "Missing deepseek_key or DEEPSEEK_API_KEY; refusing network execution",
    );
  }

  const [systemPrompt, candidates] = await Promise.all([
    fs.promises.readFile(promptPath, "utf8"),
    readCandidates(inputPath),
  ]);
  let selected;
  if (options.postIds.length > 0) {
    const requestedIds = new Set(options.postIds);
    selected = candidates.filter((item) => requestedIds.has(item.postId));
    const foundIds = new Set(selected.map((item) => item.postId));
    const missingIds = options.postIds.filter((postId) => !foundIds.has(postId));
    if (missingIds.length > 0) {
      throw new Error(`Requested post IDs not found: ${missingIds.join(", ")}`);
    }
    if (selected.length > options.limit) {
      throw new Error(
        `Targeted post count ${selected.length} exceeds --limit ${options.limit}`,
      );
    }
  } else {
    selected = selectStratified(candidates, options.limit, options.seed);
  }
  if (fs.existsSync(outputPath)) {
    const existing = await fs.promises.readdir(outputPath);
    if (existing.length > 0) {
      throw new Error(
        `Refusing to overwrite non-empty test output directory: ${outputPath}`,
      );
    }
  }
  await fs.promises.mkdir(outputPath, { recursive: true });

  const inputs = selected.map((item) => buildInput(item.row, item.state));
  const manifest = {
    script_version: "poi_llm_pilot_v2_1",
    generated_at: new Date().toISOString(),
    mode: options.execute ? "execute" : "dry_run",
    input: inputPath,
    prompt: promptPath,
    prompt_sha256: crypto
      .createHash("sha256")
      .update(systemPrompt)
      .digest("hex"),
    model: options.model,
    base_url: options.baseUrl,
    seed: options.seed,
    requested_limit: options.limit,
    concurrency: options.concurrency,
    retries: options.retries,
    selection_mode: options.postIds.length > 0 ? "post_ids" : "stratified",
    requested_post_ids: options.postIds,
    selected_count: inputs.length,
    category_counts: Object.fromEntries(
      [...ALLOWED_CATEGORIES].map((category) => [
        category,
        inputs.filter((input) => input.input_category === category).length,
      ]),
    ),
    safety: {
      hard_limit: MAX_TEST_LIMIT,
      full_run_supported: false,
      amap_called: false,
    },
  };

  await writeJson(path.join(outputPath, "pilot_manifest.json"), manifest);
  await writeJsonl(path.join(outputPath, "pilot_inputs.jsonl"), inputs);
  await fs.promises.writeFile(
    path.join(outputPath, "prompt_snapshot.md"),
    systemPrompt,
    { encoding: "utf8", flag: "wx" },
  );

  if (!options.execute) {
    console.log(JSON.stringify(manifest, null, 2));
    console.log(
      "Dry run only: no LLM or AMap request was sent. Review pilot_inputs.jsonl first.",
    );
    return;
  }

  const resultSlots = new Array(inputs.length);
  const errorSlots = new Array(inputs.length);
  let nextInputIndex = 0;

  async function worker() {
    while (nextInputIndex < inputs.length) {
      const inputIndex = nextInputIndex;
      nextInputIndex += 1;
      const input = inputs[inputIndex];

    try {
      const response = await callDeepSeekWithRetry(
        {
          baseUrl: options.baseUrl,
          apiKey,
          model: options.model,
          systemPrompt,
          input,
        },
        options.retries,
      );
      const validationErrors = validatePlan(response.plan, input);
      resultSlots[inputIndex] = {
        post_id: input.post_id,
        input_category: input.input_category,
        plan: response.plan,
        validation: {
          valid: validationErrors.length === 0,
          errors: validationErrors,
        },
        usage: response.usage,
        response_id: response.response_id,
        response_model: response.response_model,
        finish_reason: response.finish_reason,
        attempt_count: response.attempt_count,
      };
    } catch (error) {
      errorSlots[inputIndex] = {
        post_id: input.post_id,
        input_category: input.input_category,
        error: error.message,
        attempt_count: error.attempt_count ?? options.retries + 1,
      };
    }
    }
  }

  const workerCount = Math.min(options.concurrency, inputs.length);
  await Promise.all(
    Array.from({ length: workerCount }, () => worker()),
  );
  const results = resultSlots.filter(Boolean);
  const errors = errorSlots.filter(Boolean);

  await writeJsonl(path.join(outputPath, "pilot_results.jsonl"), results);
  await writeJsonl(path.join(outputPath, "pilot_errors.jsonl"), errors);
  await writeJson(path.join(outputPath, "pilot_run_summary.json"), {
    ...manifest,
    completed_at: new Date().toISOString(),
    success_count: results.length,
    valid_plan_count: results.filter((item) => item.validation.valid).length,
    invalid_plan_count: results.filter((item) => !item.validation.valid).length,
    error_count: errors.length,
    amap_called: false,
  });

  console.log(
    JSON.stringify(
      {
        selected: inputs.length,
        success: results.length,
        valid_plans: results.filter((item) => item.validation.valid).length,
        errors: errors.length,
        output: outputPath,
        amap_called: false,
      },
      null,
      2,
    ),
  );
}

export {
  ALLOWED_CATEGORIES,
  MAX_QUERIES_PER_POST,
  buildInput,
  callDeepSeekWithRetry,
  loadEnvFile,
  parseOriginalGeo,
  readCandidates,
  validatePlan,
};

const isDirectRun =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
