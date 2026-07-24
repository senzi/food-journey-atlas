#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";

const REPAIR_VERSION = "vlm_repair_v2";
const REQUIRED_STAGE1_FIELDS = [
  "food_related",
  "image_type",
  "description",
  "confidence",
  "need_deep_analysis",
  "visual_importance",
];
const REQUIRED_STAGE2_FIELDS = [
  "summary",
  "image_role",
  "dish_candidates",
  "food_categories",
  "ingredients_visible",
  "cooking_methods",
  "cuisine_style",
  "restaurant_scene",
  "restaurant_features",
  "recording_context",
  "visible_text",
  "place_clues",
  "restaurant_name_candidates",
  "importance",
  "notes",
];
const SOURCE_FIELDS = [
  "dish_candidates",
  "food_categories",
  "cooking_methods",
  "cuisine_style",
  "place_clues",
  "restaurant_name_candidates",
];
const SCENE_NORMALIZATION = new Map([
  ["bar", "unknown"],
  ["农家乐", "restaurant"],
  ["家庭或家庭式餐馆", "restaurant"],
  ["kitchen", "home"],
  ["野餐", "unknown"],
  ["outdoor_or_field", "unknown"],
]);

function parseArgs(argv) {
  const options = {
    input: "data-processing/data/vlm_results_v2.jsonl",
    output: "data-processing/data/vlm_results_v2_repaired_v2.jsonl",
    report: "data-processing/data/analysis/vlm_v2_repair_v2",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") options.input = argv[++index];
    else if (arg === "--output") options.output = argv[++index];
    else if (arg === "--report") options.report = argv[++index];
    else if (arg === "--help") {
      console.log(`Usage:
  node data-processing/scripts/repair-vlm-results.mjs \\
    --input data-processing/data/vlm_results_v2.jsonl \\
    --output data-processing/data/vlm_results_v2_repaired_v2.jsonl \\
    --report data-processing/data/analysis/vlm_v2_repair_v2

Safety:
  - The input file is opened read-only.
  - Input and output must be different paths.
  - Existing output files are never overwritten.
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

function normalizeNullableText(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text === "(null)" || text.toLowerCase() === "null") return null;
  return text;
}

function isLatitude(value) {
  return Number.isFinite(value) && value >= -90 && value <= 90;
}

function isLongitude(value) {
  return Number.isFinite(value) && value >= -180 && value <= 180;
}

function isInChinaBounds(longitude, latitude) {
  return (
    longitude >= 73 &&
    longitude <= 136 &&
    latitude >= 3 &&
    latitude <= 54
  );
}

function normalizeGeo(geo) {
  const base = {
    usable: false,
    coordinate_system: "unknown_requires_review",
    source_order: null,
    coordinates_source_order: null,
    coordinates_lng_lat: null,
    in_china_bounds: null,
    source_type: typeof geo?.type === "string" ? geo.type || null : null,
    source_poi: normalizeNullableText(geo?.poi),
    source_poiid: normalizeNullableText(geo?.poiid),
    quality_flags: [],
  };

  if (!geo || !Array.isArray(geo.coordinates) || geo.coordinates.length < 2) {
    base.quality_flags.push("missing_or_unrecognized_geo");
    return base;
  }

  const first = Number(geo.coordinates[0]);
  const second = Number(geo.coordinates[1]);
  base.coordinates_source_order = [
    geo.coordinates[0],
    geo.coordinates[1],
  ];

  if (first === second) {
    base.quality_flags.push("equal_coordinate_placeholder");
    return base;
  }

  // The observed source schema is [latitude, longitude].
  if (isLatitude(first) && isLongitude(second)) {
    base.usable = true;
    base.source_order = "lat_lng";
    base.coordinates_lng_lat = [second, first];
    base.in_china_bounds = isInChinaBounds(second, first);
    return base;
  }

  if (isLongitude(first) && isLatitude(second)) {
    base.usable = true;
    base.source_order = "lng_lat";
    base.coordinates_lng_lat = [first, second];
    base.in_china_bounds = isInChinaBounds(first, second);
    base.quality_flags.push("unexpected_source_coordinate_order");
    return base;
  }

  base.quality_flags.push("coordinate_out_of_global_range");
  return base;
}

function removeTrailingCommasOutsideStrings(text) {
  let output = "";
  let inString = false;
  let escaped = false;
  let removed = 0;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }

    if (character === ",") {
      let lookahead = index + 1;
      while (lookahead < text.length && /\s/.test(text[lookahead])) {
        lookahead += 1;
      }
      if (text[lookahead] === "}" || text[lookahead] === "]") {
        removed += 1;
        continue;
      }
    }
    output += character;
  }

  return { text: output, removed };
}

function fixNotesTerminalSingleQuote(text) {
  let fixed = 0;
  const lines = text.split("\n").map((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('"notes"') || !trimmed.endsWith("'")) return line;

    let unescapedDoubleQuotes = 0;
    let escaped = false;
    for (const character of line) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === '"') unescapedDoubleQuotes += 1;
    }

    if (unescapedDoubleQuotes % 2 === 1) {
      fixed += 1;
      return `${line.slice(0, line.lastIndexOf("'"))}"`;
    }
    return line;
  });
  return { text: lines.join("\n"), fixed };
}

