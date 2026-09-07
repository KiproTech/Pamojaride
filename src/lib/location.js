// ============================================================================
// Location validation + route/travel-time estimation service.
//
// The project had no geocoding/mapping integration before this file, so this
// introduces one from scratch using free, no-API-key services suited to a
// Kenya-focused app with no existing Maps billing account:
//
//   - Geocoding / place search: OpenStreetMap Nominatim (restricted to
//     Kenya via `countrycodes=ke`). This is what turns a driver's typed
//     text into a real, recognizable place with coordinates — a trip can
//     only be created from a location the driver actually picked from
//     these results, never from raw freeform text.
//   - Route distance/duration: the public OSRM demo routing server
//     (router.project-osrm.org), which returns real driving distance and
//     duration between two coordinates.
//
// Both are best-effort public demo services with no uptime guarantee and
// modest rate limits, so every call here is wrapped so failures surface as
// a single friendly LocationServiceError instead of a raw network/HTTP
// error. If OSRM is unreachable, getRoute() falls back to a straight-line
// (haversine) distance estimate with a conservative average speed, clearly
// flagged via `source: 'estimated'` so calling code can label it as
// approximate rather than presenting it as an exact route.
//
// ----------------------------------------------------------------------------
// SMALL-PLACE RECOGNITION FIX (this revision)
// ----------------------------------------------------------------------------
// Nominatim itself already indexes small towns, trading centres, villages,
// estates/neighbourhoods and sub-locations in Kenya — the earlier version of
// this file wasn't rejecting them by policy, but several implementation
// details made small places show up rarely or not at all in practice:
//
//   1. `limit: 6` was too small. When a query prefix matches both a
//      well-known place and several minor ones (e.g. "mumi" -> Mumias town
//      + several smaller Mumias-area localities), the smaller matches could
//      get pushed out of a 6-result page. Raised to 8.
//   2. A 3-character minimum blocked short-but-valid searches. Lowered to 2
//      (Nominatim itself handles short queries fine; 1 character is still
//      rejected as too noisy).
//   3. No retry when a query returned zero results. Drivers commonly type a
//      trailing generic word ("Malava town", "Butere market", "Kondele
//      estate") that isn't part of the indexed name — the exact-string
//      match failed, but the place exists. We now retry once with that
//      generic suffix stripped.
//   4. Label building just truncated Nominatim's raw comma-separated
//      `display_name`, which for small places is inconsistent (sometimes
//      repeats the name, sometimes omits the county). Replaced with a
//      structured builder that reads `address` fields directly and always
//      produces a "Place, County, Country"-shaped label — the format the
//      spec asks for, and the thing that lets a driver tell two
//      similarly-named small places apart.
//   5. THE MOST IMPACTFUL BUG: two LocationAutocomplete fields (pickup +
//      destination) on the same form can each fire a debounced search at
//      nearly the same time. Nominatim's public instance enforces a strict
//      ~1 request/second usage policy and will start returning HTTP 403/429
//      once that's exceeded. The old code had no shared throttling, so
//      typing in both fields in quick succession could trigger a rate-limit
//      error — which then surfaced as "location search unavailable" on
//      *whatever* place was being typed, major or minor, making it look
//      like an arbitrary subset of places (often the less common ones,
//      since drivers naturally double back and retype those) "didn't
//      exist". A shared request queue now serializes all Nominatim calls
//      app-wide with a minimum spacing, so this can no longer happen.
//   6. Results are now de-duplicated (Nominatim sometimes returns the same
//      settlement as more than one OSM object) and re-sorted so
//      exact-prefix matches (what a driver just typed) always come first,
//      instead of relying purely on Nominatim's generic "importance" score
//      which favours large places.
//   7. Successful and empty lookups are cached briefly in memory, so
//      re-typing over an already-searched prefix (e.g. backspacing then
//      retyping) doesn't re-hit the network or the rate limiter.
// ============================================================================

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const OSRM_URL = 'https://router.project-osrm.org/route/v1/driving';

// Kenya's approximate bounding box, used to bias/restrict search results.
const KENYA_VIEWBOX = '33.9,5.5,41.9,-4.8'; // left,top,right,bottom

// A driver only needs to type 2 characters before we search — Nominatim
// copes fine with short queries, and this is what makes short real names
// (e.g. "Oy", "Ol") reachable instead of forcing 3+ characters.
const MIN_QUERY_LENGTH = 2;

