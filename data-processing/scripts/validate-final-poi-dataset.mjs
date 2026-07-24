#!/usr/bin/env node

import fs from "node:fs";
import assert from "node:assert/strict";
import crypto from "node:crypto";

function parseArgs(argv) {
  const options = {
    source: "data-processing/data/vlm_results_v2_repaired_v2.jsonl",
    final: "data-processing/data/vlm_results_v2_with_poi_v5.jsonl",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source") options.source = argv[++index];
    else if (arg === "--final") options.final = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function lines(buffer) {
  return buffer
    .toString("utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim());
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const sourceBuffer = fs.readFileSync(options.source);
  const finalBuffer = fs.readFileSync(options.final);
  const sourceLines = lines(sourceBuffer);
  const finalLines = lines(finalBuffer);
  assert.equal(finalLines.length, sourceLines.length, "row count mismatch");

  const ids = new Set();
  const methodCounts = new Map();
  let pointCount = 0;
  let displayFallbackCount = 0;
  for (let index = 0; index < sourceLines.length; index += 1) {
    const source = JSON.parse(sourceLines[index]);
    const final = JSON.parse(finalLines[index]);
    const resolution = final.poi_resolution;
    delete final.poi_resolution;
    assert.deepEqual(final, source, `source fields changed at line ${index + 1}`);
    assert.ok(resolution, `missing poi_resolution at line ${index + 1}`);
    assert.ok(
      Array.isArray(resolution.points) && resolution.points.length > 0,
      `missing POI point at line ${index + 1}`,
    );
    assert.ok(
      Number.isInteger(resolution.primary_point_index) &&
        resolution.primary_point_index >= 0 &&
        resolution.primary_point_index < resolution.points.length,
      `invalid primary_point_index at line ${index + 1}`,
    );
    for (const point of resolution.points) {
      assert.ok(
        Number.isFinite(point.longitude) &&
          point.longitude >= -180 &&
          point.longitude <= 180,
        `invalid longitude at line ${index + 1}`,
      );
      assert.ok(
        Number.isFinite(point.latitude) &&
          point.latitude >= -90 &&
          point.latitude <= 90,
        `invalid latitude at line ${index + 1}`,
      );
    }
    const postId = String(source.id ?? source.mid);
    assert.ok(!ids.has(postId), `duplicate post_id ${postId}`);
    ids.add(postId);
    pointCount += resolution.points.length;
    if (resolution.is_display_fallback) displayFallbackCount += 1;
    methodCounts.set(
      resolution.method,
      (methodCounts.get(resolution.method) ?? 0) + 1,
    );
  }

  console.log(
    JSON.stringify(
      {
        source: options.source,
        final: options.final,
        source_sha256: sha256(sourceBuffer),
        final_sha256: sha256(finalBuffer),
        rows: finalLines.length,
        unique_post_ids: ids.size,
        total_points: pointCount,
        display_fallback_posts: displayFallbackCount,
        every_post_has_point: true,
        source_values_preserved: true,
        all_coordinates_valid: true,
        method_counts: Object.fromEntries(
          [...methodCounts.entries()].sort((left, right) =>
            left[0].localeCompare(right[0]),
          ),
        ),
      },
      null,
      2,
    ),
  );
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