function parseJsonObject(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let text = raw.trim();
  const repairs = [];
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) {
    text = fenced[1].trim();
    repairs.push("markdown_fence_removed");
  }

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { value: parsed, syntax_repairs: repairs };
    }
  } catch {
    const commaRepair = removeTrailingCommasOutsideStrings(text);
    text = commaRepair.text;
    if (commaRepair.removed > 0) {
      repairs.push(`trailing_commas_removed:${commaRepair.removed}`);
    }

    const quoteRepair = fixNotesTerminalSingleQuote(text);
    text = quoteRepair.text;
    if (quoteRepair.fixed > 0) {
      repairs.push(`notes_terminal_single_quote_fixed:${quoteRepair.fixed}`);
    }

    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { value: parsed, syntax_repairs: repairs };
      }
    } catch {
      return null;
    }
  }
  return null;
}

function hasAllFields(object, fields) {
  return (
    object &&
    typeof object === "object" &&
    !Array.isArray(object) &&
    fields.every((field) => Object.hasOwn(object, field))
  );
}

function getCandidateName(item) {
  if (typeof item === "string") return item.trim();
  if (item && typeof item === "object") {
    return String(item.name ?? item.text ?? "").trim();
  }
  return "";
}

function isUsefulVisibleText(item) {
  const text = getCandidateName(item);
  return (
    text.length >= 3 &&
    !/^@/.test(text) &&
    !/^https?:\/\//i.test(text) &&
    !/^(www\.|t\.sina\.com)/i.test(text) &&
    !/(微博|weibo\.com|陈晓卿)/i.test(text)
  );
}

function createMetrics() {
  return {
    rows_read: 0,
    rows_written: 0,
    rows_with_changes: 0,
    media_total: 0,
    stage1_raw_recovered: 0,
    stage1_unresolved: 0,
    stage2_raw_recovered: 0,
    stage2_raw_unresolved: 0,
    restaurant_scene_normalized: 0,
    missing_source_inferred_from_exact_text: 0,
    missing_source_unresolved: 0,
    text_source_not_exact_count: 0,
    media_with_text_source_not_exact: 0,
    visible_text_total: 0,
    visible_text_retained: 0,
    visible_text_excluded: 0,
    posts_with_multiple_restaurant_candidates: 0,
    geo_usable: 0,
    geo_unusable: 0,
    geo_in_china: 0,
    geo_outside_china: 0,
  };
}

function addIssue(issues, issue) {
  issues.push(issue);
}

