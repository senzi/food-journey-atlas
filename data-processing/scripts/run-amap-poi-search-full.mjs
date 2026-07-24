#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  buildInput,
  loadEnvFile,
  readCandidates,
} from "./test-poi-query-llm.mjs";
import {
  callAmap,
  createRequest,
  readJsonl,
  safeFileStem,
} from "./test-amap-poi-search.mjs";

const DEFAULT_PLACE_KINDS = [
  "restaurant",
  "street_food",
  "market",
  "hotel_food",
  "attraction",
  "building",
];

function parseArgs(argv) {
  const options = {
    source: "data-processing/data/vlm_results_v2_repaired_v2.jsonl",
    plans: "data-processing/data/analysis/poi_llm_full_v2/results.jsonl",
    output: "data-processing/data/analysis/amap_poi_full_text_v1",
    retries: 2,
    radius: 5000,
    pageSize: 25,
    placeKinds: [...DEFAULT_PLACE_KINDS],
    execute: false,
    confirm: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source") options.source = argv[++index];
    else if (arg === "--plans") options.plans = argv[++index];
    else if (arg === "--output") options.output = argv[++index];
    else if (arg === "--retries") options.retries = Number(argv[++index]);
    else if (arg === "--page-size") options.pageSize = Number(argv[++index]);
    else if (arg === "--place-kinds") {
      options.placeKinds = argv[++index]
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    } else if (arg === "--execute") options.execute = true;
    else if (arg === "--confirm") options.confirm = argv[++index];
    else if (arg === "--help") {
      console.log(`Usage:
  Dry run:
    node data-processing/scripts/run-amap-poi-search-full.mjs

  Execute/resume all eligible requests serially:
    node data-processing/scripts/run-amap-poi-search-full.mjs \\
      --execute --confirm FULL_AMAP_RUN

Options:
  --source <jsonl>      Repaired VLM source JSONL
  --plans <jsonl>       Full validated LLM result JSONL
  --output <dir>        Resumable output directory
  --retries <0-2>       Default: 2
  --page-size <1-25>    Default: 25
  --place-kinds <list>  Default: restaurant,street_food,market,
                        hotel_food,attraction,building
  --execute             Actually call AMap, always serially
  --confirm FULL_AMAP_RUN
                        Required together with --execute

All LLM around plans are temporarily executed as text searches because the
source coordinate system has not been confirmed. The original endpoint and
fallback reason are retained in every request/result.
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (
    !Number.isInteger(options.retries) ||
    options.retries < 0 ||
    options.retries > 2
  ) {
    throw new Error("--retries must be an integer from 0 to 2");
  }
  if (
    !Number.isInteger(options.pageSize) ||
    options.pageSize < 1 ||
    options.pageSize > 25
  ) {
    throw new Error("--page-size must be an integer from 1 to 25");
  }
  if (options.placeKinds.length === 0) {
    throw new Error("--place-kinds cannot be empty");
  }
  if (options.execute && options.confirm !== "FULL_AMAP_RUN") {
    throw new Error(
      "Full execution requires --execute and --confirm FULL_AMAP_RUN",
    );
  }
  return options;
}

async function exists(filePath) {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomic(filePath, content) {
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.promises.writeFile(temporaryPath, content, "utf8");
  await fs.promises.rename(temporaryPath, filePath);
}

async function writeJsonAtomic(filePath, value) {
  await writeAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(filePath) {
  return JSON.parse(await fs.promises.readFile(filePath, "utf8"));
}

function toTextFallback(request) {
  if (request.endpoint !== "around") {
    return {
      ...request,
      original_endpoint: "text",
      effective_endpoint: "text",
      fallback_reason: null,
      blocked_reason: null,
    };
  }
  const parameters = { ...request.parameters };
  delete parameters.location;
  delete parameters.radius;
  delete parameters.sortrule;
  return {
    ...request,
    endpoint: "text",
    path: "/v5/place/text",
    parameters,
    original_endpoint: "around",
    effective_endpoint: "text",
    fallback_reason: "source_coordinate_system_unconfirmed",
    blocked_reason: null,
  };
}

async function buildRequests(options) {
  const sourcePath = path.resolve(options.source);
  const plansPath = path.resolve(options.plans);
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
      const planned = createRequest({
        planResult,
        group,
        groupIndex,
        input,
        options: {
          pageSize: options.pageSize,
          radius: options.radius,
          coordinateSystem: "unknown",
        },
      });
      requests.push(toTextFallback(planned));
    }
  }
  return { sourcePath, plansPath, requests, exclusions };
}

async function assertOrCreateManifest(manifestPath, manifest) {
  if (!(await exists(manifestPath))) {
    await writeJsonAtomic(manifestPath, manifest);
    return;
  }
  const existing = await readJson(manifestPath);
  for (const field of [
    "source",
    "plans",
    "request_count",
    "request_sha256",
  ]) {
    if (existing[field] !== manifest[field]) {
      throw new Error(`Cannot resume: manifest field ${field} changed`);
    }
  }
  if (manifest.mode === "execute" && existing.mode !== "execute") {
    await writeJsonAtomic(manifestPath, {
      ...existing,
      mode: "execute",
      execution_started_at: new Date().toISOString(),
    });
  }
}

async function collectSummary({
  requests,
  outputPath,
  resultsPath,
  errorsPath,
  manifest,
}) {
  const results = [];
  const errors = [];
  for (const request of requests) {
    const stem = safeFileStem(request.request_id);
    const resultPath = path.join(resultsPath, `${stem}.json`);
    const errorPath = path.join(errorsPath, `${stem}.json`);
    if (await exists(resultPath)) results.push(await readJson(resultPath));
    else if (await exists(errorPath)) errors.push(await readJson(errorPath));
  }
  const toJsonl = (items) =>
    items.length > 0
      ? `${items.map((item) => JSON.stringify(item)).join("\n")}\n`
      : "";
  await writeAtomic(path.join(outputPath, "results.jsonl"), toJsonl(results));
  await writeAtomic(path.join(outputPath, "errors.jsonl"), toJsonl(errors));
  const summary = {
    ...manifest,
    updated_at: new Date().toISOString(),
    success_count: results.length,
    error_count: errors.length,
    pending_count: requests.length - results.length - errors.length,
    zero_result_count: results.filter(
      (result) => Number(result.count ?? 0) === 0,
    ).length,
    total_returned_pois: results.reduce(
      (sum, result) => sum + Number(result.count ?? 0),
      0,
    ),
  };
  await writeJsonAtomic(path.join(outputPath, "run_summary.json"), summary);
  return summary;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outputPath = path.resolve(options.output);
  const requestsPath = path.join(outputPath, "requests");
  const rawResponsesPath = path.join(outputPath, "raw_responses");
  const resultsPath = path.join(outputPath, "results");
  const errorsPath = path.join(outputPath, "errors");
  const manifestPath = path.join(outputPath, "manifest.json");
  const progressPath = path.join(outputPath, "progress.json");

  loadEnvFile(path.resolve("data-processing/.env"));
  const apiKey = process.env.amap_key ?? process.env.AMAP_KEY;
  if (options.execute && !apiKey) {
    throw new Error("Missing amap_key or AMAP_KEY");
  }

  const { sourcePath, plansPath, requests, exclusions } =
    await buildRequests(options);
  const requestDigest = crypto
    .createHash("sha256")
    .update(requests.map((request) => JSON.stringify(request)).join("\n"))
    .digest("hex");

  for (const directory of [
    outputPath,
    requestsPath,
    rawResponsesPath,
    resultsPath,
    errorsPath,
  ]) {
    await fs.promises.mkdir(directory, { recursive: true });
  }

  const manifest = {
    script_version: "amap_poi_full_text_v1",
    created_at: new Date().toISOString(),
    mode: options.execute ? "execute" : "dry_run",
    source: sourcePath,
    plans: plansPath,
    output: outputPath,
    concurrency: 1,
    retries: options.retries,
    page_size: options.pageSize,
    place_kinds: options.placeKinds,
    request_count: requests.length,
    exclusion_count: exclusions.length,
    original_endpoint_counts: {
      around: requests.filter(
        (request) => request.original_endpoint === "around",
      ).length,
      text: requests.filter(
        (request) => request.original_endpoint === "text",
      ).length,
    },
    effective_endpoint_counts: {
      around: 0,
      text: requests.length,
    },
    request_sha256: requestDigest,
    coordinate_policy:
      "All around plans use text fallback until source GCJ-02 is confirmed",
    amap_called: options.execute,
  };
  await assertOrCreateManifest(manifestPath, manifest);

  for (const request of requests) {
    const requestPath = path.join(
      requestsPath,
      `${safeFileStem(request.request_id)}.json`,
    );
    if (!(await exists(requestPath))) {
      await writeJsonAtomic(requestPath, request);
    }
  }
  await writeAtomic(
    path.join(outputPath, "exclusions.jsonl"),
    exclusions.length > 0
      ? `${exclusions.map((item) => JSON.stringify(item)).join("\n")}\n`
      : "",
  );

  if (!options.execute) {
    console.log(JSON.stringify(manifest, null, 2));
    console.log("Dry run only: no AMap request was sent.");
    return;
  }

  const pending = [];
  let cachedSuccess = 0;
  for (const request of requests) {
    const resultPath = path.join(
      resultsPath,
      `${safeFileStem(request.request_id)}.json`,
    );
    if (await exists(resultPath)) cachedSuccess += 1;
    else pending.push(request);
  }

  let completed = 0;
  let failed = 0;
  const startedAt = new Date().toISOString();
  async function saveProgress() {
    await writeJsonAtomic(progressPath, {
      updated_at: new Date().toISOString(),
      started_at: startedAt,
      request_count: requests.length,
      cached_success_at_start: cachedSuccess,
      pending_at_start: pending.length,
      completed_this_run: completed,
      failed_this_run: failed,
      remaining_this_run: pending.length - completed - failed,
      concurrency: 1,
    });
  }
  await saveProgress();

  for (const request of pending) {
    const stem = safeFileStem(request.request_id);
    const rawPath = path.join(rawResponsesPath, `${stem}.json`);
    const resultPath = path.join(resultsPath, `${stem}.json`);
    const errorPath = path.join(errorsPath, `${stem}.json`);
    try {
      const response = await callAmap(request, apiKey, options.retries);
      await writeAtomic(rawPath, response.raw_response_text);
      await writeJsonAtomic(resultPath, {
        request_id: request.request_id,
        post_id: request.post_id,
        group_index: request.group_index,
        original_endpoint: request.original_endpoint,
        effective_endpoint: request.effective_endpoint,
        fallback_reason: request.fallback_reason,
        keyword: request.parameters.keywords,
        region: request.parameters.region ?? null,
        context: request.context,
        status: response.payload.status,
        info: response.payload.info,
        infocode: response.payload.infocode,
        count: response.payload.count,
        pois: response.payload.pois ?? [],
        attempt_count: response.attempt_count,
        raw_response_file: path.relative(outputPath, rawPath),
      });
      if (await exists(errorPath)) await fs.promises.unlink(errorPath);
      completed += 1;
    } catch (error) {
      await writeJsonAtomic(errorPath, {
        request_id: request.request_id,
        post_id: request.post_id,
        error: error.message,
        attempt_count: error.attempt_count ?? options.retries + 1,
        failed_at: new Date().toISOString(),
      });
      failed += 1;
    }

    if ((completed + failed) % 10 === 0) {
      await saveProgress();
      console.log(
        JSON.stringify({
          processed: completed + failed,
          pending: pending.length,
          success: completed,
          failed,
        }),
      );
    }
  }

  await saveProgress();
  const summary = await collectSummary({
    requests,
    outputPath,
    resultsPath,
    errorsPath,
    manifest,
  });
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
