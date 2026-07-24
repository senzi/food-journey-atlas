#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const options = {
    input: "data-processing/data/analysis/fallback_location_amap_v1/results.jsonl",
    index: "data-processing/data/analysis/final_poi_dataset_v1/poi_resolution_index.jsonl",
    output: "data-processing/data/analysis/fallback_location_amap_v2",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") options.input = argv[++index];
    else if (arg === "--index") options.index = argv[++index];
    else if (arg === "--output") options.output = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function normalize(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function typePrefix(typecode) {
  return String(typecode ?? "").slice(0, 2);
}

function parseLocation(value) {
  if (typeof value !== "string") return null;
  const [longitude, latitude] = value.split(",").map(Number);
  return Number.isFinite(longitude) && Number.isFinite(latitude)
    ? [longitude, latitude]
    : null;
}

function haversineKm(left, right) {
  const radians = (degrees) => (degrees * Math.PI) / 180;
  const latitudeDelta = radians(right[1] - left[1]);
  const longitudeDelta = radians(right[0] - left[0]);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(left[1])) *
      Math.cos(radians(right[1])) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function contextConflict(item, preliminary) {
  if (item.kind !== "address" || !preliminary) {
    return false;
  }
  const hasExplicitRegion =
    /(省|市|自治区|特别行政区|区|县|旗|北京|上海|天津|重庆|香港|澳门|台湾)/u.test(
      item.text,
    );
  if (preliminary.method === "global_default" && !hasExplicitRegion) {
    return true;
  }
  if (
    !["temporal_neighbor", "ip_region_centroid"].includes(preliminary.method)
  ) {
    return false;
  }
  const resolved = parseLocation(item.resolved?.location);
  const context = parseLocation(preliminary.primary_point?.location);
  return Boolean(
    resolved &&
      context &&
      haversineKm(resolved, context) > 300,
  );
}

function acceptTextResult(item, preliminary) {
  if (!item.resolved) return { accepted: false, reason: "no_resolved_candidate" };
  if (contextConflict(item, preliminary)) {
    return {
      accepted: false,
      reason: "address_conflicts_with_existing_context",
    };
  }
  const score = Number(item.resolved.match_score ?? 0);
  const thresholds = {
    restaurant: 0.78,
    market: 0.75,
    attraction: 0.75,
    building: 0.75,
    other: 0.82,
  };
  if (score < (thresholds[item.kind] ?? 0.8)) {
    return { accepted: false, reason: "stricter_name_threshold" };
  }

  const query = normalize(item.text);
  const candidate = normalize(item.resolved.name);
  if (
    query.includes(candidate) &&
    candidate.length / Math.max(1, query.length) < 0.65
  ) {
    return {
      accepted: false,
      reason: "candidate_drops_distinctive_query_text",
    };
  }

  const prefix = typePrefix(item.resolved.typecode);
  const compatiblePrefixes = {
    restaurant: new Set(["05", "08", "10"]),
    market: new Set(["06", "12"]),
    attraction: new Set(["08", "11", "14", "19"]),
    building: new Set(["10", "12", "14", "15", "17", "19"]),
    other: null,
  };
  const allowed = compatiblePrefixes[item.kind];
  if (allowed && !allowed.has(prefix) && score < 0.95) {
    return { accepted: false, reason: "poi_type_incompatible" };
  }
  return { accepted: true, reason: "passed_strict_filter" };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outputPath = path.resolve(options.output);
  if (fs.existsSync(outputPath)) {
    const existing = await fs.promises.readdir(outputPath);
    if (existing.length > 0) {
      throw new Error(`Refusing to overwrite non-empty output: ${outputPath}`);
    }
  }
  await fs.promises.mkdir(outputPath, { recursive: true });
  const rows = (await fs.promises.readFile(path.resolve(options.input), "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const preliminaryRows = (
    await fs.promises.readFile(path.resolve(options.index), "utf8")
  )
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const preliminaryByPost = new Map(
    preliminaryRows.map((item) => [String(item.post_id), item]),
  );
  const filtered = rows.map((item) => {
    if (!item.accepted) return item;
    if (
      item.endpoint === "geocode" &&
      !contextConflict(item, preliminaryByPost.get(String(item.post_id)))
    ) {
      return {
        ...item,
        strict_filter: {
          accepted: true,
          reason: "geocode_result",
        },
      };
    }
    const strict = acceptTextResult(
      item,
      preliminaryByPost.get(String(item.post_id)),
    );
    return {
      ...item,
      accepted: strict.accepted,
      strict_filter: strict,
    };
  });
  const accepted = filtered.filter((item) => item.accepted);
  const summary = {
    script_version: "fallback_location_strict_filter_v1",
    generated_at: new Date().toISOString(),
    input_count: rows.length,
    accepted_before: rows.filter((item) => item.accepted).length,
    accepted_after: accepted.length,
    rejected_by_strict_filter:
      rows.filter((item) => item.accepted).length - accepted.length,
    accepted_post_count: new Set(accepted.map((item) => item.post_id)).size,
    rejection_reasons: Object.fromEntries(
      [
        "stricter_name_threshold",
        "candidate_drops_distinctive_query_text",
        "poi_type_incompatible",
        "address_conflicts_with_existing_context",
      ].map((reason) => [
        reason,
        filtered.filter(
          (item) =>
            !item.accepted && item.strict_filter?.reason === reason,
        ).length,
      ]),
    ),
    amap_called: false,
    llm_called: false,
  };
  await fs.promises.writeFile(
    path.join(outputPath, "results.jsonl"),
    `${filtered.map((item) => JSON.stringify(item)).join("\n")}\n`,
    "utf8",
  );
  await fs.promises.writeFile(
    path.join(outputPath, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
