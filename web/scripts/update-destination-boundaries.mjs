import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const sources = {
  country:
    "https://raw.githubusercontent.com/martynafford/natural-earth-geojson/master/50m/cultural/ne_50m_admin_0_countries.json",
  admin1:
    "https://raw.githubusercontent.com/martynafford/natural-earth-geojson/master/50m/cultural/ne_50m_admin_1_states_provinces.json",
};

function pointInRing(longitude, latitude, ring) {
  let inside = false;
  for (
    let index = 0, previous = ring.length - 1;
    index < ring.length;
    previous = index++
  ) {
    const [x, y] = ring[index];
    const [previousX, previousY] = ring[previous];
    const crosses =
      y > latitude !== previousY > latitude &&
      longitude <
        ((previousX - x) * (latitude - y)) / (previousY - y || 1e-12) + x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function contains(geometry, longitude, latitude) {
  const polygons =
    geometry?.type === "Polygon"
      ? [geometry.coordinates]
      : geometry?.type === "MultiPolygon"
        ? geometry.coordinates
        : [];
  return polygons.some(
    (polygon) =>
      polygon[0] &&
      pointInRing(longitude, latitude, polygon[0]) &&
      !polygon
        .slice(1)
        .some((hole) => pointInRing(longitude, latitude, hole)),
  );
}

const atlas = JSON.parse(
  await readFile(
    path.resolve(process.cwd(), "public", "data", "atlas.json"),
    "utf8",
  ),
);
const points = atlas.trips
  .flatMap((trip) => trip.visits)
  .filter(
    (visit) =>
      Number.isFinite(visit.longitude) &&
      Number.isFinite(visit.latitude) &&
      !(
        visit.longitude >= 72 &&
        visit.longitude <= 136 &&
        visit.latitude >= 17 &&
        visit.latitude <= 55
      ),
  );

const [countries, admin1] = await Promise.all(
  Object.values(sources).map(async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`无法下载底图数据：${response.status}`);
    return response.json();
  }),
);

const selectedCountries = countries.features.filter((feature) =>
  points.some((point) =>
    contains(feature.geometry, point.longitude, point.latitude),
  ),
);
const selectedCountryCodes = new Set(
  selectedCountries.map((feature) => feature.properties?.ADM0_A3),
);
const selectedAdmin1 = admin1.features.filter(
  (feature) =>
    selectedCountryCodes.has(feature.properties?.adm0_a3) &&
    points.some((point) =>
      contains(feature.geometry, point.longitude, point.latitude),
    ),
);

const output = {
  source: "Natural Earth 1:50m（CC0），仅保留现有海外旅程涉及区域",
  features: [
    ...selectedCountries.map((feature) => ({
      name: feature.properties?.NAME || feature.properties?.ADMIN || "",
      country: feature.properties?.ADMIN || "",
      code: feature.properties?.ADM0_A3 || "",
      level: "country",
      geometry: feature.geometry,
    })),
    ...selectedAdmin1.map((feature) => ({
      name: feature.properties?.name || "",
      country: feature.properties?.admin || "",
      code: feature.properties?.adm1_code || "",
      level: "admin1",
      geometry: feature.geometry,
    })),
  ],
};

const outputPath = path.resolve(
  process.cwd(),
  "scripts",
  "vendor",
  "journey_destination_boundaries.json",
);
await writeFile(outputPath, JSON.stringify(output), "utf8");
console.log(
  `Destination boundaries updated: ${selectedCountries.length} countries, ${selectedAdmin1.length} regions, ${points.length} journey points`,
);
