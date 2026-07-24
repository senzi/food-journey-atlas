type SearchAtlas = {
  posts: Record<string, any>;
  places: Record<string, any>;
  regions: Record<string, any>;
};

function collectStrings(value: unknown, target: string[]) {
  if (typeof value === "string") {
    if (value.trim()) target.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, target);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, target);
  }
}

export function normalizeTripSearchQuery(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").trim();
}

export function buildTripSearchText(atlas: SearchAtlas, trip: any) {
  const visits = trip.visits || [];
  const postIds = new Set<string>([
    ...(trip.postIds || []),
    ...visits.flatMap((visit: any) => visit.postIds || []),
  ]);
  const posts = [...postIds]
    .map((id) => atlas.posts[id])
    .filter(Boolean)
    .map((post) => ({
      content: post.content,
      analysis: post.analysis,
      labels: post.labels,
      mentions: post.mentions,
    }));
  const places = visits
    .map((visit: any) => visit.placeId && atlas.places[visit.placeId])
    .filter(Boolean)
    .map((place: any) => ({
      name: place.name,
      type: place.type,
      address: place.address,
      province: place.province,
      city: place.city,
      district: place.district,
    }));
  const regions = visits
    .map((visit: any) => visit.regionId && atlas.regions[visit.regionId])
    .filter(Boolean)
    .map((region: any) => ({
      name: region.name,
      type: region.type,
      province: region.province,
      city: region.city,
      district: region.district,
    }));
  const visitTexts = visits.map((visit: any) => ({
    name: visit.name,
    province: visit.province,
    city: visit.city,
    district: visit.district,
    address: visit.address,
    contextNote: visit.contextNote,
    food: visit.food,
    evidence: (visit.evidence || []).map((item: any) => item.quote),
  }));
  const searchable = {
    title: trip.title,
    subtitle: trip.subtitle,
    summary: trip.summary,
    regions: trip.regions,
    themeFoods: trip.themeFoods,
    highlights: trip.highlights,
    uncertaintyNote: trip.uncertaintyNote,
    visits: visitTexts,
    posts,
    places,
    linkedRegions: regions,
  };
  const parts: string[] = [];
  collectStrings(searchable, parts);
  return normalizeTripSearchQuery(parts.join(" "));
}
