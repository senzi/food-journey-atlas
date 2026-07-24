#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

function readJsonl(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  return text.split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

function main() {
  const posts = readJsonl(path.resolve("data-processing/data/vlm_results_v2_with_poi_mentions_v1.jsonl"));
  const visits = readJsonl(path.resolve("data-processing/data/visits_with_trips_v1.jsonl"));
  const trips = readJsonl(path.resolve("data-processing/data/trips_v1.jsonl"));
  const tripsWithNarratives = readJsonl(path.resolve("data-processing/data/trips_with_narratives_v2.jsonl"));
  const narratives = readJsonl(path.resolve("data-processing/data/trip_narratives_v2.jsonl"));
  const contexts = readJsonl(path.resolve("data-processing/data/trip_context_refs_v1.jsonl"));
  const candidates = readJsonl(path.resolve("data-processing/data/trip_membership_candidates_v1.jsonl"));
  const postIds = new Set(posts.map((post) => String(post.id ?? post.mid)));
  const visitById = new Map(visits.map((visit) => [visit.id, visit]));
  const tripIds = new Set();
  const mainMembership = new Map();
  for (const trip of trips) {
    assert(!tripIds.has(trip.id), `duplicate trip ${trip.id}`);
    tripIds.add(trip.id);
    assert(trip.visit_ids.length >= 2, `trip too small ${trip.id}`);
    assert(new Date(trip.start_date) <= new Date(trip.end_date), `invalid trip time ${trip.id}`);
    assert.equal(trip.route.length, trip.visit_ids.length, `route mismatch ${trip.id}`);
    for (let index = 0; index < trip.visit_ids.length; index += 1) {
      const visitId = trip.visit_ids[index];
      const visit = visitById.get(visitId);
      assert(visit, `unknown visit ${visitId}`);
      assert.equal(visit.route_eligibility, "anchor", `non-anchor in route ${visitId}`);
      assert(!mainMembership.has(visitId), `visit in multiple trips ${visitId}`);
      mainMembership.set(visitId, trip.id);
      assert.equal(trip.route[index].visit_id, visitId, `route order mismatch ${trip.id}`);
    }
    for (const postId of [...trip.post_ids, ...trip.context_post_ids]) {
      assert(postIds.has(postId), `unknown trip post ${postId}`);
    }
  }
  assert.equal(tripsWithNarratives.length, trips.length, "narrative trip count mismatch");
  assert.equal(narratives.length, trips.length, "narrative count mismatch");
  const narrativeByTripId = new Map(narratives.map((item) => [item.trip_id, item]));
  assert.equal(narrativeByTripId.size, trips.length, "duplicate narrative trip IDs");
  for (const trip of tripsWithNarratives) {
    assert(tripIds.has(trip.id), `unknown narrated trip ${trip.id}`);
    assert(narrativeByTripId.has(trip.id), `missing narrative ${trip.id}`);
    assert(typeof trip.title === "string" && trip.title.length > 0, `missing title ${trip.id}`);
    assert.equal(trip.narrative_generation?.source_membership_frozen, true, `unfrozen narrative ${trip.id}`);
  }
  assert.equal(
    new Set(tripsWithNarratives.map((trip) => trip.title)).size,
    tripsWithNarratives.length,
    "final trip titles must be unique",
  );
  for (const visit of visits) {
    if (visit.trip_id) {
      assert(tripIds.has(visit.trip_id), `unknown assigned trip ${visit.trip_id}`);
      assert.equal(mainMembership.get(visit.id), visit.trip_id, `visit assignment mismatch ${visit.id}`);
    }
    if (visit.route_eligibility === "anchor" && visit.trip_id) {
      assert(!["temporal_neighbor", "ip_region_centroid", "global_default"].includes(visit.coordinate_source), `fallback in route ${visit.id}`);
    }
  }
  for (const item of candidates) {
    assert(tripIds.has(item.trip_id), `unknown candidate trip ${item.trip_id}`);
    assert(visitById.has(item.visit_id), `unknown candidate visit ${item.visit_id}`);
    assert(!mainMembership.has(item.visit_id), `candidate also in route ${item.visit_id}`);
  }
  for (const item of contexts) {
    assert(tripIds.has(item.trip_id), `unknown context trip ${item.trip_id}`);
    if (item.post_id) assert(postIds.has(item.post_id), `unknown context post ${item.post_id}`);
    if (item.visit_id) assert(visitById.has(item.visit_id), `unknown context visit ${item.visit_id}`);
    if (item.other_trip_id) assert(tripIds.has(item.other_trip_id), `unknown other trip ${item.other_trip_id}`);
  }
  console.log(JSON.stringify({
    valid: true,
    posts: posts.length,
    visits: visits.length,
    trips: trips.length,
    main_route_visits: mainMembership.size,
    candidate_memberships: candidates.length,
    context_refs: contexts.length,
    narratives: narratives.length,
    unique_main_membership: true,
    main_routes_anchor_only: true,
    references_valid: true,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
