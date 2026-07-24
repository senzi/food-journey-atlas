#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  ALLOWED_CATEGORIES,
  buildInput,
  callDeepSeekWithRetry,
  loadEnvFile,
  readCandidates,
  validatePlan,
} from "./test-poi-query-llm.mjs";

const MAX_CONCURRENCY = 1000;

function parseArgs(argv) {
  const options = {
    input: "data-processing/data/vlm_results_v2_repaired_v2.jsonl",
    output: "data-processing/data/analysis/poi_llm_full_v2",
    prompt: "data-processing/prompts/poi-query-plan-v2.md",
    model: "deepseek-v4-flash",
    baseUrl: "https://api.deepseek.com",
    concurrency: 500,
    retries: 2,
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
    else if (arg === "--concurrency") {
      options.concurrency = Number(argv[++index]);
    } else if (arg === "--retries") options.retries = Number(argv[++index]);
    else if (arg === "--execute") options.execute = true;
    else if (arg === "--confirm") options.confirm = argv[++index];
    else if (arg === "--help") {
      console.log(`Usage:
  Dry run:
    node data-processing/scripts/run-poi-query-llm-full.mjs

  Execute/resume the full POI-planning workload:
    node data-processing/scripts/run-poi-query-llm-full.mjs --execute --confirm FULL_LLM_RUN

Options:
  --input <jsonl>       Default: data-processing/data/vlm_results_v2_repaired_v2.jsonl
  --output <dir>        Default: data-processing/data/analysis/poi_llm_full_v2
  --prompt <file>       Default: data-processing/prompts/poi-query-plan-v2.md
  --model <name>        Default: deepseek-v4-flash
  --base-url <url>      Default: https://api.deepseek.com
  --concurrency <1-1000>
                        Default: 500
  --retries <0-2>       Default: 2
  --execute             Actually call the LLM
  --confirm FULL_LLM_RUN
                        Required together with --execute
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
  if (options.execute && options.confirm !== "FULL_LLM_RUN") {
    throw new Error(
      "Full execution requires both --execute and --confirm FULL_LLM_RUN",
    );
  }
  return options;
}

function safeFileStem(postId) {
  const value = String(postId);
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    return crypto.createHash("sha256").update(value).digest("hex");
  }
  return value;
}

async function pathExists(filePath) {
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

async function assertOrCreateManifest({
  outputPath,
  manifestPath,
  manifest,
  execute,
}) {
  if (!(await pathExists(manifestPath))) {
    await writeJsonAtomic(manifestPath, manifest);
    return;
  }
  const existing = await readJson(manifestPath);
  for (const field of [
    "input",
    "prompt_sha256",
    "model",
    "base_url",
    "selected_count",
  ]) {
    if (existing[field] !== manifest[field]) {
      throw new Error(
        `Cannot resume ${outputPath}: manifest field ${field} changed`,
      );
    }
  }
  if (execute && existing.mode !== "execute") {
    await writeJsonAtomic(manifestPath, {
      ...existing,
      mode: "execute",
      execution_started_at: new Date().toISOString(),
      concurrency: manifest.concurrency,
      retries: manifest.retries,
    });
  }
}

async function collectOutput({
  inputs,
  resultsPath,
  errorsPath,
  outputPath,
  manifest,
}) {
  const results = [];
  const errors = [];
  for (const input of inputs) {
    const stem = safeFileStem(input.post_id);
    const resultPath = path.join(resultsPath, `${stem}.json`);
    const errorPath = path.join(errorsPath, `${stem}.json`);
    if (await pathExists(resultPath)) results.push(await readJson(resultPath));
    else if (await pathExists(errorPath)) errors.push(await readJson(errorPath));
  }

  const jsonl = (items) =>
    items.length > 0
      ? `${items.map((item) => JSON.stringify(item)).join("\n")}\n`
      : "";
  await writeAtomic(path.join(outputPath, "results.jsonl"), jsonl(results));
  await writeAtomic(path.join(outputPath, "errors.jsonl"), jsonl(errors));

  const summary = {
    ...manifest,
    updated_at: new Date().toISOString(),
    success_count: results.length,
    valid_plan_count: results.filter((item) => item.validation.valid).length,
    invalid_plan_count: results.filter((item) => !item.validation.valid).length,
    error_count: errors.length,
    pending_count: inputs.length - results.length - errors.length,
    amap_called: false,
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
      prompt_cache_hit_tokens: results.reduce(
        (sum, item) =>
          sum + Number(item.usage?.prompt_cache_hit_tokens ?? 0),
        0,
      ),
    },
  };
  await writeJsonAtomic(path.join(outputPath, "run_summary.json"), summary);
  return summary;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(options.input);
  const outputPath = path.resolve(options.output);
  const promptPath = path.resolve(options.prompt);
  const rawResponsesPath = path.join(outputPath, "raw_responses");
  const resultsPath = path.join(outputPath, "results");
  const errorsPath = path.join(outputPath, "errors");
  const manifestPath = path.join(outputPath, "manifest.json");
  const progressPath = path.join(outputPath, "progress.json");

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
  const inputs = candidates.map((item) => buildInput(item.row, item.state));
  const promptSha256 = crypto
    .createHash("sha256")
    .update(systemPrompt)
    .digest("hex");

  await fs.promises.mkdir(rawResponsesPath, { recursive: true });
  await fs.promises.mkdir(resultsPath, { recursive: true });
  await fs.promises.mkdir(errorsPath, { recursive: true });

  const manifest = {
    script_version: "poi_llm_full_v1",
    created_at: new Date().toISOString(),
    mode: options.execute ? "execute" : "dry_run",
    input: inputPath,
    output: outputPath,
    prompt: promptPath,
    prompt_sha256: promptSha256,
    model: options.model,
    base_url: options.baseUrl,
    concurrency: options.concurrency,
    retries: options.retries,
    selected_count: inputs.length,
    category_counts: Object.fromEntries(
      [...ALLOWED_CATEGORIES].map((category) => [
        category,
        inputs.filter((input) => input.input_category === category).length,
      ]),
    ),
    cache_layout: {
      raw_responses: "raw_responses/<post_id>.json",
      parsed_results: "results/<post_id>.json",
      errors: "errors/<post_id>.json",
    },
    safety: {
      source_input_mutated: false,
      resumable: true,
      amap_called: false,
    },
  };
  await assertOrCreateManifest({
    outputPath,
    manifestPath,
    manifest,
    execute: options.execute,
  });

  if (!options.execute) {
    console.log(JSON.stringify(manifest, null, 2));
    console.log("Dry run only: no LLM or AMap request was sent.");
    return;
  }

  const pending = [];
  let cachedSuccessCount = 0;
  for (const input of inputs) {
    const stem = safeFileStem(input.post_id);
    const resultPath = path.join(resultsPath, `${stem}.json`);
    if (await pathExists(resultPath)) {
      cachedSuccessCount += 1;
      continue;
    }
    pending.push(input);
  }

  let cursor = 0;
  let completedThisRun = 0;
  let failedThisRun = 0;
  const startedAt = new Date().toISOString();

  async function saveProgress() {
    await writeJsonAtomic(progressPath, {
      updated_at: new Date().toISOString(),
      started_at: startedAt,
      selected_count: inputs.length,
      cached_success_at_start: cachedSuccessCount,
      pending_at_start: pending.length,
      completed_this_run: completedThisRun,
      failed_this_run: failedThisRun,
      remaining_this_run:
        pending.length - completedThisRun - failedThisRun,
      amap_called: false,
    });
  }

  await saveProgress();

  async function worker() {
    while (cursor < pending.length) {
      const index = cursor;
      cursor += 1;
      const input = pending[index];
      const stem = safeFileStem(input.post_id);
      const rawPath = path.join(rawResponsesPath, `${stem}.json`);
      const resultPath = path.join(resultsPath, `${stem}.json`);
      const errorPath = path.join(errorsPath, `${stem}.json`);

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
        await writeAtomic(rawPath, response.raw_response_text);
        const validationErrors = validatePlan(response.plan, input);
        const result = {
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
          raw_response_file: path.relative(outputPath, rawPath),
        };
        await writeJsonAtomic(resultPath, result);
        if (await pathExists(errorPath)) {
          await fs.promises.unlink(errorPath);
        }
        completedThisRun += 1;
      } catch (error) {
        await writeJsonAtomic(errorPath, {
          post_id: input.post_id,
          input_category: input.input_category,
          error: error.message,
          attempt_count: error.attempt_count ?? options.retries + 1,
          failed_at: new Date().toISOString(),
        });
        failedThisRun += 1;
      }

      if (
        (completedThisRun + failedThisRun) % 10 === 0 ||
        completedThisRun + failedThisRun === pending.length
      ) {
        await saveProgress();
        console.log(
          JSON.stringify({
            processed: completedThisRun + failedThisRun,
            pending: pending.length,
            success: completedThisRun,
            failed: failedThisRun,
          }),
        );
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(options.concurrency, pending.length) },
      () => worker(),
    ),
  );
  await saveProgress();
  const summary = await collectOutput({
    inputs,
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
