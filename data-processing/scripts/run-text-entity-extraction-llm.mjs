#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { loadEnvFile } from "./test-poi-query-llm.mjs";

const VALID_TYPES = new Set([
  "restaurant",
  "dish",
  "cuisine",
  "region",
  "ingredient",
  "food_category",
  "other_place",
  "other",
]);

function parseArgs(argv) {
  const options = {
    input: "data-processing/data/vlm_results_v2_with_poi_v5.jsonl",
    output: "data-processing/data/analysis/text_entity_mentions_llm_v1",
    prompt: "data-processing/prompts/text-entity-mentions-v1.md",
    model: "deepseek-v4-flash",
    baseUrl: "https://api.deepseek.com",
    concurrency: 500,
    retries: 2,
    limit: 0,
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
    else if (arg === "--concurrency") options.concurrency = Number(argv[++index]);
    else if (arg === "--retries") options.retries = Number(argv[++index]);
    else if (arg === "--limit") options.limit = Number(argv[++index]);
    else if (arg === "--execute") options.execute = true;
    else if (arg === "--confirm") options.confirm = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 1000) {
    throw new Error("--concurrency must be from 1 to 1000");
  }
  if (!Number.isInteger(options.retries) || options.retries < 0 || options.retries > 2) {
    throw new Error("--retries must be 0, 1, or 2");
  }
  if (!Number.isInteger(options.limit) || options.limit < 0) {
    throw new Error("--limit must be a non-negative integer");
  }
  if (options.execute && options.confirm !== "TEXT_ENTITY_EXTRACTION") {
    throw new Error("Execution requires --execute --confirm TEXT_ENTITY_EXTRACTION");
  }
  return options;
}

async function readJsonl(filePath) {
  const text = await fs.promises.readFile(filePath, "utf8");
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
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

function validateExtraction(plan, content) {
  const errors = [];
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return ["top_level_not_object"];
  }
  if (Object.hasOwn(plan, "post_id")) errors.push("unexpected_post_id");
  if (!Array.isArray(plan.entities)) return [...errors, "entities_not_array"];
  if (plan.entities.length > 30) errors.push("too_many_entities");
  const seen = new Set();
  for (const [index, entity] of plan.entities.entries()) {
    if (typeof entity?.text !== "string" || !entity.text) {
      errors.push(`entity_${index}_invalid_text`);
    } else if (!content.includes(entity.text)) {
      errors.push(`entity_${index}_not_exact_substring`);
    }
    if (!VALID_TYPES.has(entity?.type)) errors.push(`entity_${index}_invalid_type`);
    const confidence = Number(entity?.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      errors.push(`entity_${index}_invalid_confidence`);
    }
    const key = `${entity?.type}\0${entity?.text}`;
    if (seen.has(key)) errors.push(`entity_${index}_duplicate`);
    seen.add(key);
  }
  return errors;
}

async function callDeepSeek({ baseUrl, apiKey, model, systemPrompt, content }) {
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify({ content }) },
      ],
      response_format: { type: "json_object" },
      thinking: { type: "disabled" },
      temperature: 0,
      max_tokens: 3000,
      stream: false,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const rawResponseText = await response.text();
  let payload;
  try {
    payload = JSON.parse(rawResponseText);
  } catch {
    payload = null;
  }
  if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
  const answer = payload?.choices?.[0]?.message?.content;
  if (typeof answer !== "string" || !answer.trim()) throw new Error("LLM returned empty content");
  return {
    plan: JSON.parse(answer),
    usage: payload.usage ?? null,
    response_id: payload.id ?? null,
    response_model: payload.model ?? model,
    finish_reason: payload.choices?.[0]?.finish_reason ?? null,
    raw_response_text: rawResponseText,
  };
}