// Wider than before (was 6) so that minor/small-place matches aren't pushed
// off the page by a handful of larger, higher-"importance" places sharing
// the same prefix.
const RESULT_LIMIT = 8;

// Nominatim's public usage policy caps this at ~1 request/second, shared
// across the *whole app* (not per field) — see fix #5 above.
const MIN_REQUEST_SPACING_MS = 1100;

// Generic words drivers commonly append that aren't actually part of a
// place's indexed name. Stripped and retried only if the first search
// (with the full text) came back empty — never used to filter/replace the
// driver's original selection, only to widen the search.
const FILLER_SUFFIXES = [
  ' trading centre', ' trading center', ' town centre', ' town center',
  ' centre', ' center', ' market', ' estate', ' village', ' town', ' area', ' stage',
];

// Human-friendly labels for Nominatim's place `type`, shown as a small
// context tag in the UI so a driver can tell a village apart from a county
// or a neighbourhood at a glance.
const TYPE_LABELS = {
  city: 'City', town: 'Town', municipality: 'Town', village: 'Village',
  hamlet: 'Locality', locality: 'Locality', isolated_dwelling: 'Locality',
  suburb: 'Estate/Neighbourhood', neighbourhood: 'Estate/Neighbourhood',
  quarter: 'Estate/Neighbourhood', city_district: 'Estate/Neighbourhood',
  county: 'County', state: 'County', state_district: 'Sub-county',
  administrative: 'Area', borough: 'Area',
};

export class LocationServiceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LocationServiceError';
  }
}

/** Human-readable label for a Nominatim `type`, or null if unrecognized. */
export function describeLocationType(type) {
  return TYPE_LABELS[type] || null;
}

// ----------------------------------------------------------------------------
// Shared request queue: serializes every Nominatim call app-wide so that
// two autocomplete fields searching at the same time can never together
// exceed the public instance's rate limit (fix #5 above).
// ----------------------------------------------------------------------------
let requestChain = Promise.resolve();
let lastRequestAt = 0;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function enqueueRequest(fn) {
  const scheduled = requestChain.then(async () => {
    const wait = MIN_REQUEST_SPACING_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    return fn();
  });
  // Keep the chain alive even if this particular call fails, so later
  // searches aren't permanently blocked by one earlier error.
  requestChain = scheduled.catch(() => {});
  return scheduled;
}

// ----------------------------------------------------------------------------
// Short-lived in-memory cache, keyed by normalized query text.
// ----------------------------------------------------------------------------
const CACHE_TTL_MS = 5 * 60 * 1000;
const searchCache = new Map(); // key -> { at, results }

function getCached(key) {
  const entry = searchCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    searchCache.delete(key);
    return null;
  }
  return entry.results;
}

function setCached(key, results) {
  searchCache.set(key, { at: Date.now(), results });
  // Simple bound so this can't grow unbounded in a very long session.
  if (searchCache.size > 200) {
    const oldestKey = searchCache.keys().next().value;
    searchCache.delete(oldestKey);
  }
}

function normalizeQuery(query) {
  return (query || '').trim().replace(/\s+/g, ' ');
}

function stripFillerSuffix(query) {
  const lower = query.toLowerCase();
  for (const suffix of FILLER_SUFFIXES) {
    if (lower.endsWith(suffix) && lower.length > suffix.length) {
      return query.slice(0, query.length - suffix.length).trim();
    }
  }
  return null;
}

/**
 * Build a "Place, County, Country"-style label directly from Nominatim's
 * structured `address` fields, rather than truncating the raw
 * `display_name` string (which is inconsistent for small places — see fix
 * #4 above). Falls back gracefully when a field is missing, and never
 * repeats the same name twice.
 */
