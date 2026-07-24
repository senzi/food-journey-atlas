#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  callDeepSeekWithRetry,
  loadEnvFile,
} from "./test-poi-query-llm.mjs";

const VALID_KINDS = new Set([
  "restaurant",
  "market",
  "attraction",
  "building",
  "address",
  "city",
  "region",
  "country",
  "other",
]);

function parseArgs(argv) {
  const options = {
    source: "data-processing/data/vlm_results_v2_repaired_v2.jsonl",
    index: "data-processing/data/analysis/final_poi_dataset_v1/poi_resolution_index.jsonl",
    prompt: "data-processing/prompts/fallback-location-extraction-v1.md",
    output: "data-processing/data/analysis/fallback_location_extraction_v1",
    model: "deepseek-v4-flash",
    baseUrl: "https://api.deepseek.com",
    concurrency: 500,
    retries: 2,
    execute: false,
    confirm: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source") options.source = argv[++index];
    else if (arg === "--index") options.index = argv[++index];
    else if (arg === "--prompt") options.prompt = argv[++index];
    else if (arg === "--output") options.output = argv[++index];
    else if (arg === "--model") options.model = argv[++index];
    else if (arg === "--base-url") options.baseUrl = argv[++index];
    else if (arg === "--concurrency") {
      options.concurrency = Number(argv[++index]);
    } else if (arg === "--retries") options.retries = Number(argv[++index]);
    else if (arg === "--execute") options.execute = true;
    else if (arg === "--confirm") options.confirm = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (
    !Number.isInteger(options.concurrency) ||
    options.concurrency < 1 ||
    options.concurrency > 1000
  ) {
    throw new Error("--concurrency must be from 1 to 1000");
  }
  if (
    !Number.isInteger(options.retries) ||
    options.retries < 0 ||
    options.retries > 2
  ) {
    throw new Error("--retries must be 0, 1, or 2");
  }
  if (
    options.execute &&
    options.confirm !== "FULL_FALLBACK_LOCATION_EXTRACTION"
  ) {
    throw new Error(
      "Execution requires --execute --confirm FULL_FALLBACK_LOCATION_EXTRACTION",
    );
  }
  return options;
}

async function readJsonl(filePath) {
  const text = await fs.promises.readFile(filePath, "utf8");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function compactRow(row) {
  const images = (row.vlm_analysis ?? []).map((media) => {
    const analysis = media.stage2?.analysis;
    return {
      pic_index: media.pic_index,
      description: media.stage1?.description ?? "",
      summary: analysis?.summary ?? "",
      visible_text: analysis?.visible_text ?? [],
      place_clues: analysis?.place_clues ?? [],
      restaurant_name_candidates:
        analysis?.restaurant_name_candidates ?? [],
    };
  });
  return {
    post_id: String(row.id ?? row.mid),
    content: row.content ?? "",
    images,
  };
}

function validate(plan, input) {
  const errors = [];
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return ["top_level_not_object"];
  }
  if (Object.hasOwn(plan, "post_id")) errors.push("unexpected_post_id");
  if (!Array.isArray(plan.locations)) return [...errors, "locations_not_array"];
  if (plan.locations.length > 3) errors.push("too_many_locations");
  const corpus = [
    input.content,
    ...input.images.flatMap((image) => [
      image.description,
      image.summary,
      ...image.visible_text.map((item) => item?.text ?? item?.name ?? item),
      ...image.place_clues.map((item) => item?.text ?? item?.name ?? item),
      ...image.restaurant_name_candidates.map(
        (item) => item?.text ?? item?.name ?? item,
      ),
    ]),
  ]
    .filter((item) => typeof item === "string")
    .join("\n");
  for (const [index, location] of plan.locations.entries()) {
    if (typeof location?.text !== "string" || !location.text.trim()) {
      errors.push(`location_${index}_empty_text`);
    } else if (!corpus.includes(location.text.trim())) {
      errors.push(`location_${index}_not_in_evidence`);
    }
    if (!VALID_KINDS.has(location?.kind)) {
      errors.push(`location_${index}_invalid_kind`);
    }
    const confidence = Number(location?.confidence);
    if (
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1
    ) {
      errors.push(`location_${index}_invalid_confidence`);
    }
    if (
      typeof location?.evidence !== "string" ||
      !location.evidence.trim()
    ) {
      errors.push(`location_${index}_missing_evidence`);
    }
  }
  return errors;
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

async function writeJson(filePath, value) {
  await writeAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function safeStem(postId) {
  return String(postId).replace(/[^A-Za-z0-9_-]/g, "_");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outputPath = path.resolve(options.output);
  const rawPath = path.join(outputPath, "raw_responses");
  const resultsPath = path.join(outputPath, "results");
  const errorsPath = path.join(outputPath, "errors");
  for (const directory of [outputPath, rawPath, resultsPath, errorsPath]) {
    await fs.promises.mkdir(directory, { recursive: true });
  }
  loadEnvFile(path.resolve("data-processing/.env"));
  const apiKey = process.env.deepseek_key ?? process.env.DEEPSEEK_API_KEY;
  if (options.execute && !apiKey) throw new Error("Missing DeepSeek API key");

  const [systemPrompt, rows, indexRows] = await Promise.all([
    fs.promises.readFile(path.resolve(options.prompt), "utf8"),
    readJsonl(path.resolve(options.source)),
    readJsonl(path.resolve(options.index)),
  ]);
  const lowConfidenceIds = new Set(
    indexRows
      .filter((item) =>
        ["temporal_neighbor", "ip_region_centroid", "global_default"].includes(
          item.method,
        ),
      )
      .map((item) => String(item.post_id)),
  );
  const inputs = rows
    .filter((row) => lowConfidenceIds.has(String(row.id ?? row.mid)))
    .map(compactRow);
  const manifest = {
    script_version: "fallback_location_extraction_v1",
    created_at: new Date().toISOString(),
    mode: options.execute ? "execute" : "dry_run",
    input_count: inputs.length,
    prompt_sha256: crypto
      .createHash("sha256")
      .update(systemPrompt)
      .digest("hex"),
    model: options.model,
    concurrency: options.concurrency,
    retries: options.retries,
  };
  await writeJson(path.join(outputPath, "manifest.json"), manifest);
  if (!options.execute) {
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  const pending = [];
  for (const input of inputs) {
    if (!(await exists(path.join(resultsPath, `${safeStem(input.post_id)}.json`)))) {
      pending.push(input);
    }
  }
  let cursor = 0;
  let success = 0;
  let failed = 0;
  async function worker() {
    while (cursor < pending.length) {
      const index = cursor++;
      const input = pending[index];
      const stem = safeStem(input.post_id);
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
        const validationErrors = validate(response.plan, input);
        await writeJson(path.join(resultsPath, `${stem}.json`), {
          post_id: input.post_id,
          extraction: response.plan,
          validation: {
            valid: validationErrors.length === 0,
            errors: validationErrors,
          },
          usage: response.usage,
          attempt_count: response.attempt_count,
        });
        success += 1;
      } catch (error) {
        await writeJson(path.join(errorsPath, `${stem}.json`), {
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

  const results = [];
  const errors = [];
  for (const input of inputs) {
    const stem = safeStem(input.post_id);
    const resultFile = path.join(resultsPath, `${stem}.json`);
    const errorFile = path.join(errorsPath, `${stem}.json`);
    if (await exists(resultFile)) {
      results.push(JSON.parse(await fs.promises.readFile(resultFile, "utf8")));
    } else if (await exists(errorFile)) {
      errors.push(JSON.parse(await fs.promises.readFile(errorFile, "utf8")));
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
    success_count: results.length,
    valid_count: results.filter((item) => item.validation.valid).length,
    invalid_count: results.filter((item) => !item.validation.valid).length,
    error_count: errors.length,
    posts_with_locations: results.filter(
      (item) =>
        item.validation.valid && item.extraction.locations.length > 0,
    ).length,
    extracted_location_count: results.reduce(
      (sum, item) =>
        sum +
        (item.validation.valid ? item.extraction.locations.length : 0),
      0,
    ),
    usage: {
      total_tokens: results.reduce(
        (sum, item) => sum + Number(item.usage?.total_tokens ?? 0),
        0,
      ),
    },
  };
  await writeJson(path.join(outputPath, "summary.json"), summary);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
