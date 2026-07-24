#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  buildInput,
  callDeepSeekWithRetry,
  loadEnvFile,
  readCandidates,
} from "./test-poi-query-llm.mjs";

const VALID_DECISIONS = new Set([
  "select_one",
  "keep_multiple",
  "reject_all",
  "insufficient_evidence",
]);
const MAX_CONCURRENCY = 1000;

function parseArgs(argv) {
  const options = {
    source: "data-processing/data/vlm_results_v2_repaired_v2.jsonl",
    plans: "data-processing/data/analysis/poi_llm_full_v2/results.jsonl",
    scored: "data-processing/data/analysis/amap_poi_scored_v2_final/scored_results.jsonl",
    prompt: "data-processing/prompts/poi-candidate-disambiguation-v1.md",
    output: "data-processing/data/analysis/poi_llm_disambiguation_v1",
    model: "deepseek-v4-flash",
    baseUrl: "https://api.deepseek.com",
    concurrency: 300,
    retries: 2,
    execute: false,
    confirm: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source") options.source = argv[++index];
    else if (arg === "--plans") options.plans = argv[++index];
    else if (arg === "--scored") options.scored = argv[++index];
    else if (arg === "--prompt") options.prompt = argv[++index];
    else if (arg === "--output") options.output = argv[++index];
    else if (arg === "--model") options.model = argv[++index];
    else if (arg === "--base-url") options.baseUrl = argv[++index];
    else if (arg === "--concurrency") {
      options.concurrency = Number(argv[++index]);
    } else if (arg === "--retries") options.retries = Number(argv[++index]);
    else if (arg === "--execute") options.execute = true;
    else if (arg === "--confirm") options.confirm = argv[++index];
    else if (arg === "--help") {
      console.log(`Usage:
  Dry run:
    node data-processing/scripts/run-poi-candidate-disambiguation-llm.mjs

  Execute/resume:
    node data-processing/scripts/run-poi-candidate-disambiguation-llm.mjs \\
      --execute --confirm FULL_POI_DISAMBIGUATION
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
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
    options.execute &&
    options.confirm !== "FULL_POI_DISAMBIGUATION"
  ) {
    throw new Error(
      "Execution requires --execute --confirm FULL_POI_DISAMBIGUATION",
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

function safeStem(requestId) {
  return String(requestId).replace(/[^A-Za-z0-9_-]/g, "_");
}

function compactImages(input) {
  return (input.images ?? []).map((image) => ({
    pic_index: image.pic_index,
    summary: image.analysis?.summary ?? image.stage1?.description ?? "",
    visible_text: image.analysis?.visible_text ?? [],
    place_clues: image.analysis?.place_clues ?? [],
    restaurant_name_candidates:
      image.analysis?.restaurant_name_candidates ?? [],
  }));
}

function shouldReview(scored) {
  if (
    ["llm_review_required", "no_confident_match"].includes(
      scored.decision.status,
    ) &&
    scored.candidates.length > 0
  ) {
    return true;
  }
  return (
    scored.coordinate_assessment.status === "conflict_over_2km" &&
    ["auto_selected", "multiple_retained"].includes(scored.decision.status)
  );
}

function buildReviewInput({ scored, input, planResult }) {
  const group = planResult?.plan?.place_groups?.[scored.group_index] ?? null;
  const candidates = scored.candidates.slice(0, 5).map((candidate) => ({
    poi_id: candidate.poi_id,
    name: candidate.name,
    alias: candidate.alias,
    location: candidate.location,
    pname: candidate.pname,
    cityname: candidate.cityname,
    adname: candidate.adname,
    address: candidate.address,
    business_area: candidate.business_area,
    type: candidate.type,
    typecode: candidate.typecode,
    rating: candidate.rating,
    name_similarity: candidate.name_similarity,
    name_match_kind: candidate.name_match_kind,
    matched_region_clues: candidate.matched_region_clues,
    matched_address_clues: candidate.matched_address_clues,
    distance_from_source_m: candidate.distance_from_source_m,
    text_score: candidate.text_score,
  }));
  return {
    request_id: scored.request_id,
    post_id: scored.post_id,
    content: input?.content ?? "",
    original_geo: input?.original_geo ?? null,
    poi_candidates: input?.poi_candidates ?? [],
    images: compactImages(input ?? {}),
    query_plan_group: group,
    deterministic_decision: scored.decision,
    coordinate_assessment: scored.coordinate_assessment,
    allowed_poi_ids: candidates.map((candidate) => candidate.poi_id),
    amap_candidates: candidates,
  };
}

function validateDecision(plan, allowedPoiIds) {
  const errors = [];
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return ["top_level_not_object"];
  }
  if (Object.hasOwn(plan, "post_id")) errors.push("unexpected_post_id");
  if (Object.hasOwn(plan, "request_id")) errors.push("unexpected_request_id");
  if (!VALID_DECISIONS.has(plan.decision)) errors.push("invalid_decision");
  if (!Array.isArray(plan.selected_poi_ids)) {
    errors.push("selected_poi_ids_not_array");
  } else {
    const unique = new Set(plan.selected_poi_ids);
    if (unique.size !== plan.selected_poi_ids.length) {
      errors.push("duplicate_selected_poi_ids");
    }
    for (const poiId of plan.selected_poi_ids) {
      if (!allowedPoiIds.includes(poiId)) {
        errors.push(`unknown_poi_id:${poiId}`);
      }
    }
    if (plan.decision === "select_one" && plan.selected_poi_ids.length !== 1) {
      errors.push("select_one_requires_one_id");
    }
    if (
      plan.decision === "keep_multiple" &&
      (plan.selected_poi_ids.length < 2 ||
        plan.selected_poi_ids.length > 5)
    ) {
      errors.push("keep_multiple_requires_2_to_5_ids");
    }
    if (
      ["reject_all", "insufficient_evidence"].includes(plan.decision) &&
      plan.selected_poi_ids.length !== 0
    ) {
      errors.push("empty_decision_requires_no_ids");
    }
  }
  const confidence = Number(plan.confidence);
  if (
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    errors.push("invalid_confidence");
  }
  if (typeof plan.reason !== "string" || !plan.reason.trim()) {
    errors.push("missing_reason");
  }
  return errors;
}

async function collect({
  reviewInputs,
  resultsPath,
  errorsPath,
  outputPath,
  manifest,
}) {
  const results = [];
  const errors = [];
  for (const input of reviewInputs) {
    const stem = safeStem(input.request_id);
    const resultPath = path.join(resultsPath, `${stem}.json`);
    const errorPath = path.join(errorsPath, `${stem}.json`);
    if (await exists(resultPath)) {
      results.push(JSON.parse(await fs.promises.readFile(resultPath, "utf8")));
    } else if (await exists(errorPath)) {
      errors.push(JSON.parse(await fs.promises.readFile(errorPath, "utf8")));
    }
  }
  const toJsonl = (items) =>
    items.length
      ? `${items.map((item) => JSON.stringify(item)).join("\n")}\n`
      : "";
  await writeAtomic(path.join(outputPath, "results.jsonl"), toJsonl(results));
  await writeAtomic(path.join(outputPath, "errors.jsonl"), toJsonl(errors));
  const summary = {
    ...manifest,
    updated_at: new Date().toISOString(),
    success_count: results.length,
    valid_count: results.filter((item) => item.validation.valid).length,
    invalid_count: results.filter((item) => !item.validation.valid).length,
    error_count: errors.length,
    pending_count: reviewInputs.length - results.length - errors.length,
    decision_counts: Object.fromEntries(
      [...VALID_DECISIONS].map((decision) => [
        decision,
        results.filter(
          (item) =>
            item.validation.valid && item.decision.decision === decision,
        ).length,
      ]),
    ),
    usage: {
      prompt_tokens: results.reduce(
        (sum, item) => sum + Number(item.usage?.prompt_tokens ?? 0),
        0,
      ),
      completion_tokens: results.reduce(
        (sum, item) => sum + Number(item.usage?.completion_tokens ?? 0),
        0,
      ),
      total_tokens: results.reduce(
        (sum, item) => sum + Number(item.usage?.total_tokens ?? 0),
        0,
      ),
    },
  };
  await writeJsonAtomic(path.join(outputPath, "run_summary.json"), summary);
  return summary;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sourcePath = path.resolve(options.source);
  const plansPath = path.resolve(options.plans);
  const scoredPath = path.resolve(options.scored);
  const promptPath = path.resolve(options.prompt);
  const outputPath = path.resolve(options.output);
  const rawPath = path.join(outputPath, "raw_responses");
  const resultsPath = path.join(outputPath, "results");
  const errorsPath = path.join(outputPath, "errors");

  loadEnvFile(path.resolve("data-processing/.env"));
  const apiKey = process.env.deepseek_key ?? process.env.DEEPSEEK_API_KEY;
  if (options.execute && !apiKey) {
    throw new Error("Missing deepseek_key or DEEPSEEK_API_KEY");
  }

  const [systemPrompt, sourceCandidates, planResults, scoredResults] =
    await Promise.all([
      fs.promises.readFile(promptPath, "utf8"),
      readCandidates(sourcePath),
      readJsonl(plansPath),
      readJsonl(scoredPath),
    ]);
  const inputsByPost = new Map(
    sourceCandidates.map((item) => {
      const input = buildInput(item.row, item.state);
      return [input.post_id, input];
    }),
  );
  const plansByPost = new Map(
    planResults.map((item) => [String(item.post_id), item]),
  );
  const reviewInputs = scoredResults
    .filter(shouldReview)
    .map((scored) =>
      buildReviewInput({
        scored,
        input: inputsByPost.get(String(scored.post_id)),
        planResult: plansByPost.get(String(scored.post_id)),
      }),
    );

  for (const directory of [outputPath, rawPath, resultsPath, errorsPath]) {
    await fs.promises.mkdir(directory, { recursive: true });
  }

  const promptSha256 = crypto
    .createHash("sha256")
    .update(systemPrompt)
    .digest("hex");
  const manifest = {
    script_version: "poi_candidate_disambiguation_v1",
    created_at: new Date().toISOString(),
    mode: options.execute ? "execute" : "dry_run",
    source: sourcePath,
    plans: plansPath,
    scored: scoredPath,
    prompt: promptPath,
    prompt_sha256: promptSha256,
    model: options.model,
    base_url: options.baseUrl,
    concurrency: options.concurrency,
    retries: options.retries,
    selected_count: reviewInputs.length,
  };
  const manifestPath = path.join(outputPath, "manifest.json");
  if (!(await exists(manifestPath))) {
    await writeJsonAtomic(manifestPath, manifest);
  } else {
    const existing = JSON.parse(
      await fs.promises.readFile(manifestPath, "utf8"),
    );
    for (const field of ["source", "plans", "scored", "prompt_sha256", "model"]) {
      if (existing[field] !== manifest[field]) {
        throw new Error(`Cannot resume: manifest field ${field} changed`);
      }
    }
  }
  await writeAtomic(
    path.join(outputPath, "review_inputs.jsonl"),
    `${reviewInputs.map((item) => JSON.stringify(item)).join("\n")}\n`,
  );

  if (!options.execute) {
    console.log(JSON.stringify(manifest, null, 2));
    console.log("Dry run only: no LLM or AMap request was sent.");
    return;
  }

  const pending = [];
  for (const input of reviewInputs) {
    const resultPath = path.join(resultsPath, `${safeStem(input.request_id)}.json`);
    if (!(await exists(resultPath))) pending.push(input);
  }

  let cursor = 0;
  let completed = 0;
  let failed = 0;
  async function worker() {
    while (cursor < pending.length) {
      const index = cursor;
      cursor += 1;
      const input = pending[index];
      const stem = safeStem(input.request_id);
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
        await writeAtomic(
          path.join(rawPath, `${stem}.json`),
          response.raw_response_text,
        );
        const validationErrors = validateDecision(
          response.plan,
          input.allowed_poi_ids,
        );
        await writeJsonAtomic(path.join(resultsPath, `${stem}.json`), {
          request_id: input.request_id,
          post_id: input.post_id,
          decision: response.plan,
          validation: {
            valid: validationErrors.length === 0,
            errors: validationErrors,
          },
          usage: response.usage,
          response_id: response.response_id,
          response_model: response.response_model,
          finish_reason: response.finish_reason,
          attempt_count: response.attempt_count,
        });
        completed += 1;
      } catch (error) {
        await writeJsonAtomic(path.join(errorsPath, `${stem}.json`), {
          request_id: input.request_id,
          post_id: input.post_id,
          error: error.message,
          attempt_count: error.attempt_count ?? options.retries + 1,
        });
        failed += 1;
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(options.concurrency, pending.length) },
      () => worker(),
    ),
  );
  const summary = await collect({
    reviewInputs,
    resultsPath,
    errorsPath,
    outputPath,
    manifest,
  });
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
