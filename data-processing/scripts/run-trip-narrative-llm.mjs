#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadEnvFile } from "./test-poi-query-llm.mjs";

function parseArgs(argv) {
  const options = {
    trips: "data-processing/data/trips_v1.jsonl",
    visits: "data-processing/data/visits_with_trips_v1.jsonl",
    posts: "data-processing/data/vlm_results_v2_with_poi_mentions_v1.jsonl",
    entities: "data-processing/data/entities_v1.jsonl",
    output: "data-processing/data/analysis/trip_narratives_llm_v2",
    prompt: "data-processing/prompts/trip-narrative-v1.md",
    model: "deepseek-v4-flash",
    baseUrl: "https://api.deepseek.com",
    concurrency: 100,
    retries: 2,
    limit: 0,
    execute: false,
    confirm: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--trips") options.trips = argv[++index];
    else if (arg === "--visits") options.visits = argv[++index];
    else if (arg === "--posts") options.posts = argv[++index];
    else if (arg === "--entities") options.entities = argv[++index];
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
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 500) {
    throw new Error("--concurrency must be from 1 to 500");
  }
  if (!Number.isInteger(options.limit) || options.limit < 0) throw new Error("--limit must be non-negative");
  if (options.execute && options.confirm !== "TRIP_NARRATIVES") {
    throw new Error("Execution requires --execute --confirm TRIP_NARRATIVES");
  }
  return options;
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse);
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

function safeStem(value) {
  return String(value).replace(/[^A-Za-z0-9_-]/g, "_");
}

function buildInputs(trips, visitById, postById, entityById) {
  return trips.map((trip) => {
    const visits = trip.visit_ids.map((visitId) => {
      const visit = visitById.get(visitId);
      return {
        visit_id: visit.id,
        time: visit.visited_at_start,
        place: visit.points[0]?.name ?? "",
        city: visit.points[0]?.city || visit.points[0]?.district || visit.points[0]?.province || "",
        foods: visit.food_ids.map((id) => ({
          entity_id: id,
          name: entityById.get(id)?.canonical_name ?? "",
          type: entityById.get(id)?.entity_type ?? "",
        })),
        posts: visit.post_ids.map((postId) => ({
          post_id: postId,
          content: (postById.get(postId)?.content ?? "").slice(0, 700),
        })),
      };
    });
    return {
      trip_id: trip.id,
      trip_kind: trip.trip_kind,
      start_date: trip.start_date,
      end_date: trip.end_date,
      region_labels: trip.region_labels,
      quality_flags: trip.quality_flags,
      allowed_theme_entity_ids: trip.theme_food_ids,
      visits,
    };
  });
}

function validate(plan, input) {
  const errors = [];
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return ["top_level_not_object"];
  if (Object.hasOwn(plan, "trip_id")) errors.push("unexpected_trip_id");
  for (const field of ["title", "subtitle", "summary", "uncertainty_note"]) {
    if (typeof plan[field] !== "string") errors.push(`invalid_${field}`);
  }
  if (typeof plan.title === "string" && (plan.title.length < 2 || plan.title.length > 40)) {
    errors.push("title_length");
  }
  const allowedThemes = new Set(input.allowed_theme_entity_ids);
  if (!Array.isArray(plan.theme_entity_ids)) errors.push("themes_not_array");
  else {
    for (const id of plan.theme_entity_ids) {
      if (!allowedThemes.has(id)) errors.push("unknown_theme_id");
    }
  }
  const allowedVisits = new Set(input.visits.map((visit) => visit.visit_id));
  if (!Array.isArray(plan.highlights)) errors.push("highlights_not_array");
  else {
    if (plan.highlights.length > 4) errors.push("too_many_highlights");
    for (const [index, highlight] of plan.highlights.entries()) {
      if (!allowedVisits.has(highlight?.visit_id)) errors.push(`highlight_${index}_unknown_visit`);
      if (typeof highlight?.text !== "string" || !highlight.text) {
        errors.push(`highlight_${index}_invalid_text`);
      }
    }
  }
  return errors;
}

async function callDeepSeek({ baseUrl, apiKey, model, systemPrompt, input }) {
  const userInput = structuredClone(input);
  delete userInput.trip_id;
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
        { role: "user", content: JSON.stringify(userInput) },
      ],
      response_format: { type: "json_object" },
      thinking: { type: "disabled" },
      temperature: 0.2,
      max_tokens: 2500,
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
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
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
  const trips = readJsonl(path.resolve(options.trips));
  const visits = readJsonl(path.resolve(options.visits));
  const posts = readJsonl(path.resolve(options.posts));
  const entities = readJsonl(path.resolve(options.entities));
  const visitById = new Map(visits.map((visit) => [visit.id, visit]));
  const postById = new Map(posts.map((post) => [String(post.id ?? post.mid), post]));
  const entityById = new Map(entities.map((entity) => [entity.entity_id, entity]));
  let inputs = buildInputs(trips, visitById, postById, entityById);
  if (options.limit > 0) inputs = inputs.slice(0, options.limit);
  const systemPrompt = await fs.promises.readFile(path.resolve(options.prompt), "utf8");
  const manifest = {
    script_version: "trip_narrative_llm_v1",
    created_at: new Date().toISOString(),
    mode: options.execute ? "execute" : "dry_run",
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
    if (!(await exists(path.join(resultsPath, `${safeStem(input.trip_id)}.json`)))) pending.push(input);
  }
  let cursor = 0;
  async function worker() {
    while (cursor < pending.length) {
      const input = pending[cursor++];
      const stem = safeStem(input.trip_id);
      try {
        const response = await callWithRetry({
          baseUrl: options.baseUrl,
          apiKey,
          model: options.model,
          systemPrompt,
          input,
        }, options.retries);
        await writeAtomic(path.join(rawPath, `${stem}.json`), response.raw_response_text);
        const validationErrors = validate(response.plan, input);
        await writeJson(path.join(resultsPath, `${stem}.json`), {
          trip_id: input.trip_id,
          narrative: response.plan,
          validation: { valid: validationErrors.length === 0, errors: validationErrors },
          usage: response.usage,
          attempt_count: response.attempt_count,
        });
      } catch (error) {
        await writeJson(path.join(errorsPath, `${stem}.json`), {
          trip_id: input.trip_id,
          error: error.message,
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
    const stem = safeStem(input.trip_id);
    const resultFile = path.join(resultsPath, `${stem}.json`);
    const errorFile = path.join(errorsPath, `${stem}.json`);
    if (await exists(resultFile)) results.push(JSON.parse(await fs.promises.readFile(resultFile, "utf8")));
    else if (await exists(errorFile)) errors.push(JSON.parse(await fs.promises.readFile(errorFile, "utf8")));
  }
  const asJsonl = (items) => items.length ? `${items.map((item) => JSON.stringify(item)).join("\n")}\n` : "";
  await writeAtomic(path.join(outputPath, "results.jsonl"), asJsonl(results));
  await writeAtomic(path.join(outputPath, "errors.jsonl"), asJsonl(errors));
  const summary = {
    ...manifest,
    success_count: results.length,
    valid_count: results.filter((result) => result.validation.valid).length,
    invalid_count: results.filter((result) => !result.validation.valid).length,
    error_count: errors.length,
    usage: {
      total_tokens: results.reduce((sum, result) => sum + Number(result.usage?.total_tokens ?? 0), 0),
    },
  };
  await writeJson(path.join(outputPath, "summary.json"), summary);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
