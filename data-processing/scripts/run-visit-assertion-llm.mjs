#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadEnvFile } from "./test-poi-query-llm.mjs";

const ASSERTIONS = new Set([
  "visited",
  "likely_visited",
  "mentioned_only",
  "delivery_only",
  "historical_reference",
  "planned",
  "non_visit",
  "unclear",
]);
const TIME_RELATIONS = new Set([
  "contemporaneous",
  "recent_relative",
  "post_time_proxy",
  "historical_or_memory",
  "future",
  "unknown",
]);
const GROUP_ROLES = new Set([
  "visit_place",
  "supporting_location",
  "mentioned_only",
  "irrelevant",
]);
const SELECTION_STATUSES = new Set([
  "confirmed",
  "candidate_set",
  "not_applicable",
]);

function parseArgs(argv) {
  const options = {
    input: "data-processing/data/vlm_results_v2_with_poi_mentions_v1.jsonl",
    output: "data-processing/data/analysis/visit_assertion_llm_v1",
    prompt: "data-processing/prompts/visit-assertion-v1.md",
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
  if (options.execute && options.confirm !== "VISIT_ASSERTION") {
    throw new Error("Execution requires --execute --confirm VISIT_ASSERTION");
  }
  return options;
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

function groupPoints(points) {
  const groups = new Map();
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const groupId = point.source_request_id || `ungrouped_${index}`;
    if (!groups.has(groupId)) groups.set(groupId, []);
    groups.get(groupId).push({
      point_index: index,
      poi_id: point.poi_id ?? null,
      name: point.name ?? "",
      address: point.address ?? "",
      province: point.province ?? "",
      city: point.city ?? "",
      district: point.district ?? "",
      type: point.type ?? "",
      coordinate_status: point.coordinate_status ?? "",
      is_fallback: Boolean(point.is_fallback),
    });
  }
  return [...groups].map(([group_id, groupPointsValue]) => ({
    group_id,
    point_indexes: groupPointsValue.map((point) => point.point_index),
    points: groupPointsValue,
  }));
}

function compactRow(row) {
  const resolution = row.poi_resolution ?? {};
  return {
    post_id: String(row.id ?? row.mid),
    content: row.content ?? "",
    created_at: row.created_at,
    location_evidence: {
      method: resolution.method,
      confidence: resolution.confidence,
      is_display_fallback: resolution.is_display_fallback,
      point_groups: groupPoints(resolution.points ?? []),
    },
    text_entities: (row.mentions ?? []).map((mention) => ({
      type: mention.entity_type,
      text: mention.text,
      link_status: mention.link_status,
    })),
  };
}

function validate(plan, input) {
  const errors = [];
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return ["top_level_not_object"];
  }
  if (Object.hasOwn(plan, "post_id")) errors.push("unexpected_post_id");
  if (!ASSERTIONS.has(plan.visit_assertion)) errors.push("invalid_visit_assertion");
  if (!TIME_RELATIONS.has(plan.time_relation)) errors.push("invalid_time_relation");
  const confidence = Number(plan.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    errors.push("invalid_confidence");
  }
  if (!Array.isArray(plan.point_groups)) return [...errors, "point_groups_not_array"];
  const inputGroups = new Map(input.location_evidence.point_groups.map((group) => [
    group.group_id,
    new Set(group.point_indexes),
  ]));
  const seenGroups = new Set();
  const blockedLocationMethod = new Set([
    "temporal_neighbor",
    "ip_region_centroid",
    "global_default",
  ]).has(input.location_evidence.method);
  for (const [index, group] of plan.point_groups.entries()) {
    if (!inputGroups.has(group?.group_id)) errors.push(`group_${index}_unknown_group_id`);
    if (seenGroups.has(group?.group_id)) errors.push(`group_${index}_duplicate_group`);
    seenGroups.add(group?.group_id);
    if (!GROUP_ROLES.has(group?.role)) errors.push(`group_${index}_invalid_role`);
    if (!SELECTION_STATUSES.has(group?.selection_status)) {
      errors.push(`group_${index}_invalid_selection_status`);
    }
    if (
      blockedLocationMethod
      && (
        group?.role === "visit_place"
        || group?.selection_status === "confirmed"
        || group?.selection_status === "candidate_set"
      )
    ) {
      errors.push(`group_${index}_forbidden_fallback_visit_place`);
    }
    if (!Array.isArray(group?.selected_point_indexes)) {
      errors.push(`group_${index}_indexes_not_array`);
    } else {
      const allowed = inputGroups.get(group.group_id) ?? new Set();
      for (const pointIndex of group.selected_point_indexes) {
        if (!Number.isInteger(pointIndex) || !allowed.has(pointIndex)) {
          errors.push(`group_${index}_invalid_point_index`);
        }
      }
    }
    const groupConfidence = Number(group?.confidence);
    if (!Number.isFinite(groupConfidence) || groupConfidence < 0 || groupConfidence > 1) {
      errors.push(`group_${index}_invalid_confidence`);
    }
    if (typeof group?.evidence !== "string") {
      errors.push(`group_${index}_invalid_evidence`);
    } else if (group.evidence && !input.content.includes(group.evidence)) {
      errors.push(`group_${index}_evidence_not_exact`);
    }
  }
  if (typeof plan.reason !== "string") errors.push("invalid_reason");
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

async function callDeepSeek({ baseUrl, apiKey, model, systemPrompt, input }) {
  const userInput = structuredClone(input);
  delete userInput.post_id;
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
        await new Promise((resolve) => setTimeout(
          resolve,
          (attempt === 1 ? 1000 : 2500) + Math.floor(Math.random() * 1000),
        ));
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
  const rows = readJsonl(path.resolve(options.input));
  let inputs = rows.map(compactRow);
  if (options.limit > 0) inputs = inputs.slice(0, options.limit);
  const systemPrompt = await fs.promises.readFile(path.resolve(options.prompt), "utf8");
  const manifest = {
    script_version: "visit_assertion_llm_v1",
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
          input,
        }, options.retries);
        await writeAtomic(path.join(rawPath, `${stem}.json`), response.raw_response_text);
        const validationErrors = validate(response.plan, input);
        await writeJson(path.join(resultsPath, `${stem}.json`), {
          post_id: input.post_id,
          assertion: response.plan,
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
  const valid = results.filter((result) => result.validation.valid);
  const countBy = (field, allowed) => Object.fromEntries([...allowed].map((value) => [
    value,
    valid.filter((result) => result.assertion[field] === value).length,
  ]));
  const summary = {
    ...manifest,
    success_count: results.length,
    valid_count: valid.length,
    invalid_count: results.length - valid.length,
    error_count: errors.length,
    assertion_counts: countBy("visit_assertion", ASSERTIONS),
    time_relation_counts: countBy("time_relation", TIME_RELATIONS),
    visit_place_group_count: valid.reduce((sum, result) =>
      sum + result.assertion.point_groups.filter((group) => group.role === "visit_place").length, 0),
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
