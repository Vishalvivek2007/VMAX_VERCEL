const express  = require("express");
const registry = require("../sources/registry");
const health   = require("../sources/health");
const tmdb     = require("../lib/tmdb");
const cache    = require("../lib/cache");

const router = express.Router();

// GET /api/sources?tmdbId=550&type=movie[&season=1&episode=2]
// GET /api/sources?type=live&channelId=BBCNews.uk
//
// Returns ranked, verified-resolvable sources. The client walks this list
// top-down until one actually plays. It never guesses a URL itself.
router.get("/", async (req, res) => {
  const { tmdbId, type = "movie", season, episode, channelId } = req.query;

  if (type === "live" ? !channelId : !tmdbId) {
    return res.status(400).json({ error: type === "live" ? "channelId required" : "tmdbId required" });
  }

  const key = `sources:${type}:${tmdbId || channelId}:${season || 0}:${episode || 0}`;
  const hit = cache.get(key);
  if (hit) return res.json({ sources: rank(hit), cached: true });

  try {
    // Providers need more than a TMDB id — title/year/imdb for matching.
    const identity = tmdbId ? await tmdb.identify(tmdbId, type) : { type };

    const ctx = {
      ...identity,
      type,
      channelId,
      season:  season  ? Number(season)  : null,
      episode: episode ? Number(episode) : null,
      country: req.headers["cf-ipcountry"] || req.query.country || "US"
    };

    const sources = await registry.resolveAll(ctx);
    cache.set(key, sources, 3600);   // 1h — sources churn

    res.json({ sources: rank(sources), cached: false });
  } catch (err) {
    console.error("source resolution failed:", err.message);
    res.status(502).json({ error: "Could not resolve sources", sources: [] });
  }
});

// Rank at serve time, not cache time, so health updates take effect immediately.
function rank(sources) {
  return [...sources].sort((a, b) =>
    (b.weight + health.score(b.id)) - (a.weight + health.score(a.id)));
}

// POST /api/sources/health  { id, outcome: "ok" | "fail" }
// The client calls this after every playback attempt. This is what makes
// the ranking self-correcting.
router.post("/health", express.json(), (req, res) => {
  const { id, outcome } = req.body || {};
  if (!id || !["ok", "fail"].includes(outcome)) {
    return res.status(400).json({ error: "id and outcome (ok|fail) required" });
  }
  health.report(id, outcome);
  res.json({ ok: true });
});

// GET /api/sources/health — provider scoreboard. Useful while developing.
router.get("/health", (req, res) => {
  res.json({
    providers: registry.SOURCES.map(s => ({
      id: s.id, kind: s.kind, weight: s.weight, supports: s.supports, enabled: s.enabled
    })),
    stats: health.snapshot()
  });
});

module.exports = router;