function normalizeMedia({ media, row, postId, issues, metrics }) {
  metrics.media_total += 1;
  const changes = [];
  const qualityFlags = [];
  const picIndex = media?.pic_index ?? null;

  const stage1 = media?.stage1;
  if (!hasAllFields(stage1, REQUIRED_STAGE1_FIELDS)) {
    const recovered = parseJsonObject(stage1?.raw);
    if (hasAllFields(recovered?.value, REQUIRED_STAGE1_FIELDS)) {
      media._original_stage1_raw = stage1.raw;
      media.stage1 = recovered.value;
      metrics.stage1_raw_recovered += 1;
      changes.push({
        code: "stage1_raw_json_recovered",
        field: "stage1",
        syntax_repairs: recovered.syntax_repairs,
      });
    } else {
      metrics.stage1_unresolved += 1;
      qualityFlags.push("stage1_structure_unresolved");
      addIssue(issues, {
        post_id: postId,
        pic_index: picIndex,
        code: "stage1_structure_unresolved",
        stage1_keys:
          stage1 && typeof stage1 === "object" ? Object.keys(stage1) : [],
        raw_length:
          typeof stage1?.raw === "string" ? stage1.raw.length : null,
      });
    }
  }

  let analysis = media?.stage2?.analysis;
  if (
    media?.stage2?.status === "success" &&
    !hasAllFields(analysis, REQUIRED_STAGE2_FIELDS)
  ) {
    const recovered = parseJsonObject(analysis?.raw);
    if (hasAllFields(recovered?.value, REQUIRED_STAGE2_FIELDS)) {
      media._original_stage2_analysis_raw = analysis.raw;
      media.stage2.analysis = recovered.value;
      analysis = recovered.value;
      metrics.stage2_raw_recovered += 1;
      changes.push({
        code: "stage2_raw_json_recovered",
        field: "stage2.analysis",
        syntax_repairs: recovered.syntax_repairs,
      });
    } else {
      metrics.stage2_raw_unresolved += 1;
      qualityFlags.push("stage2_analysis_structure_unresolved");
      addIssue(issues, {
        post_id: postId,
        pic_index: picIndex,
        code: "stage2_analysis_structure_unresolved",
        analysis_keys:
          analysis && typeof analysis === "object"
            ? Object.keys(analysis)
            : [],
        raw_length:
          typeof analysis?.raw === "string" ? analysis.raw.length : null,
      });
    }
  }

  if (hasAllFields(analysis, REQUIRED_STAGE2_FIELDS)) {
    const originalScene = analysis.restaurant_scene?.type;
    if (SCENE_NORMALIZATION.has(originalScene)) {
      const normalizedScene = SCENE_NORMALIZATION.get(originalScene);
      analysis.restaurant_scene.type = normalizedScene;
      metrics.restaurant_scene_normalized += 1;
      changes.push({
        code: "restaurant_scene_type_normalized",
        field: "stage2.analysis.restaurant_scene.type",
        from: originalScene,
        to: normalizedScene,
      });
    }

    let mismatchCount = 0;
    const mismatchFields = new Set();
    for (const field of SOURCE_FIELDS) {
      const items = Array.isArray(analysis[field]) ? analysis[field] : [];
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if (!item || typeof item !== "object") continue;
        const name = getCandidateName(item);

        if (!Object.hasOwn(item, "source")) {
          if (name && typeof row.content === "string" && row.content.includes(name)) {
            item.source = "text";
            metrics.missing_source_inferred_from_exact_text += 1;
            changes.push({
              code: "missing_source_inferred_from_exact_text",
              field: `stage2.analysis.${field}[${index}].source`,
              to: "text",
            });
          } else {
            metrics.missing_source_unresolved += 1;
            qualityFlags.push("candidate_source_missing_unresolved");
            addIssue(issues, {
              post_id: postId,
              pic_index: picIndex,
              code: "candidate_source_missing_unresolved",
              field,
              item_index: index,
              name,
            });
          }
        }

        if (
          item.source === "text" &&
          name &&
          typeof row.content === "string" &&
          !row.content.includes(name)
        ) {
          mismatchCount += 1;
          mismatchFields.add(field);
        }
      }
    }

    if (mismatchCount > 0) {
      metrics.text_source_not_exact_count += mismatchCount;
      metrics.media_with_text_source_not_exact += 1;
      qualityFlags.push({
        code: "text_source_not_exactly_in_content",
        count: mismatchCount,
        fields: [...mismatchFields],
      });
    }

    const visibleText = Array.isArray(analysis.visible_text)
      ? analysis.visible_text
      : [];
    const usableVisibleText = visibleText.filter(isUsefulVisibleText);
    metrics.visible_text_total += visibleText.length;
    metrics.visible_text_retained += usableVisibleText.length;
    metrics.visible_text_excluded +=
      visibleText.length - usableVisibleText.length;
    media._derived = {
      ...(media._derived ?? {}),
      poi_usable_visible_text: usableVisibleText,
    };
  }

  if (changes.length > 0 || qualityFlags.length > 0) {
    media._repair = {
      version: REPAIR_VERSION,
      changes,
      quality_flags: qualityFlags,
    };
  }

  return changes.length > 0;
}

