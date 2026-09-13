// Internet Archive — public-domain & openly-licensed feature films.
// Free, direct progressive MP4, no auth, no rate limit worth worrying about.
// Plays in OUR player, so buffer/quality are actually under our control.
//
// Reference implementation of the provider contract — see ../README.md
const cache = require("../../lib/cache");

const SEARCH   = "https://archive.org/advancedsearch.php";
const METADATA = "https://archive.org/metadata";
const DOWNLOAD = "https://archive.org/download";

// Archive.org file formats we can play natively, best first.
const PLAYABLE = ["h.264", "mpeg4", "512kb mpeg4", "ogg video"];

module.exports = {
  id:        "archive-org",
  label:     "Internet Archive",
  kind:      "file",
  weight:    70,
  countries: ["*"],
  supports:  ["movie"],
  timeout:   6000,

  async resolve({ title, year, type }) {
    if (type !== "movie" || !title) return null;

    const key = `archive:${title}:${year || ""}`;
    const hit = cache.get(key);
    if (hit !== null) return hit;          // caches misses too — most titles aren't here

    const identifier = await findIdentifier(title, year);
    if (!identifier) {
      cache.set(key, false, 86400);        // negative cache 24h
      return null;
    }

    const file = await bestFile(identifier);
    const result = file
      ? { url: `${DOWNLOAD}/${identifier}/${encodeURIComponent(file.name)}`,
          quality: file.height ? `${file.height}p` : null }
      : null;

    cache.set(key, result || false, result ? 604800 : 86400);   // 7d hit / 1d miss
    return result;
  }
};

async function findIdentifier(title, year) {
  // Quote the title so Lucene treats it as a phrase, escape embedded quotes.
  const safe  = String(title).replace(/["\\]/g, " ").trim();
  if (!safe) return null;

  const q = `title:("${safe}")${year ? ` AND year:(${year})` : ""}` +
            ` AND mediatype:(movies) AND collection:(feature_films)`;

  const url = `${SEARCH}?q=${encodeURIComponent(q)}` +
              `&fl[]=identifier&fl[]=year&rows=3&page=1&output=json`;

  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) return null;

  const docs = (await res.json())?.response?.docs || [];
  if (!docs.length) return null;

  // Prefer an exact year match when we have one to compare against.
  const exact = year && docs.find(d => String(d.year) === String(year));
  return (exact || docs[0]).identifier;
}

async function bestFile(identifier) {
  const res = await fetch(`${METADATA}/${identifier}`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) return null;

  const files = (await res.json())?.files || [];

  const candidates = files
    .filter(f => f.name && PLAYABLE.includes(String(f.format).toLowerCase()))
    .map(f => ({ ...f, height: Number(f.height) || 0, size: Number(f.size) || 0 }));

  if (!candidates.length) return null;

  // Highest resolution, then largest file (proxy for bitrate).
  candidates.sort((a, b) => (b.height - a.height) || (b.size - a.size));
  return candidates[0];
}
