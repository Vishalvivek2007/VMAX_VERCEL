const express = require("express");
const cache   = require("../lib/cache");

const router = express.Router();
const TMDB_BASE  = "https://api.themoviedb.org/3";
const TMDB_TOKEN = process.env.API_READ_ACCESS;

// Allowlist so this can't be used as an open TMDB proxy by anyone else.
// Add patterns here as the frontend needs new endpoints.
const ALLOWED = [
  /^\/(trending)\/(movie|tv|all)\/(day|week)$/,
  /^\/(movie|tv)\/(popular|top_rated|now_playing|airing_today|on_the_air)$/,
  /^\/discover\/(movie|tv)$/,
  /^\/search\/(movie|tv|multi)$/,
  /^\/(movie|tv)\/\d+$/,
  /^\/(movie|tv)\/\d+\/(videos|credits|recommendations|similar|images|keywords|external_ids)$/,
  /^\/tv\/\d+\/season\/\d+$/,
  /^\/genre\/(movie|tv)\/list$/
];

// Cache TTLs by endpoint shape. TMDB ToS forbids caching beyond 6 months;
// these are all far below that.
function ttlFor(path) {
  if (/^\/trending\//.test(path))                 return 3600;    // 1h
  if (/^\/search\//.test(path))                   return 600;     // 10m
  if (/(popular|now_playing|airing_today)/.test(path)) return 1800; // 30m
  return 21600;                                                   // 6h — details rarely change
}

router.get("/*", async (req, res) => {
  const path = req.params[0] ? `/${req.params[0]}` : "/";

  if (!ALLOWED.some(rx => rx.test(path))) {
    return res.status(403).json({ error: "Endpoint not allowed" });
  }
  if (!TMDB_TOKEN) {
    return res.status(500).json({ error: "TMDB token not configured on server" });
  }

  const qs  = new URLSearchParams(req.query);
  if (!qs.has("language")) qs.set("language", "en-US");
  const key = `tmdb:${path}?${qs}`;

  const hit = cache.get(key);
  if (hit) {
    res.set("X-Cache", "HIT");
    return res.json(hit);
  }

  try {
    const upstream = await fetch(`${TMDB_BASE}${path}?${qs}`, {
      headers: { Authorization: `Bearer ${TMDB_TOKEN}`, accept: "application/json" },
      signal: AbortSignal.timeout(8000)
    });

    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: `TMDB ${upstream.status}` });
    }

    const data = await upstream.json();
    cache.set(key, data, ttlFor(path));
    res.set("X-Cache", "MISS");
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: "TMDB unreachable" });
  }
});

module.exports = router;