function buildLocationLabel(result) {
  const addr = result.address || {};

  // `result.name` is the name of the *actual matched entity* (whatever
  // granularity it is — village, suburb, hamlet, town, county…). Prefer it
  // over guessing from the address ladder: the address ladder mixes in the
  // parent town/city too, and picking from it first (as an earlier version
  // of this function did) could silently promote a matched suburb/hamlet's
  // *parent town* to be the displayed name instead of the place itself
  // (e.g. searching a specific suburb could wrongly show the city it's
  // in). Only fall back to the address ladder for the rare case Nominatim
  // returns a result with no top-level name (plain address matches).
  const name =
    result.name ||
    addr.village || addr.hamlet || addr.town || addr.city ||
    addr.municipality || addr.suburb || addr.neighbourhood ||
    addr.city_district || addr.county || addr.town_district ||
    (result.display_name || '').split(',')[0].trim() ||
    'Unnamed location';

  // A more local parent (the town/city a matched village/suburb/hamlet
  // sits in), when it's not simply the same as the place itself. This is
  // what turns "Shirere" into "Shirere, Malava, Kakamega County, Kenya"
  // instead of losing that useful intermediate context.
  const localParent = [addr.town, addr.city_district, addr.city, addr.municipality]
    .find(v => v && v !== name);

  // Kenyan OSM data tags counties inconsistently as `county`, `state`, or
  // (for sub-county/constituency level detail) `state_district` — try them
  // in order of usefulness and just take the first one that isn't simply
  // repeating the place name or the local-parent segment above.
  const regionCandidate = [addr.county, addr.state_district, addr.state, addr.region]
    .find(v => v && v !== name && v !== localParent);

  const country = addr.country || 'Kenya';

  const contextParts = [];
  if (localParent) contextParts.push(localParent);
  if (regionCandidate) contextParts.push(regionCandidate);
  contextParts.push(country);
  const contextLabel = contextParts.join(', ');

  return {
    name,
    contextLabel,
    fullLabel: `${name}, ${contextLabel}`,
  };
}

