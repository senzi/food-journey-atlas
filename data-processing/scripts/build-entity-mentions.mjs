#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const TYPE_PRIORITY = {
  restaurant: 4,
  dish: 3,
  cuisine: 2,
  region: 1,
};

const GENERIC_RESTAURANT_TERMS = new Set([
  "饭店",
  "餐厅",
  "饭馆",
  "菜馆",
  "小馆",
  "小馆子",
  "苍蝇馆子",
  "咖啡店",
  "咖啡馆",
  "酒吧",
  "酒馆",
  "小酒馆",
  "食堂",
  "面馆",
  "面店",
  "粉店",
  "餐馆",
  "茶馆",
  "排档",
  "小店",
  "烧烤店",
  "火锅店",
  "风味",
]);

function parseArgs(argv) {
  const options = {
    input: "data-processing/data/vlm_results_v2_with_poi_v5.jsonl",
    llm: "data-processing/data/analysis/text_entity_mentions_llm_v1/results.jsonl",
    output: "data-processing/data/vlm_results_v2_with_poi_mentions_v1.jsonl",
    entities: "data-processing/data/entities_v1.jsonl",
    analysis: "data-processing/data/analysis/entity_mentions_v1",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") options.input = argv[++index];
    else if (arg === "--llm") options.llm = argv[++index];
    else if (arg === "--output") options.output = argv[++index];
    else if (arg === "--entities") options.entities = argv[++index];
    else if (arg === "--analysis") options.analysis = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function readJsonl(filePath, optional = false) {
  try {
    const text = await fs.promises.readFile(filePath, "utf8");
    return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (optional && error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeAtomic(filePath, content) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.promises.writeFile(temporaryPath, content, "utf8");
  await fs.promises.rename(temporaryPath, filePath);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function itemText(item) {
  if (typeof item === "string") return item;
  return item?.name ?? item?.text ?? "";
}

function itemConfidence(item, fallback = 0.8) {
  const value = Number(item?.confidence);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

function normalizeEntityTerm(value) {
  return String(value)
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/\s+/gu, "");
}

function normalizeNameForSimilarity(value) {
  return normalizeEntityTerm(value)
    .replace(/[（(][^（）()]{0,20}(?:店|馆|分店)?[）)]$/u, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function diceSimilarity(left, right) {
  const a = normalizeNameForSimilarity(left);
  const b = normalizeNameForSimilarity(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) {
    const shorterLength = Math.min(a.length, b.length);
    const ratio = shorterLength / Math.max(a.length, b.length);
    if (shorterLength >= 3) return Math.max(0.65, ratio);
    if (shorterLength === 2) return Math.max(0.5, ratio);
    return ratio;
  }
  if (a.length < 2 || b.length < 2) return 0;
  const counts = new Map();
  for (let index = 0; index < a.length - 1; index += 1) {
    const pair = a.slice(index, index + 2);
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  let overlap = 0;
  for (let index = 0; index < b.length - 1; index += 1) {
    const pair = b.slice(index, index + 2);
    const count = counts.get(pair) ?? 0;
    if (count > 0) {
      overlap += 1;
      counts.set(pair, count - 1);
    }
  }
  return (2 * overlap) / (a.length - 1 + b.length - 1);
}

function entityId(type, term) {
  return `ent_${type}_${sha256(`${type}\0${normalizeEntityTerm(term)}`).slice(0, 16)}`;
}

function mentionId(postId, start, end, id) {
  return `mention_${sha256(`${postId}\0${start}\0${end}\0${id}`).slice(0, 16)}`;
}

function isRestaurantPoint(point) {
  return Boolean(
    point?.poi_id
      && (
        /^05/.test(String(point.typecode ?? ""))
        || /餐饮|餐厅|饭店|小吃|咖啡|酒吧|restaurant/i.test(String(point.type ?? ""))
        || point.extraction_kind === "restaurant"
      )
  );
}

function collectCandidates(row, llmResult) {
  const content = row.content ?? "";
  const candidates = new Map();
  const llmDiscardTerms = new Set();
  function add(type, term, source, confidence = 0.8) {
    if (!Object.hasOwn(TYPE_PRIORITY, type) || typeof term !== "string") return;
    const text = term.trim();
    if (text.length < 2 || !content.includes(text)) return;
    if (
      type === "restaurant"
      && GENERIC_RESTAURANT_TERMS.has(normalizeEntityTerm(text))
    ) return;
    const key = `${type}\0${text}`;
    const existing = candidates.get(key);
    if (existing) {
      existing.sources.add(source);
      existing.entity_confidence = Math.max(existing.entity_confidence, confidence);
      return;
    }
    candidates.set(key, {
      term: text,
      entity_type: type,
      sources: new Set([source]),
      entity_confidence: confidence,
    });
  }

  for (const media of row.vlm_analysis ?? []) {
    const analysis = media?.stage2?.analysis;
    if (!analysis) continue;
    for (const item of analysis.restaurant_name_candidates ?? []) {
      add("restaurant", itemText(item), "vlm_restaurant_candidate", itemConfidence(item));
    }
    for (const item of analysis.dish_candidates ?? []) {
      add("dish", itemText(item), "vlm_dish_candidate", itemConfidence(item));
    }
    for (const item of analysis.cuisine_style ?? []) {
      add("cuisine", itemText(item), "vlm_cuisine_candidate", itemConfidence(item));
    }
  }

  const resolution = row.poi_resolution ?? {};
  for (const point of resolution.points ?? []) {
    if (isRestaurantPoint(point)) {
      add(
        "restaurant",
        point.name,
        "selected_amap_poi_name",
        resolution.confidence === "high" ? 0.98 : 0.82,
      );
    }
    for (const region of [point.province, point.city, point.district]) {
      add("region", region, "amap_region_exact_in_text", 0.9);
    }
    if (["region", "city", "country"].includes(point.extraction_kind)) {
      add("region", point.extraction_text, "explicit_region_extraction", point.extraction_confidence ?? 0.8);
    }
  }

  if (llmResult?.validation?.valid) {
    for (const item of llmResult.extraction?.entities ?? []) {
      if (Object.hasOwn(TYPE_PRIORITY, item.type)) {
        add(item.type, item.text, "text_llm_exact_candidate", itemConfidence(item, 0.8));
      } else if (typeof item.text === "string") {
        llmDiscardTerms.add(normalizeEntityTerm(item.text));
      }
    }
  }
  return [...candidates.values()].filter((candidate) => {
    if (llmDiscardTerms.has(normalizeEntityTerm(candidate.term))) return false;
    if (!llmResult?.validation?.valid) return true;
    const authoritativeSources = new Set([
      "text_llm_exact_candidate",
      "selected_amap_poi_name",
      "amap_region_exact_in_text",
      "explicit_region_extraction",
    ]);
    return [...candidate.sources].some((source) =>
      authoritativeSources.has(source)
    );
  });
}

function locateCandidates(content, candidates) {
  const located = [];
  for (const candidate of candidates) {
    let fromIndex = 0;
    while (fromIndex < content.length) {
      const start = content.indexOf(candidate.term, fromIndex);
      if (start === -1) break;
      located.push({
        ...candidate,
        sources: [...candidate.sources].sort(),
        start,
        end: start + candidate.term.length,
      });
      fromIndex = start + candidate.term.length;
    }
  }
  return located;
}

function overlaps(left, right) {
  return left.start < right.end && right.start < left.end;
}

function resolveOverlaps(located) {
  const unique = new Map();
  for (const item of located) {
    const key = `${item.start}\0${item.end}\0${item.entity_type}\0${item.term}`;
    const existing = unique.get(key);
    if (!existing) unique.set(key, item);
    else {
      existing.sources = [...new Set([...existing.sources, ...item.sources])].sort();
      existing.entity_confidence = Math.max(existing.entity_confidence, item.entity_confidence);
    }
  }
  const ranked = [...unique.values()].sort((a, b) => {
    const lengthDifference = (b.end - b.start) - (a.end - a.start);
    if (lengthDifference) return lengthDifference;
    const typeDifference = TYPE_PRIORITY[b.entity_type] - TYPE_PRIORITY[a.entity_type];
    if (typeDifference) return typeDifference;
    if (b.entity_confidence !== a.entity_confidence) return b.entity_confidence - a.entity_confidence;
    return a.start - b.start;
  });
  const selected = [];
  let rejectedOverlapCount = 0;
  for (const item of ranked) {
    if (selected.some((chosen) => overlaps(item, chosen))) {
      rejectedOverlapCount += 1;
      continue;
    }
    selected.push(item);
  }
  selected.sort((a, b) => a.start - b.start || a.end - b.end);
  return { selected, rejectedOverlapCount };
}

function relatedPlaceRefs(row, term) {
  const references = [];
  const resolution = row.poi_resolution ?? {};
  for (const point of resolution.points ?? []) {
    if (!point?.poi_id || !isRestaurantPoint(point)) continue;
    const similarity = diceSimilarity(term, point.name);
    if (similarity < 0.45) continue;
    references.push({
      external_provider: "amap",
      external_poi_id: point.poi_id,
      name: point.name,
      selection_method: resolution.method,
      selection_confidence: point.selection_confidence ?? resolution.confidence,
      name_similarity: Number(similarity.toFixed(4)),
    });
  }
  const deduplicated = new Map();
  for (const reference of references) {
    deduplicated.set(reference.external_poi_id, reference);
  }
  return [...deduplicated.values()].sort((a, b) =>
    String(a.external_poi_id).localeCompare(String(b.external_poi_id))
  );
}

function ensureCatalogEntity(catalog, mention, placeRefs) {
  let entity = catalog.get(mention.entity_id);
  if (!entity) {
    entity = {
      entity_id: mention.entity_id,
      entity_type: mention.entity_type,
      canonical_name: mention.text,
      aliases: new Set(),
      source_methods: new Set(),
      post_ids: new Set(),
      occurrence_count: 0,
      max_entity_confidence: 0,
      place_refs: new Map(),
    };
    catalog.set(mention.entity_id, entity);
  }
  entity.aliases.add(mention.text);
  for (const source of mention.candidate_sources) entity.source_methods.add(source);
  entity.post_ids.add(mention.post_id);
  entity.occurrence_count += 1;
  entity.max_entity_confidence = Math.max(entity.max_entity_confidence, mention.entity_confidence);
  for (const reference of placeRefs) {
    entity.place_refs.set(reference.external_poi_id, reference);
  }
}

function finalizeCatalog(catalog) {
  return [...catalog.values()]
    .map((entity) => {
      const placeRefs = [...entity.place_refs.values()];
      let matchStatus = "not_applicable";
      if (entity.entity_type === "restaurant") {
        if (placeRefs.length === 0) matchStatus = "unmatched";
        else if (placeRefs.length === 1) matchStatus = "unique_high";
        else matchStatus = "multiple";
      }
      return {
        entity_id: entity.entity_id,
        entity_type: entity.entity_type,
        canonical_name: entity.canonical_name,
        aliases: [...entity.aliases].sort(),
        source_methods: [...entity.source_methods].sort(),
        match_status: matchStatus,
        match_confidence: Number(entity.max_entity_confidence.toFixed(4)),
        external_provider: entity.entity_type === "restaurant" && placeRefs.length ? "amap" : null,
        external_poi_id: placeRefs.length === 1 ? placeRefs[0].external_poi_id : null,
        place_refs: placeRefs,
        occurrence_count: entity.occurrence_count,
        post_count: entity.post_ids.size,
      };
    })
    .sort((a, b) => a.entity_id.localeCompare(b.entity_id));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(options.input);
  const llmPath = path.resolve(options.llm);
  const outputPath = path.resolve(options.output);
  const entitiesPath = path.resolve(options.entities);
  const analysisPath = path.resolve(options.analysis);
  const [inputText, rows, llmRows] = await Promise.all([
    fs.promises.readFile(inputPath, "utf8"),
    readJsonl(inputPath),
    readJsonl(llmPath, true),
  ]);
  const llmByPostId = new Map(llmRows.map((item) => [String(item.post_id), item]));
  const catalog = new Map();
  const outputRows = [];
  const indexRows = [];
  const typeCounts = { restaurant: 0, dish: 0, cuisine: 0, region: 0 };
  const sourceCounts = {};
  let postsWithMentions = 0;
  let totalMentions = 0;
  let rejectedOverlapCount = 0;
  let llmBackedMentions = 0;
  let linkedRestaurantMentions = 0;
  const generatedAt = new Date().toISOString();

  for (const row of rows) {
    const postId = String(row.id ?? row.mid);
    const content = row.content ?? "";
    const candidates = collectCandidates(row, llmByPostId.get(postId));
    const resolved = resolveOverlaps(locateCandidates(content, candidates));
    rejectedOverlapCount += resolved.rejectedOverlapCount;
    const mentions = resolved.selected.map((item) => {
      const id = entityId(item.entity_type, item.term);
      const placeRefs = item.entity_type === "restaurant" ? relatedPlaceRefs(row, item.term) : [];
      let linkStatus = "entity";
      if (item.entity_type === "restaurant") {
        if (placeRefs.length === 0) linkStatus = "unmatched";
        else if (placeRefs.length === 1) linkStatus = "unique_high";
        else linkStatus = "multiple";
      }
      const mention = {
        mention_id: mentionId(postId, item.start, item.end, id),
        entity_id: id,
        entity_type: item.entity_type,
        text: content.slice(item.start, item.end),
        start: item.start,
        end: item.end,
        source: "text_exact",
        confidence: 1,
        entity_confidence: Number(item.entity_confidence.toFixed(4)),
        candidate_sources: item.sources,
        link_status: linkStatus,
        place_refs: placeRefs.map((reference) => reference.external_poi_id),
      };
      const catalogMention = { ...mention, post_id: postId };
      ensureCatalogEntity(catalog, catalogMention, placeRefs);
      typeCounts[mention.entity_type] += 1;
      for (const source of mention.candidate_sources) {
        sourceCounts[source] = (sourceCounts[source] ?? 0) + 1;
      }
      if (mention.candidate_sources.includes("text_llm_exact_candidate")) llmBackedMentions += 1;
      if (mention.entity_type === "restaurant" && placeRefs.length > 0) linkedRestaurantMentions += 1;
      return mention;
    });
    if (mentions.length > 0) postsWithMentions += 1;
    totalMentions += mentions.length;
    const extraction = {
      method: llmByPostId.get(postId)?.validation?.valid
        ? "deterministic_match_with_text_llm_candidates"
        : "deterministic_dictionary_match",
      rule_version: "entity_mentions_v1",
      generated_at: generatedAt,
      llm_candidate_version: llmByPostId.get(postId)?.validation?.valid
        ? "text_entity_mentions_llm_v1"
        : null,
      candidate_count: candidates.length,
      mention_count: mentions.length,
      overlap_rejected_count: resolved.rejectedOverlapCount,
    };
    outputRows.push({ ...row, mentions, mention_extraction: extraction });
    indexRows.push({
      post_id: postId,
      mention_count: mentions.length,
      entity_ids: [...new Set(mentions.map((mention) => mention.entity_id))],
      entity_type_counts: Object.fromEntries(Object.keys(TYPE_PRIORITY).map((type) => [
        type,
        mentions.filter((mention) => mention.entity_type === type).length,
      ])),
    });
  }

  const entities = finalizeCatalog(catalog);
  const outputText = `${outputRows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  const entityText = entities.length ? `${entities.map((row) => JSON.stringify(row)).join("\n")}\n` : "";
  const indexText = `${indexRows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  const summary = {
    version: "entity_mentions_v1",
    generated_at: generatedAt,
    input_file: inputPath,
    input_sha256: sha256(inputText),
    llm_results_file: llmRows.length ? llmPath : null,
    llm_valid_post_count: llmRows.filter((item) => item.validation?.valid).length,
    output_file: outputPath,
    output_sha256: sha256(outputText),
    entity_file: entitiesPath,
    entity_sha256: sha256(entityText),
    row_count: rows.length,
    posts_with_mentions: postsWithMentions,
    posts_with_mentions_rate: Number((postsWithMentions / rows.length).toFixed(6)),
    total_mentions: totalMentions,
    entity_count: entities.length,
    entity_type_counts: Object.fromEntries(Object.keys(TYPE_PRIORITY).map((type) => [
      type,
      entities.filter((entity) => entity.entity_type === type).length,
    ])),
    mention_type_counts: typeCounts,
    mention_source_counts: sourceCounts,
    llm_backed_mentions: llmBackedMentions,
    linked_restaurant_mentions: linkedRestaurantMentions,
    overlap_rejected_count: rejectedOverlapCount,
  };
  const report = `# Entity mentions v1 运行报告

- 输入：\`${inputPath}\`
- 输出：\`${outputPath}\`
- 实体目录：\`${entitiesPath}\`
- 微博数：${rows.length}
- 有 mention 的微博：${postsWithMentions}（${(100 * postsWithMentions / rows.length).toFixed(1)}%）
- mentions 总数：${totalMentions}
- 实体数：${entities.length}
- 餐厅 / 菜品 / 菜系 / 地区 mentions：${typeCounts.restaurant} / ${typeCounts.dish} / ${typeCounts.cuisine} / ${typeCounts.region}
- 可链接高德候选的餐厅 mentions：${linkedRestaurantMentions}
- LLM 候选支持的 mentions：${llmBackedMentions}
- 已解决的重叠候选：${rejectedOverlapCount}

## 约束

- 输入 v5 文件只读，输出为新副本。
- 每个 \`mention.text\` 都严格等于 \`content.slice(start, end)\`。
- LLM 只提供正文中的候选词，字符位置由确定性脚本计算。
- IP 属地 \`region_name\` 未进入地区候选。
- 餐厅无法确定高德分店时保留 \`unmatched\` 或 \`multiple\`，不伪装成唯一 Place。
`;

  await Promise.all([
    writeAtomic(outputPath, outputText),
    writeAtomic(entitiesPath, entityText),
    writeAtomic(path.join(analysisPath, "mention_index.jsonl"), indexText),
    writeAtomic(path.join(analysisPath, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`),
    writeAtomic(path.join(analysisPath, "RUN_REPORT.md"), report),
  ]);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
