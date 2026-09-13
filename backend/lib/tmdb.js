// Server-side TMDB helper for internal callers (source resolution, recs).
// The public passthrough proxy lives in routes/tmdb.js.
const cache = require("./cache");

const BASE = "https://api.themoviedb.org/3";

async function get(path, params = {}, ttl = 21600) {
  const qs  = new URLSearchParams({ language: "en-US", ...params });
  const key = `tmdb:${path}?${qs}`;

  const hit = cache.get(key);
  if (hit) return hit;

  const res = await fetch(`${BASE}${path}?${qs}`, {
    headers: { Authorization: `Bearer ${process.env.API_READ_ACCESS}`, accept: "application/json" },
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error(`TMDB ${path} → ${res.status}`);

  const data = await res.json();
  cache.set(key, data, ttl);
  return data;
}

// Everything a provider might need to identify a title, in one call.
async function identify(tmdbId, type = "movie") {
  if (type === "live") return { type };

  const [details, ext] = await Promise.all([
    get(`/${type}/${tmdbId}`),
    get(`/${type}/${tmdbId}/external_ids`).catch(() => ({}))
  ]);

  return {
    tmdbId: Number(tmdbId),
    imdbId: ext.imdb_id || details.imdb_id || null,
    title:  details.title || details.name || null,
    year:   (details.release_date || details.first_air_date || "").slice(0, 4) || null,
    runtime: details.runtime || null,
    type
  };
}

module.exports = { get, identify };
