#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";

function readJsonl(filePath) {
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

async function writeAtomic(filePath, content) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.promises.writeFile(temporaryPath, content, "utf8");
  await fs.promises.rename(temporaryPath, filePath);
}

async function main() {
  const trips = readJsonl(path.resolve("data-processing/data/trips_v1.jsonl"));
  const results = readJsonl(path.resolve(
    "data-processing/data/analysis/trip_narratives_llm_v2/results.jsonl"
  ));
  const resultByTripId = new Map(results.map((result) => [result.trip_id, result]));
  const generatedAt = new Date().toISOString();
  let repairedThemeReferenceCount = 0;
  let repairedNarrativeCount = 0;
  const provisional = trips.map((trip) => {
    const result = resultByTripId.get(trip.id);
    assert(result?.narrative, `missing narrative for ${trip.id}`);
    const allowedVisits = new Set(trip.visit_ids);
    const allowedThemes = new Set(trip.theme_food_ids);
    for (const highlight of result.narrative.highlights) {
      assert(allowedVisits.has(highlight.visit_id), `unknown highlight visit in ${trip.id}`);
    }
    const themeEntityIds = result.narrative.theme_entity_ids.filter(
      (entityId) => allowedThemes.has(entityId)
    );
    const droppedThemeIds = result.narrative.theme_entity_ids.filter(
      (entityId) => !allowedThemes.has(entityId)
    );
    if (droppedThemeIds.length > 0) {
      repairedNarrativeCount += 1;
      repairedThemeReferenceCount += droppedThemeIds.length;
    }
    return {
      trip,
      result: {
        ...result,
        narrative: {
          ...result.narrative,
          theme_entity_ids: themeEntityIds,
        },
      },
      droppedThemeIds,
    };
  });
  const titleCounts = new Map();
  for (const { result } of provisional) {
    const title = result.narrative.title;
    titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
  }
  const usedTitles = new Set();
  const narratives = [];
  const merged = provisional.map(({ trip, result, droppedThemeIds }) => {
    const baseTitle = result.narrative.title;
    let title = baseTitle;
    if ((titleCounts.get(baseTitle) ?? 0) > 1) {
      const date = new Date(trip.start_date);
      title = `${baseTitle}（${date.getFullYear()}年${date.getMonth() + 1}月）`;
    }
    if (usedTitles.has(title)) title = `${title}·${trip.id.slice(-4)}`;
    usedTitles.add(title);
    const generation = {
      method: "deepseek_structured_narrative+deterministic_title_dedup",
      version: "trip_narrative_v2",
      generated_at: generatedAt,
      source_membership_frozen: true,
      repaired_unknown_theme_references: droppedThemeIds.length,
    };
    const narrative = {
      trip_id: trip.id,
      ...result.narrative,
      title,
      base_title: baseTitle,
      generation,
    };
    narratives.push(narrative);
    return {
      ...trip,
      title,
      base_title: baseTitle,
      title_source: title === baseTitle
        ? "llm_from_frozen_trip"
        : "llm_from_frozen_trip+deterministic_date_disambiguation",
      subtitle: result.narrative.subtitle,
      summary: result.narrative.summary,
      narrative_theme_entity_ids: result.narrative.theme_entity_ids,
      highlights: result.narrative.highlights,
      uncertainty_note: result.narrative.uncertainty_note,
      narrative_generation: generation,
    };
  });
  const toJsonl = (items) => `${items.map((item) => JSON.stringify(item)).join("\n")}\n`;
  const narrativeText = toJsonl(narratives);
  const mergedText = toJsonl(merged);
  const summary = {
    version: "trip_narrative_v2",
    generated_at: generatedAt,
    trip_count: trips.length,
    narrative_count: narratives.length,
    all_trip_ids_covered: narratives.length === trips.length,
    membership_frozen: true,
    duplicate_base_title_group_count: [...titleCounts.values()].filter((count) => count > 1).length,
    unique_final_titles: new Set(merged.map((trip) => trip.title)).size === merged.length,
    repaired_narrative_count: repairedNarrativeCount,
    repaired_unknown_theme_reference_count: repairedThemeReferenceCount,
    narratives_sha256: crypto.createHash("sha256").update(narrativeText).digest("hex"),
    trips_with_narratives_sha256: crypto.createHash("sha256").update(mergedText).digest("hex"),
  };
  await Promise.all([
    writeAtomic(path.resolve("data-processing/data/trip_narratives_v2.jsonl"), narrativeText),
    writeAtomic(path.resolve("data-processing/data/trips_with_narratives_v2.jsonl"), mergedText),
    writeAtomic(path.resolve("data-processing/data/analysis/trip_narratives_v2/summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`),
  ]);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
