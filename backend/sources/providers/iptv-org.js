// iptv-org — 50k+ publicly-accessible live channels (news, sport, entertainment).
// Inclusion criteria are strict: publicly accessible, non-geoblocked, no auth,
// from an authorized source. Direct HLS, so it plays in our own player.
//
// Live channels aren't TMDB-keyed — they resolve by channelId, which the
// /api/live browse endpoint supplies. See ../README.md
const cache = require("../../lib/cache");

const API = "https://iptv-org.github.io/api";

module.exports = {
  id:        "iptv-org",
  label:     "Live TV",
  kind:      "hls",
  weight:    80,
  countries: ["*"],
  supports:  ["live"],
  timeout:   6000,

  async resolve({ type, channelId }) {
    if (type !== "live" || !channelId) return null;

    const streams = await loadStreams();
    const matches = streams.filter(s => s.channel === channelId && s.url);
    if (!matches.length) return null;

    // Prefer the highest advertised quality.
    matches.sort((a, b) => (parseInt(b.quality) || 0) - (parseInt(a.quality) || 0));
    return { url: matches[0].url, quality: matches[0].quality || null };
  },

  // Extra export (not part of the contract) — used by /api/live to browse.
  loadChannels
};

// Both files are a few MB; fetch once and hold for 6h.
async function loadStreams()  { return loadJSON("streams");  }
async function loadChannels() { return loadJSON("channels"); }

async function loadJSON(name) {
  const key = `iptv:${name}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const res = await fetch(`${API}/${name}.json`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`iptv-org ${name}.json → ${res.status}`);

  const data = await res.json();
  cache.set(key, data, 21600);   // 6h
  return data;
}
