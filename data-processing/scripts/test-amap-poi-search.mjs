#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  buildInput,
  loadEnvFile,
  readCandidates,
} from "./test-poi-query-llm.mjs";

const MAX_TEST_REQUESTS = 20;
const MAX_CONCURRENCY = 1;
const AMAP_BASE_URL = "https://restapi.amap.com/v5/place";
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

function parseArgs(argv) {
  const options = {
    source: "data-processing/data/vlm_results_v2_repaired_v2.jsonl",
    plans: "data-processing/data/analysis/poi_llm_full_v2/results.jsonl",
    output: "data-processing/data/analysis/amap_poi_test_v1",
    limit: 10,
    concurrency: 1,
    retries: 2,
    seed: "amap-poi-test-v1",
    radius: 5000,
    pageSize: 25,
    placeKinds: [
      "restaurant",
      "street_food",
      "market",
      "hotel_food",
      "attraction",
      "building",
    ],
    coordinateSystem: "unknown",
    execute: false,
    confirm: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source") options.source = argv[++index];
    else if (arg === "--plans") options.plans = argv[++index];
    else if (arg === "--output") options.output = argv[++index];
    else if (arg === "--limit") options.limit = Number(argv[++index]);
    else if (arg === "--concurrency") {
      options.concurrency = Number(argv[++index]);
    } else if (arg === "--retries") options.retries = Number(argv[++index]);
    else if (arg === "--seed") options.seed = argv[++index];
    else if (arg === "--radius") options.radius = Number(argv[++index]);
    else if (arg === "--page-size") options.pageSize = Number(argv[++index]);
    else if (arg === "--place-kinds") {
      options.placeKinds = argv[++index]
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    }
    else if (arg === "--coordinate-system") {
      options.coordinateSystem = argv[++index];
    } else if (arg === "--execute") options.execute = true;
    else if (arg === "--confirm") options.confirm = argv[++index];
    else if (arg === "--help") {
      console.log(`Usage:
  Dry run (text searches only while coordinates are unconfirmed):
    node data-processing/scripts/test-amap-poi-search.mjs --limit 10

  Execute a small AMap test:
    node data-processing/scripts/test-amap-poi-search.mjs \\
      --limit 10 --execute --confirm AMAP_TEST_ONLY

Options:
  --source <jsonl>      Repaired VLM source JSONL
  --plans <jsonl>       Validated LLM plan results
  --output <dir>        New empty output directory
  --limit <1-20>        Number of AMap requests; hard-capped at 20
  --concurrency <1>     AMap requests are forced to run serially
  --retries <0-2>       Default: 2
  --seed <text>         Deterministic request sampling seed
  --radius <0-50000>    Around-search radius in metres; default: 5000
  --page-size <1-25>    Default: 25
  --place-kinds <list>  Comma-separated POI kinds; region/other/unknown
                        are excluded by default
  --coordinate-system unknown|gcj02
                        Around requests require explicit gcj02 confirmation
  --execute             Actually call AMap
  --confirm AMAP_TEST_ONLY
                        Required together with --execute
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (
    !Number.isInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > MAX_TEST_REQUESTS
  ) {
    throw new Error(`--limit must be an integer from 1 to ${MAX_TEST_REQUESTS}`);
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
  if (
    !Number.isFinite(options.radius) ||
    options.radius < 0 ||
    options.radius > 50000
  ) {
    throw new Error("--radius must be from 0 to 50000");
  }
  if (
    !Number.isInteger(options.pageSize) ||
    options.pageSize < 1 ||
    options.pageSize > 25
  ) {
    throw new Error("--page-size must be an integer from 1 to 25");
  }
  if (!["unknown", "gcj02"].includes(options.coordinateSystem)) {
    throw new Error("--coordinate-system must be unknown or gcj02");
  }
  if (
    options.placeKinds.length === 0 ||
    options.placeKinds.some((kind) => !VALID_PLACE_KINDS.has(kind))
  ) {
    throw new Error("--place-kinds contains an unsupported or empty value");
  }
  if (options.execute && options.confirm !== "AMAP_TEST_ONLY") {
    throw new Error(
      "Network execution requires --execute and --confirm AMAP_TEST_ONLY",
    );
  }
  return options;
}

async function readJsonl(filePath) {
  const text = await fs.promises.readFile(filePath, "utf8");
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function hashRank(seed, requestId) {
  return crypto
    .createHash("sha256")
    .update(`${seed}:${requestId}`)
    .digest("hex");
}

function createRequest({ planResult, group, groupIndex, input, options }) {
  const requestId = `${planResult.post_id}__g${groupIndex}`;
  const endpoint = group.query.endpoint_hint;
  const parameters = {
    keywords: group.query.keyword,
    show_fields: "business,navi,photos",
    page_size: String(options.pageSize),
    page_num: "1",
    output: "json",
  };

  if (group.query.region_clues?.[0]) {
    parameters.region = group.query.region_clues[0];
    parameters.city_limit = "false";
  }

  let blockedReason = null;
  if (endpoint === "around") {
    if (!input.original_geo?.usable) {
      blockedReason = "around_without_usable_source_coordinate";
    } else if (!input.original_geo.in_china_bounds) {
      blockedReason = "around_coordinate_outside_china_bounds";
    } else if (options.coordinateSystem !== "gcj02") {
      blockedReason = "around_requires_explicit_gcj02_confirmation";
    } else {
      const [longitude, latitude] = input.original_geo.coordinates_lng_lat;
      parameters.location = `${longitude.toFixed(6)},${latitude.toFixed(6)}`;
      parameters.radius = String(options.radius);
      parameters.sortrule = "weight";
    }
  }

  return {
    request_id: requestId,
    post_id: planResult.post_id,
    input_category: planResult.input_category,
    group_index: groupIndex,
    candidate_indexes: group.candidate_indexes,
    place_kind: group.place_kind,
    role: group.role,
    confidence: group.confidence,
    endpoint,
    blocked_reason: blockedReason,
    path: `/v5/place/${endpoint}`,
    parameters,
    context: {
      region_clues: group.query.region_clues ?? [],
      address_clues: group.query.address_clues ?? [],
      original_geo: input.original_geo,
    },
  };
}

function selectStratified(requests, limit, seed) {
  const buckets = new Map([
    ["around", []],
    ["text", []],
  ]);
  for (const request of requests) {
    buckets.get(request.endpoint)?.push(request);
  }
  for (const bucket of buckets.values()) {
    bucket.sort((left, right) =>
      hashRank(seed, left.request_id).localeCompare(
        hashRank(seed, right.request_id),
      ),
    );
  }

  const selected = [];
  while (selected.length < limit) {
    let added = false;
    for (const endpoint of ["around", "text"]) {
      const item = buckets.get(endpoint).shift();
      if (item) {
        selected.push(item);
        added = true;
        if (selected.length === limit) break;
      }
    }
    if (!added) break;
  }
  return selected;
}

function safeFileStem(requestId) {
  return requestId.replace(/[^A-Za-z0-9_-]/g, "_");
}

function redactedUrl(request) {
  const url = new URL(`${AMAP_BASE_URL}/${request.endpoint}`);
  for (const [key, value] of Object.entries(request.parameters)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("key", "<redacted>");
  return url.toString();
}

async function callAmap(request, apiKey, retries) {
  let lastError;
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    try {
      const url = new URL(`${AMAP_BASE_URL}/${request.endpoint}`);
      for (const [key, value] of Object.entries(request.parameters)) {
        url.searchParams.set(key, value);
      }
      url.searchParams.set("key", apiKey);
      const response = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(30_000),
      });
      const rawResponseText = await response.text();
      let payload;
      try {
        payload = JSON.parse(rawResponseText);
      } catch {
        throw new Error(`AMap returned non-JSON HTTP ${response.status}`);
      }
      if (!response.ok) {
        throw new Error(`AMap HTTP ${response.status}: ${payload.info ?? ""}`);
      }
      if (String(payload.status) !== "1") {
        throw new Error(
          `AMap API error ${payload.infocode ?? "unknown"}: ${payload.info ?? ""}`,
        );
      }
      return {
        payload,
        raw_response_text: rawResponseText,
        attempt_count: attempt,
      };
    } catch (error) {
      lastError = error;
      if (attempt <= retries) {
        const waitMs = 500 * 2 ** (attempt - 1) + Math.random() * 500;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
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
  const sourcePath = path.resolve(options.source);
  const plansPath = path.resolve(options.plans);
  const outputPath = path.resolve(options.output);

  if (fs.existsSync(outputPath)) {
    const existing = await fs.promises.readdir(outputPath);
    if (existing.length > 0) {
      throw new Error(`Refusing to overwrite non-empty output: ${outputPath}`);
    }
  }
  await fs.promises.mkdir(outputPath, { recursive: true });

  loadEnvFile(path.resolve("data-processing/.env"));
  const apiKey = process.env.amap_key ?? process.env.AMAP_KEY;
  if (options.execute && !apiKey) {
    throw new Error("Missing amap_key or AMAP_KEY");
  }

  const [sourceCandidates, planResults] = await Promise.all([
    readCandidates(sourcePath),
    readJsonl(plansPath),
  ]);
  const inputsByPostId = new Map(
    sourceCandidates.map((item) => {
      const input = buildInput(item.row, item.state);
      return [input.post_id, input];
    }),
  );

  const requests = [];
  const exclusions = [];
  for (const planResult of planResults) {
    if (!planResult.validation?.valid) {
      exclusions.push({
        post_id: planResult.post_id,
        reason: "invalid_llm_plan",
      });
      continue;
    }
    const input = inputsByPostId.get(String(planResult.post_id));
    if (!input) {
      exclusions.push({
        post_id: planResult.post_id,
        reason: "source_input_not_found",
      });
      continue;
    }
    for (const [groupIndex, group] of planResult.plan.place_groups.entries()) {
      if (!group.should_query || !group.query) continue;
      if (!options.placeKinds.includes(group.place_kind)) {
        exclusions.push({
          post_id: planResult.post_id,
          group_index: groupIndex,
          place_kind: group.place_kind,
          reason: "place_kind_excluded",
        });
        continue;
      }
      const request = createRequest({
        planResult,
        group,
        groupIndex,
        input,
        options,
      });
      if (request.blocked_reason) exclusions.push(request);
      else requests.push(request);
    }
  }

  const selected = selectStratified(
    requests,
    options.limit,
    options.seed,
  ).map((request) => ({
    ...request,
    redacted_url: redactedUrl(request),
  }));

  const manifest = {
    script_version: "amap_poi_test_v1",
    generated_at: new Date().toISOString(),
    mode: options.execute ? "execute" : "dry_run",
    source: sourcePath,
    plans: plansPath,
    output: outputPath,
    seed: options.seed,
    requested_limit: options.limit,
    selected_count: selected.length,
    eligible_request_count: requests.length,
    excluded_count: exclusions.length,
    endpoint_counts: {
      around: selected.filter((item) => item.endpoint === "around").length,
      text: selected.filter((item) => item.endpoint === "text").length,
    },
    coordinate_system_assertion: options.coordinateSystem,
    place_kinds: options.placeKinds,
    concurrency: options.concurrency,
    retries: options.retries,
    amap_called: options.execute,
  };
  await writeJson(path.join(outputPath, "manifest.json"), manifest);
  await writeJsonl(path.join(outputPath, "requests.jsonl"), selected);
  await writeJsonl(path.join(outputPath, "exclusions.jsonl"), exclusions);

  if (!options.execute) {
    console.log(JSON.stringify(manifest, null, 2));
    console.log("Dry run only: no AMap request was sent.");
    return;
  }

  const rawPath = path.join(outputPath, "raw_responses");
  await fs.promises.mkdir(rawPath, { recursive: true });
  const resultSlots = new Array(selected.length);
  const errorSlots = new Array(selected.length);
  let cursor = 0;

  async function worker() {
    while (cursor < selected.length) {
      const index = cursor;
      cursor += 1;
      const request = selected[index];
      try {
        const response = await callAmap(request, apiKey, options.retries);
        const rawFile = path.join(
          rawPath,
          `${safeFileStem(request.request_id)}.json`,
        );
        await fs.promises.writeFile(
          rawFile,
          response.raw_response_text,
          "utf8",
        );
        resultSlots[index] = {
          request_id: request.request_id,
          post_id: request.post_id,
          group_index: request.group_index,
          endpoint: request.endpoint,
          keyword: request.parameters.keywords,
          status: response.payload.status,
          info: response.payload.info,
          infocode: response.payload.infocode,
          count: response.payload.count,
          pois: response.payload.pois ?? [],
          attempt_count: response.attempt_count,
          raw_response_file: path.relative(outputPath, rawFile),
        };
      } catch (error) {
        errorSlots[index] = {
          request_id: request.request_id,
          post_id: request.post_id,
          error: error.message,
          attempt_count: error.attempt_count ?? options.retries + 1,
        };
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(options.concurrency, selected.length) },
      () => worker(),
    ),
  );
  const results = resultSlots.filter(Boolean);
  const errors = errorSlots.filter(Boolean);
  await writeJsonl(path.join(outputPath, "results.jsonl"), results);
  await writeJsonl(path.join(outputPath, "errors.jsonl"), errors);
  await writeJson(path.join(outputPath, "run_summary.json"), {
    ...manifest,
    completed_at: new Date().toISOString(),
    success_count: results.length,
    error_count: errors.length,
    total_poi_count: results.reduce(
      (sum, result) => sum + Number(result.count ?? 0),
      0,
    ),
    amap_called: true,
  });
  console.log(
    JSON.stringify({
      selected: selected.length,
      success: results.length,
      errors: errors.length,
      output: outputPath,
      amap_called: true,
    }),
  );
}

export {
  callAmap,
  createRequest,
  readJsonl,
  safeFileStem,
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
