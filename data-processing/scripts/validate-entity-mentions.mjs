#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

function parseArgs(argv) {
  const options = {
    source: "data-processing/data/vlm_results_v2_with_poi_v5.jsonl",
    final: "data-processing/data/vlm_results_v2_with_poi_mentions_v1.jsonl",
    entities: "data-processing/data/entities_v1.jsonl",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source") options.source = argv[++index];
    else if (arg === "--final") options.final = argv[++index];
    else if (arg === "--entities") options.entities = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const source = readJsonl(path.resolve(options.source));
  const final = readJsonl(path.resolve(options.final));
  const entities = readJsonl(path.resolve(options.entities));
  const allowedTypes = new Set(["restaurant", "dish", "cuisine", "region"]);
  const entityIds = new Set(entities.map((entity) => entity.entity_id));
  const entityById = new Map(entities.map((entity) => [entity.entity_id, entity]));
  assert.equal(entityIds.size, entities.length, "duplicate entity IDs");
  for (const entity of entities) {
    assert(allowedTypes.has(entity.entity_type), `invalid public entity type ${entity.entity_type}`);
  }
  assert.equal(final.length, source.length, "row count changed");
  let mentions = 0;
  let postsWithMentions = 0;
  const seenPostIds = new Set();
  const globalMentionIds = new Set();
  for (let index = 0; index < final.length; index += 1) {
    const row = final[index];
    const original = structuredClone(row);
    delete original.mentions;
    delete original.mention_extraction;
    assert.deepEqual(original, source[index], `source fields changed at line ${index + 1}`);
    const postId = String(row.id ?? row.mid);
    assert(!seenPostIds.has(postId), `duplicate post ID ${postId}`);
    seenPostIds.add(postId);
    assert(Array.isArray(row.mentions), `mentions missing for ${postId}`);
    if (row.mentions.length) postsWithMentions += 1;
    const mentionIds = new Set();
    let previousEnd = -1;
    for (const mention of row.mentions) {
      mentions += 1;
      assert(!mentionIds.has(mention.mention_id), `duplicate mention ID in ${postId}`);
      mentionIds.add(mention.mention_id);
      assert(!globalMentionIds.has(mention.mention_id), `duplicate global mention ID ${mention.mention_id}`);
      globalMentionIds.add(mention.mention_id);
      assert(entityIds.has(mention.entity_id), `unknown entity ${mention.entity_id}`);
      assert(allowedTypes.has(mention.entity_type), `invalid mention type in ${postId}`);
      assert.equal(entityById.get(mention.entity_id).entity_type, mention.entity_type, `entity type mismatch in ${postId}`);
      assert.equal(mention.source, "text_exact", `invalid mention source in ${postId}`);
      assert(Number.isInteger(mention.start) && Number.isInteger(mention.end), `invalid offsets in ${postId}`);
      assert(mention.start >= 0 && mention.start < mention.end && mention.end <= row.content.length, `offset out of range in ${postId}`);
      assert.equal(row.content.slice(mention.start, mention.end), mention.text, `slice mismatch in ${postId}`);
      assert(mention.start >= previousEnd, `overlapping mentions in ${postId}`);
      previousEnd = mention.end;
    }
  }
  console.log(JSON.stringify({
    valid: true,
    rows: final.length,
    unique_post_ids: seenPostIds.size,
    entities: entities.length,
    mentions,
    posts_with_mentions: postsWithMentions,
    source_values_preserved: true,
    slices_valid: true,
    overlaps_absent: true,
    entity_references_valid: true,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
