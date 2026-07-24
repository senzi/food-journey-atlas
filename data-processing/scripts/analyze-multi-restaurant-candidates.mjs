#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import crypto from "node:crypto";

function parseArgs(argv) {
  const options = {
    input: "data-processing/data/vlm_results_v2_repaired_v2.jsonl",
    output: "data-processing/data/analysis/multi_restaurant_candidates_v1",
    samplePerGroup: 15,
    seed: "multi-restaurant-v1",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") options.input = argv[++index];
    else if (arg === "--output") options.output = argv[++index];
    else if (arg === "--sample-per-group") {
      options.samplePerGroup = Number(argv[++index]);
    } else if (arg === "--seed") options.seed = argv[++index];
    else if (arg === "--help") {
      console.log(
        "Usage: node data-processing/scripts/analyze-multi-restaurant-candidates.mjs " +
          "[--input data-processing/data/vlm_results_v2_repaired_v2.jsonl] " +
          "[--output data-processing/data/analysis/multi_restaurant_candidates_v1] " +
          "[--sample-per-group 15]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (
    !Number.isInteger(options.samplePerGroup) ||
    options.samplePerGroup < 1 ||
    options.samplePerGroup > 50
  ) {
    throw new Error("--sample-per-group must be an integer from 1 to 50");
  }
  return options;
}

function normalizeName(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[·•・]/g, "")
    .replace(/[\s，,。.!！?？:：;；'"“”‘’（）()【】[\]《》<>_\-/\\]/g, "");
}

function normalizeBaseName(value) {
  return normalizeName(value)
    .replace(/(?:旗舰|总|分|新|老)?店$/g, "")
    .replace(/(?:餐厅|饭店|酒家|酒楼|菜馆|食府|小馆|面馆|火锅|烧烤)$/g, "");
}

function levenshtein(left, right) {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  const previous = Array.from({ length: right.length + 1 }, (_, i) => i);

  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = previous[j];
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + cost);
      diagonal = above;
    }
  }
  return previous[right.length];
}

function nameRelation(leftRaw, rightRaw) {
  const left = normalizeName(leftRaw);
  const right = normalizeName(rightRaw);
  const leftBase = normalizeBaseName(leftRaw);
  const rightBase = normalizeBaseName(rightRaw);

  if (left === right) return { relation: "normalized_equal", similarity: 1 };
  if (leftBase && leftBase === rightBase) {
    return { relation: "base_equal", similarity: 0.95 };
  }
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length > right.length ? left : right;
  if (shorter.length >= 2 && longer.includes(shorter)) {
    return {
      relation: "contains",
      similarity: shorter.length / longer.length,
    };
  }

  const maxLength = Math.max(left.length, right.length);
  const similarity =
    maxLength === 0 ? 1 : 1 - levenshtein(left, right) / maxLength;
  return {
    relation: similarity >= 0.7 ? "edit_similar" : "different",
    similarity: Number(similarity.toFixed(3)),
  };
}

function classifyCase(names) {
  const pairs = [];
  for (let left = 0; left < names.length; left += 1) {
    for (let right = left + 1; right < names.length; right += 1) {
      pairs.push({
        left: names[left],
        right: names[right],
        ...nameRelation(names[left], names[right]),
      });
    }
  }

  const related = pairs.filter((pair) =>
    ["normalized_equal", "base_equal", "contains", "edit_similar"].includes(
      pair.relation,
    ),
  ).length;
  const different = pairs.length - related;

  let group;
  if (different === 0) group = "likely_alias_variants";
  else if (related === 0) group = "likely_distinct_names";
  else group = "mixed_or_uncertain";

  return { group, pairs };
}

function getName(item) {
  if (typeof item === "string") return item.trim();
  if (item && typeof item === "object") return String(item.name ?? "").trim();
  return "";
}

function stableRank(seed, postId) {
  return crypto
    .createHash("sha256")
    .update(`${seed}:${postId}`)
    .digest("hex");
}

