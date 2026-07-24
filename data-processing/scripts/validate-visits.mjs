#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

function readJsonl(filePath) {
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

function main() {
  const posts = readJsonl(path.resolve("data-processing/data/vlm_results_v2_with_poi_mentions_v1.jsonl"));
  const visits = readJsonl(path.resolve("data-processing/data/visits_v1.jsonl"));
  const places = readJsonl(path.resolve("data-processing/data/places_v1.jsonl"));
  const regions = readJsonl(path.resolve("data-processing/data/regions_v1.jsonl"));
  const roles = readJsonl(path.resolve("data-processing/data/journey_post_roles_v1.jsonl"));
  const postIds = new Set(posts.map((post) => String(post.id ?? post.mid)));
  const visitIds = new Set();
  const placeIds = new Set(places.map((place) => place.id));
  const regionIds = new Set(regions.map((region) => region.id));
  assert.equal(roles.length, posts.length, "journey roles must cover every post");
  for (const visit of visits) {
    assert(!visitIds.has(visit.id), `duplicate visit ${visit.id}`);
    visitIds.add(visit.id);
    assert(visit.post_ids.length > 0, `visit without posts ${visit.id}`);
    for (const postId of visit.post_ids) assert(postIds.has(postId), `unknown post ${postId}`);
    if (visit.place_id) assert(placeIds.has(visit.place_id), `unknown place ${visit.place_id}`);
    for (const placeId of visit.place_candidate_ids) {
      assert(placeIds.has(placeId), `unknown candidate place ${placeId}`);
    }
    if (visit.region_id) assert(regionIds.has(visit.region_id), `unknown region ${visit.region_id}`);
    assert(new Date(visit.visited_at_start) <= new Date(visit.visited_at_end), `invalid time ${visit.id}`);
    if (visit.route_eligibility === "anchor") {
      assert(!["temporal_neighbor", "ip_region_centroid", "global_default"].includes(visit.coordinate_source), `fallback route anchor ${visit.id}`);
      assert.equal(visit.points.length, 1, `anchor must have one point ${visit.id}`);
      assert(Number.isFinite(visit.points[0].longitude), `invalid longitude ${visit.id}`);
      assert(Number.isFinite(visit.points[0].latitude), `invalid latitude ${visit.id}`);
    }
    if (visit.route_eligibility === "region_only") {
      assert(visit.region_id, `region visit without region ${visit.id}`);
    }
  }
  const rolePostIds = new Set();
  for (const role of roles) {
    assert(postIds.has(role.post_id), `unknown role post ${role.post_id}`);
    assert(!rolePostIds.has(role.post_id), `duplicate role post ${role.post_id}`);
    rolePostIds.add(role.post_id);
    for (const visitId of role.visit_ids) assert(visitIds.has(visitId), `unknown role visit ${visitId}`);
  }
  console.log(JSON.stringify({
    valid: true,
    posts: posts.length,
    roles: roles.length,
    visits: visits.length,
    places: places.length,
    regions: regions.length,
    route_anchors: visits.filter((visit) => visit.route_eligibility === "anchor").length,
    region_visits: visits.filter((visit) => visit.route_eligibility === "region_only").length,
    candidate_visits: visits.filter((visit) => visit.route_eligibility === "candidate").length,
    forbidden_fallback_anchors: 0,
    references_valid: true,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