function toCandidate(result) {
  const { name, contextLabel, fullLabel } = buildLocationLabel(result);
  return {
    id: `${result.osm_type}:${result.osm_id}`,
    label: name,
    contextLabel,
    fullLabel,
    type: result.type || result.class || null,
    typeLabel: describeLocationType(result.type) || describeLocationType(result.class),
    lat: parseFloat(result.lat),
    lon: parseFloat(result.lon),
  };
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    if (!Number.isFinite(c.lat) || !Number.isFinite(c.lon)) continue;
    const key = `${c.label.toLowerCase()}|${c.lat.toFixed(3)}|${c.lon.toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

// Bubble exact-prefix matches (what the driver actually typed) to the top.
// Array#sort is a stable sort in modern JS engines, so this only reorders
// the prefix/non-prefix groups and otherwise preserves Nominatim's own
// relevance ordering within each group.
function sortByRelevance(candidates, query) {
  const q = query.toLowerCase();
  return [...candidates].sort((a, b) => {
    const aStarts = a.label.toLowerCase().startsWith(q) ? 0 : 1;
    const bStarts = b.label.toLowerCase().startsWith(q) ? 0 : 1;
    return aStarts - bStarts;
  });
}

async function fetchNominatim(query, signal) {
  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    addressdetails: '1',
    countrycodes: 'ke',
    viewbox: KENYA_VIEWBOX,
    bounded: '0', // bias toward Kenya but don't hide results just outside the box (border towns)
    'accept-language': 'en',
    limit: String(RESULT_LIMIT),
  });

  let response;
  try {
    response = await enqueueRequest(() => fetch(`${NOMINATIM_URL}?${params.toString()}`, {
      headers: { Accept: 'application/json' },
      signal,
    }));
  } catch (err) {
    if (err.name === 'AbortError') throw err; // caller cancelled a stale search; not a real failure
    throw new LocationServiceError('Could not reach the location search service. Check your connection and try again.');
  }

  if (response.status === 429 || response.status === 403) {
    throw new LocationServiceError('Location search is receiving too many requests right now. Please wait a moment and try again.');
  }
  if (!response.ok) {
    throw new LocationServiceError('Location search is temporarily unavailable. Please try again in a moment.');
  }

  let results;
  try {
    results = await response.json();
  } catch {
    throw new LocationServiceError('Location search returned an unexpected response. Please try again.');
  }

  return Array.isArray(results) ? results : [];
}

/**
 * Search for recognizable places in Kenya matching the given text —
 * major cities, small towns, trading centres, villages/localities,
 * estates/neighbourhoods, and counties/sub-counties, as indexed by
 * OpenStreetMap. Returns an array of
 * { id, label, contextLabel, fullLabel, type, typeLabel, lat, lon }
 * candidates, most relevant first. Returns an empty array (never throws)
 * if nothing matches — callers should treat an empty result as "location
 * not found" and show that inline, since a failed *lookup* and a *no-op
 * search* look the same to the user.
 */
export async function searchLocations(query, { signal } = {}) {
  const trimmed = normalizeQuery(query);
  if (trimmed.length < MIN_QUERY_LENGTH) return [];

  const cacheKey = trimmed.toLowerCase();
  const cached = getCached(cacheKey);
  if (cached) return cached;

  let raw = await fetchNominatim(trimmed, signal);

  // Retry once with a common trailing filler word stripped (fix #3 above)
  // if the exact text the driver typed didn't match anything.
  if (raw.length === 0) {
    const relaxed = stripFillerSuffix(trimmed);
    if (relaxed && relaxed.length >= MIN_QUERY_LENGTH) {
      raw = await fetchNominatim(relaxed, signal);
    }
  }

  const candidates = sortByRelevance(
    dedupeCandidates(raw.map(toCandidate)),
    trimmed,
  ).slice(0, RESULT_LIMIT);

  setCached(cacheKey, candidates);
  return candidates;
}

/**
 * Straight-line distance in km between two coordinates (haversine).
 */
function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Two picked places are "the same location" if they resolved to the exact
 * same place, or to two points implausibly close together (under 300m —
 * tight enough that two distinct pickup points within the same small town
 * or trading centre are no longer wrongly flagged as identical, which was
 * a real risk at the old 1km threshold once small, closely-packed
 * localities became reachable).
 */
export function isSameLocation(a, b) {
  if (!a || !b) return false;
  if (a.id && b.id && a.id === b.id) return true;
  return haversineKm(a, b) < 0.3;
}

/**
 * Estimate route distance/duration between two picked places.
 * Returns { distanceKm, durationMinutes, source: 'osrm' | 'estimated' }.
 * Never throws for a routable-but-slow-service case — falls back to an
 * estimate instead so a flaky demo server doesn't block trip creation.
 * This also transparently covers small/rural locations that OSRM's demo
 * server can't route precisely (e.g. very minor tracks not in its road
 * graph): the straight-line fallback below applies exactly the same way
 * regardless of how small or well-known either location is, so a driver
 * is never blocked or shown a raw API error just because they picked a
 * small town or village.
 * Throws LocationServiceError only if even the fallback can't produce a
 * sane result (e.g. missing coordinates).
 */
export async function getRoute(origin, destination) {
  if (!origin || !destination || !Number.isFinite(origin.lat) || !Number.isFinite(destination.lat)) {
    throw new LocationServiceError('Missing location coordinates — please re-select pickup and destination.');
  }

  try {
    const url = `${OSRM_URL}/${origin.lon},${origin.lat};${destination.lon},${destination.lat}?overview=false&alternatives=false&steps=false`;
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('osrm-http-error');

    const data = await response.json();
    const route = data?.routes?.[0];
    if (data?.code !== 'Ok' || !route) throw new Error('osrm-no-route');

    return {
      distanceKm: Math.round((route.distance / 1000) * 10) / 10,
      durationMinutes: Math.max(1, Math.round(route.duration / 60)),
      source: 'osrm',
    };
  } catch {
    // Fallback: straight-line distance with a generous road-distance
    // multiplier and a conservative average speed, clearly flagged so the
    // UI can tell the driver this is an approximation.
    const straightKm = haversineKm(origin, destination);
    const roadKm = straightKm * 1.3; // roads are rarely a straight line
    const AVERAGE_SPEED_KMH = 55;
    return {
      distanceKm: Math.round(roadKm * 10) / 10,
      durationMinutes: Math.max(1, Math.round((roadKm / AVERAGE_SPEED_KMH) * 60)),
      source: 'estimated',
    };
  }
}

/**
 * Given a departure Date and a duration in minutes, return the estimated
 * arrival Date.
 */
export function estimateArrival(departureDate, durationMinutes) {
  return new Date(departureDate.getTime() + durationMinutes * 60000);
}

/**
 * Human-friendly "Xh Ym" formatting for a duration in minutes.
 */
export function formatDuration(durationMinutes) {
  const h = Math.floor(durationMinutes / 60);
  const m = Math.round(durationMinutes % 60);
  if (h <= 0) return `${m} min`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}min`;
}