async function writeJson(filePath, value) {
  await fs.promises.writeFile(
    filePath,
    `${JSON.stringify(value, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
}

async function writeJsonl(filePath, rows) {
  const content = rows.length
    ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`
    : "";
  await fs.promises.writeFile(filePath, content, {
    encoding: "utf8",
    flag: "wx",
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(options.input);
  const outputPath = path.resolve(options.output);
  if (fs.existsSync(outputPath)) {
    const entries = await fs.promises.readdir(outputPath);
    if (entries.length > 0) {
      throw new Error(`Refusing to overwrite non-empty output: ${outputPath}`);
    }
  }
  await fs.promises.mkdir(outputPath, { recursive: true });

  const cases = [];
  const input = fs.createReadStream(inputPath, {
    encoding: "utf8",
    flags: "r",
  });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });

  for await (const line of lines) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    const byName = new Map();
    const placeClues = new Set();

    for (const media of Array.isArray(row.vlm_analysis)
      ? row.vlm_analysis
      : []) {
      const analysis = media?.stage2?.analysis;
      if (!analysis || typeof analysis !== "object") continue;
      for (const item of Array.isArray(analysis.restaurant_name_candidates)
        ? analysis.restaurant_name_candidates
        : []) {
        const name = getName(item);
        if (!name) continue;
        const record = byName.get(name) ?? {
          name,
          sources: new Set(),
          confidences: [],
          pic_indexes: new Set(),
          occurrences: 0,
        };
        if (item?.source) record.sources.add(item.source);
        if (Number.isFinite(Number(item?.confidence))) {
          record.confidences.push(Number(item.confidence));
        }
        record.pic_indexes.add(media.pic_index);
        record.occurrences += 1;
        byName.set(name, record);
      }
      for (const item of Array.isArray(analysis.place_clues)
        ? analysis.place_clues
        : []) {
        const name = getName(item);
        if (name) placeClues.add(name);
      }
    }

    if (byName.size <= 1) continue;
    const names = [...byName.keys()];
    const classification = classifyCase(names);
    cases.push({
      post_id: String(row.id ?? row.mid),
      created_at: row.created_at ?? null,
      content_excerpt:
        typeof row.content === "string" ? row.content.slice(0, 500) : "",
      source_geo_poi:
        typeof row.geo_normalized?.source_poi === "string"
          ? row.geo_normalized.source_poi
          : null,
      source_geo_usable: row.geo_normalized?.usable ?? false,
      names: [...byName.values()].map((record) => ({
        name: record.name,
        normalized: normalizeName(record.name),
        base_normalized: normalizeBaseName(record.name),
        sources: [...record.sources],
        confidence_min:
          record.confidences.length > 0
            ? Math.min(...record.confidences)
            : null,
        confidence_max:
          record.confidences.length > 0
            ? Math.max(...record.confidences)
            : null,
        pic_indexes: [...record.pic_indexes].sort((a, b) => a - b),
        occurrences: record.occurrences,
        exact_in_content:
          typeof row.content === "string" && row.content.includes(record.name),
      })),
      place_clues: [...placeClues],
      relation_group: classification.group,
      pair_relations: classification.pairs,
    });
  }

  const grouped = Object.groupBy(cases, (item) => item.relation_group);
  const samples = [];
  for (const group of [
    "likely_alias_variants",
    "mixed_or_uncertain",
    "likely_distinct_names",
  ]) {
    const items = [...(grouped[group] ?? [])].sort((left, right) =>
      stableRank(options.seed, left.post_id).localeCompare(
        stableRank(options.seed, right.post_id),
      ),
    );
    samples.push(...items.slice(0, options.samplePerGroup));
  }

  const summary = {
    analysis_version: "multi_restaurant_candidates_v1",
    generated_at: new Date().toISOString(),
    input: inputPath,
    total_cases: cases.length,
    group_counts: Object.fromEntries(
      [
        "likely_alias_variants",
        "mixed_or_uncertain",
        "likely_distinct_names",
      ].map((group) => [group, grouped[group]?.length ?? 0]),
    ),
    candidate_count_distribution: Object.fromEntries(
      Object.entries(
        Object.groupBy(cases, (item) => String(item.names.length)),
      ).map(([count, items]) => [count, items.length]),
    ),
    sample_per_group: options.samplePerGroup,
    sample_count: samples.length,
    note:
      "Name relation groups are heuristic triage labels, not final POI decisions.",
  };

  await Promise.all([
    writeJson(path.join(outputPath, "summary.json"), summary),
    writeJsonl(path.join(outputPath, "all_cases.jsonl"), cases),
    writeJsonl(path.join(outputPath, "samples.jsonl"), samples),
  ]);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