async function writeJson(filePath, value) {
  await fs.promises.writeFile(
    filePath,
    `${JSON.stringify(value, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
}

async function writeJsonl(filePath, values) {
  const content = values.length
    ? `${values.map((value) => JSON.stringify(value)).join("\n")}\n`
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
  const reportPath = path.resolve(options.report);
  const tempOutputPath = `${outputPath}.tmp-${process.pid}`;

  if (inputPath === outputPath) {
    throw new Error("Refusing to modify the source: input and output are identical");
  }
  const inputStat = await fs.promises.stat(inputPath);
  if (!inputStat.isFile()) throw new Error("Input path is not a file");
  if (fs.existsSync(outputPath)) {
    throw new Error(`Refusing to overwrite existing output: ${outputPath}`);
  }
  if (fs.existsSync(reportPath)) {
    const entries = await fs.promises.readdir(reportPath);
    if (entries.length > 0) {
      throw new Error(`Refusing to overwrite non-empty report directory: ${reportPath}`);
    }
  }

  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.promises.mkdir(reportPath, { recursive: true });

  const inputSha256Before = await sha256File(inputPath);
  const metrics = createMetrics();
  const issues = [];
  const output = fs.createWriteStream(tempOutputPath, {
    encoding: "utf8",
    flags: "wx",
  });
  const input = fs.createReadStream(inputPath, {
    encoding: "utf8",
    flags: "r",
  });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });

  try {
    let lineNumber = 0;
    for await (const line of lines) {
      lineNumber += 1;
      if (!line.trim()) continue;
      metrics.rows_read += 1;
      const row = JSON.parse(line);
      const postId = String(row.id ?? row.mid ?? `line:${lineNumber}`);
      let rowChanged = false;

      const geoNormalized = normalizeGeo(row.geo);
      row.geo_normalized = geoNormalized;
      if (geoNormalized.usable) {
        metrics.geo_usable += 1;
        if (geoNormalized.in_china_bounds) metrics.geo_in_china += 1;
        else metrics.geo_outside_china += 1;
      } else {
        metrics.geo_unusable += 1;
      }

      const restaurantNames = new Set();
      for (const media of Array.isArray(row.vlm_analysis)
        ? row.vlm_analysis
        : []) {
        rowChanged =
          normalizeMedia({ media, row, postId, issues, metrics }) ||
          rowChanged;
        const candidates =
          media?.stage2?.analysis?.restaurant_name_candidates;
        for (const item of Array.isArray(candidates) ? candidates : []) {
          const name = getCandidateName(item);
          if (name) restaurantNames.add(name);
        }
      }

      const rowQualityFlags = [];
      if (restaurantNames.size > 1) {
        metrics.posts_with_multiple_restaurant_candidates += 1;
        rowQualityFlags.push({
          code: "multiple_restaurant_candidates",
          count: restaurantNames.size,
          names: [...restaurantNames],
        });
      }
      if (!geoNormalized.usable && row.geo !== null && row.geo !== undefined) {
        rowQualityFlags.push(...geoNormalized.quality_flags);
      }

      row._processing = {
        repair_version: REPAIR_VERSION,
        source_line: lineNumber,
        source_sha256: inputSha256Before,
        quality_flags: rowQualityFlags,
      };

      if (rowChanged) metrics.rows_with_changes += 1;
      if (!output.write(`${JSON.stringify(row)}\n`)) {
        await new Promise((resolve) => output.once("drain", resolve));
      }
      metrics.rows_written += 1;
    }

    await new Promise((resolve, reject) => {
      output.end(resolve);
      output.on("error", reject);
    });
    await fs.promises.rename(tempOutputPath, outputPath);
  } catch (error) {
    output.destroy();
    if (fs.existsSync(tempOutputPath)) {
      await fs.promises.unlink(tempOutputPath);
    }
    throw error;
  }

  const [inputSha256After, outputSha256] = await Promise.all([
    sha256File(inputPath),
    sha256File(outputPath),
  ]);
  if (inputSha256Before !== inputSha256After) {
    throw new Error("Source file hash changed during repair; output must not be used");
  }

  const manifest = {
    repair_version: REPAIR_VERSION,
    generated_at: new Date().toISOString(),
    source: {
      path: inputPath,
      bytes: inputStat.size,
      sha256_before: inputSha256Before,
      sha256_after: inputSha256After,
      unchanged: true,
    },
    output: {
      path: outputPath,
      bytes: (await fs.promises.stat(outputPath)).size,
      sha256: outputSha256,
      overwritten: false,
    },
    policy: {
      source_opened_read_only: true,
      input_output_paths_different: true,
      existing_output_overwrite_allowed: false,
      uncertain_values_invented: false,
    },
    metrics,
  };

  await writeJson(path.join(reportPath, "repair_manifest.json"), manifest);
  await writeJson(path.join(reportPath, "repair_metrics.json"), metrics);
  await writeJsonl(path.join(reportPath, "unresolved_issues.jsonl"), issues);

  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
