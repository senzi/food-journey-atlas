#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadEnvFile } from "./test-poi-query-llm.mjs";

function parseArgs(argv) {
  const options = {
    input: "data-processing/data/analysis/fallback_location_extraction_v1/results.jsonl",
    output: "data-processing/data/analysis/fallback_location_amap_v1",
    minConfidence: 0.75,
    retries: 2,
    execute: false,
    confirm: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") options.input = argv[++index];
    else if (arg === "--output") options.output = argv[++index];
    else if (arg === "--min-confidence") {
      options.minConfidence = Number(argv[++index]);
    } else if (arg === "--retries") options.retries = Number(argv[++index]);
    else if (arg === "--execute") options.execute = true;
    else if (arg === "--confirm") options.confirm = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (
    !Number.isFinite(options.minConfidence) ||
    options.minConfidence < 0 ||
    options.minConfidence > 1
  ) {
    throw new Error("--min-confidence must be from 0 to 1");
  }
  if (
    !Number.isInteger(options.retries) ||
    options.retries < 0 ||
    options.retries > 2
  ) {
    throw new Error("--retries must be 0, 1, or 2");
  }
  if (options.execute && options.confirm !== "FULL_FALLBACK_AMAP") {
    throw new Error(
      "Execution requires --execute --confirm FULL_FALLBACK_AMAP",
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

function normalize(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function similarity(left, right) {
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) {
    return 0.75 + 0.2 * (Math.min(a.length, b.length) / Math.max(a.length, b.length));
  }
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}

function endpointFor(kind) {
  return ["address", "city", "region", "country"].includes(kind)
    ? "geocode"
    : "text";
}

function requestId(postId, index) {
  return `${postId}__loc${index}`;
}

function safeStem(value) {
  return String(value).replace(/[^A-Za-z0-9_-]/g, "_");
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

async function callAmap(item, apiKey, retries) {
  let lastError;
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    try {
      const url =
        item.endpoint === "geocode"
          ? new URL("https://restapi.amap.com/v3/geocode/geo")
          : new URL("https://restapi.amap.com/v5/place/text");
      if (item.endpoint === "geocode") {
        url.searchParams.set("address", item.text);
      } else {
        url.searchParams.set("keywords", item.text);
        url.searchParams.set("page_size", "10");
        url.searchParams.set("page_num", "1");
        url.searchParams.set("show_fields", "business,navi");
      }
      url.searchParams.set("output", "json");
      url.searchParams.set("key", apiKey);
      const response = await fetch(url, {
        signal: AbortSignal.timeout(30_000),
      });
      const raw = await response.text();
      const payload = JSON.parse(raw);
      if (!response.ok || String(payload.status) !== "1") {
        throw new Error(
          `AMap ${response.status} ${payload.infocode ?? ""} ${payload.info ?? ""}`,
        );
      }
      return { payload, raw, attempt_count: attempt };
    } catch (error) {
      lastError = error;
      if (attempt <= retries) {
        await new Promise((resolve) =>
          setTimeout(resolve, 500 * attempt + Math.random() * 500),
        );
      }
    }
  }
  lastError.attempt_count = retries + 1;
  throw lastError;
}

function resolvePayload(item, payload) {
  if (item.endpoint === "geocode") {
    const geocode = payload.geocodes?.[0];
    if (!geocode?.location) return null;
    return {
      accepted: true,
      match_score: 1,
      poi_id: null,
      name: geocode.formatted_address || item.text,
      location: geocode.location,
      address: geocode.formatted_address ?? "",
      province: geocode.province ?? "",
      city: Array.isArray(geocode.city)
        ? geocode.city.join("")
        : geocode.city ?? "",
      district: Array.isArray(geocode.district)
        ? geocode.district.join("")
        : geocode.district ?? "",
      type: `geocode_${item.kind}`,
      typecode: null,
      business_area: null,
      rating: null,
    };
  }
  const candidates = (payload.pois ?? [])
    .map((poi) => ({
      poi,
      score: similarity(item.text, poi.name),
    }))
    .sort((left, right) => right.score - left.score);
  const best = candidates[0];
  if (!best || best.score < 0.62 || !best.poi.location) return null;
  return {
    accepted: true,
    match_score: Math.round(best.score * 10000) / 10000,
    poi_id: best.poi.id,
    name: best.poi.name,
    location: best.poi.location,
    address: best.poi.address ?? "",
    province: best.poi.pname ?? "",
    city: best.poi.cityname ?? "",
    district: best.poi.adname ?? "",
    type: best.poi.type ?? "",
    typecode: best.poi.typecode ?? "",
    business_area: best.poi.business?.business_area ?? null,
    rating: best.poi.business?.rating ?? null,
  };
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
  const apiKey = process.env.amap_key ?? process.env.AMAP_KEY;
  if (options.execute && !apiKey) throw new Error("Missing AMap API key");

  const extractionRows = await readJsonl(path.resolve(options.input));
  const requests = extractionRows.flatMap((row) => {
    if (!row.validation?.valid) return [];
    return row.extraction.locations
      .map((location, index) => ({
        request_id: requestId(row.post_id, index),
        post_id: String(row.post_id),
        location_index: index,
        text: location.text,
        kind: location.kind,
        extraction_confidence: Number(location.confidence),
        evidence: location.evidence,
        endpoint: endpointFor(location.kind),
      }))
      .filter(
        (item) => item.extraction_confidence >= options.minConfidence,
      );
  });
  const manifest = {
    script_version: "fallback_location_amap_v1",
    created_at: new Date().toISOString(),
    mode: options.execute ? "execute" : "dry_run",
    min_confidence: options.minConfidence,
    request_count: requests.length,
    concurrency: 1,
    endpoint_counts: {
      geocode: requests.filter((item) => item.endpoint === "geocode").length,
      text: requests.filter((item) => item.endpoint === "text").length,
    },
  };
  await writeJson(path.join(outputPath, "manifest.json"), manifest);
  await writeAtomic(
    path.join(outputPath, "requests.jsonl"),
    requests.length
      ? `${requests.map((item) => JSON.stringify(item)).join("\n")}\n`
      : "",
  );
  if (!options.execute) {
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  let completed = 0;
  let failed = 0;
  for (const item of requests) {
    const stem = safeStem(item.request_id);
    const resultFile = path.join(resultsPath, `${stem}.json`);
    if (await exists(resultFile)) continue;
    try {
      const response = await callAmap(item, apiKey, options.retries);
      await writeAtomic(
        path.join(rawPath, `${stem}.json`),
        response.raw,
      );
      const resolved = resolvePayload(item, response.payload);
      await writeJson(resultFile, {
        ...item,
        resolved,
        accepted: Boolean(resolved),
        attempt_count: response.attempt_count,
      });
      completed += 1;
    } catch (error) {
      await writeJson(path.join(errorsPath, `${stem}.json`), {
        ...item,
        error: error.message,
        attempt_count: error.attempt_count ?? options.retries + 1,
      });
      failed += 1;
    }
    if ((completed + failed) % 50 === 0) {
      console.log(
        JSON.stringify({
          processed: completed + failed,
          total: requests.length,
          success: completed,
          failed,
        }),
      );
    }
  }

  const results = [];
  const errors = [];
  for (const item of requests) {
    const stem = safeStem(item.request_id);
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
    accepted_count: results.filter((item) => item.accepted).length,
    rejected_count: results.filter((item) => !item.accepted).length,
    accepted_post_count: new Set(
      results.filter((item) => item.accepted).map((item) => item.post_id),
    ).size,
    error_count: errors.length,
  };
  await writeJson(path.join(outputPath, "summary.json"), summary);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
