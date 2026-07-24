#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadEnvFile } from "./test-poi-query-llm.mjs";

function parseArgs(argv) {
  const options = {
    source: "data-processing/data/vlm_results_v2_repaired_v2.jsonl",
    output: "data-processing/data/analysis/amap_region_fallback_v1",
    retries: 2,
    execute: false,
    confirm: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source") options.source = argv[++index];
    else if (arg === "--output") options.output = argv[++index];
    else if (arg === "--retries") options.retries = Number(argv[++index]);
    else if (arg === "--execute") options.execute = true;
    else if (arg === "--confirm") options.confirm = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (
    !Number.isInteger(options.retries) ||
    options.retries < 0 ||
    options.retries > 2
  ) {
    throw new Error("--retries must be 0, 1, or 2");
  }
  if (options.execute && options.confirm !== "FULL_REGION_GEOCODE") {
    throw new Error(
      "Execution requires --execute --confirm FULL_REGION_GEOCODE",
    );
  }
  return options;
}

function cleanRegion(value) {
  if (typeof value !== "string") return "";
  return value.replace(/^发布于\s*/u, "").trim();
}

function fileStem(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

async function callGeocode(region, apiKey, retries) {
  let lastError;
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    try {
      const url = new URL("https://restapi.amap.com/v3/geocode/geo");
      url.searchParams.set("address", region);
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sourcePath = path.resolve(options.source);
  const outputPath = path.resolve(options.output);
  const rawPath = path.join(outputPath, "raw_responses");
  await fs.promises.mkdir(rawPath, { recursive: true });
  loadEnvFile(path.resolve("data-processing/.env"));
  const apiKey = process.env.amap_key ?? process.env.AMAP_KEY;
  if (options.execute && !apiKey) throw new Error("Missing amap_key or AMAP_KEY");

  const text = await fs.promises.readFile(sourcePath, "utf8");
  const regions = [
    ...new Set(
      text
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => cleanRegion(JSON.parse(line).region_name))
        .filter(Boolean),
    ),
  ].sort((left, right) => left.localeCompare(right, "zh-CN"));

  const manifest = {
    generated_at: new Date().toISOString(),
    mode: options.execute ? "execute" : "dry_run",
    source: sourcePath,
    region_count: regions.length,
    concurrency: 1,
    regions,
  };
  await fs.promises.writeFile(
    path.join(outputPath, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  if (!options.execute) {
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  const results = [];
  const errors = [];
  for (const region of regions) {
    try {
      const response = await callGeocode(region, apiKey, options.retries);
      const rawFile = path.join(rawPath, `${fileStem(region)}.json`);
      await fs.promises.writeFile(rawFile, response.raw, "utf8");
      const geocode = response.payload.geocodes?.[0] ?? null;
      results.push({
        region,
        found: Boolean(geocode?.location),
        location: geocode?.location ?? null,
        formatted_address: geocode?.formatted_address ?? null,
        province: geocode?.province ?? null,
        city: geocode?.city ?? null,
        district: geocode?.district ?? null,
        level: geocode?.level ?? null,
        attempt_count: response.attempt_count,
        raw_response_file: path.relative(outputPath, rawFile),
      });
    } catch (error) {
      errors.push({
        region,
        error: error.message,
        attempt_count: error.attempt_count ?? options.retries + 1,
      });
    }
  }
  const toJsonl = (items) =>
    items.length
      ? `${items.map((item) => JSON.stringify(item)).join("\n")}\n`
      : "";
  await fs.promises.writeFile(
    path.join(outputPath, "results.jsonl"),
    toJsonl(results),
    "utf8",
  );
  await fs.promises.writeFile(
    path.join(outputPath, "errors.jsonl"),
    toJsonl(errors),
    "utf8",
  );
  await fs.promises.writeFile(
    path.join(outputPath, "summary.json"),
    `${JSON.stringify(
      {
        ...manifest,
        success_count: results.length,
        found_count: results.filter((item) => item.found).length,
        not_found_count: results.filter((item) => !item.found).length,
        error_count: errors.length,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(
    JSON.stringify({
      regions: regions.length,
      found: results.filter((item) => item.found).length,
      errors: errors.length,
    }),
  );
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