async function callWithRetry(args, retries) {
  let lastError;
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    try {
      return { ...(await callDeepSeek(args)), attempt_count: attempt };
    } catch (error) {
      lastError = error;
      if (attempt <= retries) {
        const delay = (attempt === 1 ? 1000 : 2500) + Math.floor(Math.random() * 1000);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  lastError.attempt_count = retries + 1;
  throw lastError;
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
  const [rows, systemPrompt] = await Promise.all([
    readJsonl(path.resolve(options.input)),
    fs.promises.readFile(path.resolve(options.prompt), "utf8"),
  ]);
  let inputs = rows
    .filter((row) => typeof row.content === "string" && row.content.length > 0)
    .map((row) => ({ post_id: String(row.id ?? row.mid), content: row.content }));
  if (options.limit > 0) inputs = inputs.slice(0, options.limit);
  const manifest = {
    script_version: "text_entity_mentions_llm_v1",
    created_at: new Date().toISOString(),
    mode: options.execute ? "execute" : "dry_run",
    input_file: path.resolve(options.input),
    input_count: inputs.length,
    prompt_sha256: crypto.createHash("sha256").update(systemPrompt).digest("hex"),
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
    if (!(await exists(path.join(resultsPath, `${safeStem(input.post_id)}.json`)))) pending.push(input);
  }
  let cursor = 0;
  async function worker() {
    while (cursor < pending.length) {
      const input = pending[cursor++];
      const stem = safeStem(input.post_id);
      try {
        const response = await callWithRetry({
          baseUrl: options.baseUrl,
          apiKey,
          model: options.model,
          systemPrompt,
          content: input.content,
        }, options.retries);
        await writeAtomic(path.join(rawPath, `${stem}.json`), response.raw_response_text);
        const validationErrors = validateExtraction(response.plan, input.content);
        await writeJson(path.join(resultsPath, `${stem}.json`), {
          post_id: input.post_id,
          extraction: response.plan,
          validation: { valid: validationErrors.length === 0, errors: validationErrors },
          usage: response.usage,
          attempt_count: response.attempt_count,
        });
      } catch (error) {
        await writeJson(path.join(errorsPath, `${stem}.json`), {
          post_id: input.post_id,
          error: error.message,
          attempt_count: error.attempt_count ?? options.retries + 1,
        });
      }
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(options.concurrency, Math.max(1, pending.length)) },
    () => worker(),
  ));
  const results = [];
  const errors = [];
  for (const input of inputs) {
    const stem = safeStem(input.post_id);
    const resultFile = path.join(resultsPath, `${stem}.json`);
    const errorFile = path.join(errorsPath, `${stem}.json`);
    if (await exists(resultFile)) results.push(JSON.parse(await fs.promises.readFile(resultFile, "utf8")));
    else if (await exists(errorFile)) errors.push(JSON.parse(await fs.promises.readFile(errorFile, "utf8")));
  }
  const asJsonl = (items) => items.length ? `${items.map((item) => JSON.stringify(item)).join("\n")}\n` : "";
  await writeAtomic(path.join(outputPath, "results.jsonl"), asJsonl(results));
  await writeAtomic(path.join(outputPath, "errors.jsonl"), asJsonl(errors));
  const valid = results.filter((item) => item.validation.valid);
  const summary = {
    ...manifest,
    success_count: results.length,
    valid_count: valid.length,
    invalid_count: results.length - valid.length,
    error_count: errors.length,
    posts_with_entities: valid.filter((item) => item.extraction.entities.length > 0).length,
    entity_count: valid.reduce((sum, item) => sum + item.extraction.entities.length, 0),
    entity_type_counts: Object.fromEntries([...VALID_TYPES].map((type) => [
      type,
      valid.reduce((sum, item) => sum + item.extraction.entities.filter((entity) => entity.type === type).length, 0),
    ])),
    usage: {
      total_tokens: results.reduce((sum, item) => sum + Number(item.usage?.total_tokens ?? 0), 0),
    },
  };
  await writeJson(path.join(outputPath, "summary.json"), summary);
  console.log(JSON.stringify(summary, null, 2));
}

const isDirectRun = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

export { validateExtraction };
