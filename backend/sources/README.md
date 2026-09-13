# Source Providers

A **provider** answers one question: *"can you play this title, and at what URL?"*

Drop a `.js` file in `providers/` and it's live on the next restart. There is no
registration step, no import to add, no config to edit.

```
backend/sources/
├── registry.js          ← auto-loads providers/, resolves them in parallel
├── health.js            ← rolling success rate per provider, feeds ranking
├── providers/
│   ├── archive-org.js   ← reference impl: progressive MP4
│   ├── iptv-org.js      ← reference impl: live HLS
│   └── _disabled.js     ← leading underscore = ignored by the loader
└── README.md
```

---

## The contract

```js
module.exports = {
  // ── Required ──────────────────────────────────────────────
  id: "my-provider",              // unique, stable — health stats key off this

  async resolve(ctx) {
    // Return a Source, or null if you can't play this title.
    // Throwing is also fine — it's caught, logged, and treated as null.
    return { url: "https://…/stream.m3u8" };
  },

  // ── Optional (defaults shown) ─────────────────────────────
  kind:      "iframe",            // how the client renders it — see below
  label:     undefined,           // display name; falls back to `id`
  weight:    50,                  // base rank 0–100, higher wins
  countries: ["*"],               // ISO-2 codes, or ["*"] for everywhere
  supports:  ["movie", "tv"],     // subset of: movie | tv | anime | live
  enabled:   true,                // false = loaded but never queried
  timeout:   5000                 // ms before resolve() is abandoned
};
```

### `ctx` — what `resolve()` receives

| Field | Type | Notes |
|-------|------|-------|
| `type` | `"movie" \| "tv" \| "anime" \| "live"` | Always present |
| `tmdbId` | `number` | Absent for `live` |
| `imdbId` | `string \| null` | Resolved for you via TMDB `external_ids` |
| `title` | `string \| null` | Canonical TMDB title |
| `year` | `string \| null` | 4-digit release/first-air year |
| `runtime` | `number \| null` | Minutes |
| `season` | `number \| null` | TV only |
| `episode` | `number \| null` | TV only |
| `channelId` | `string \| null` | `live` only |
| `country` | `string` | From `cf-ipcountry`, defaults `"US"` |

Identity is resolved **once** per request and shared across all providers, so
you never pay for your own TMDB lookup.

### Return value — `Source`

```js
{
  url:     "https://…",     // required
  quality: "1080p",         // optional, shown in the picker
  label:   "Server 3",      // optional, overrides provider label
  headers: { Referer: "…" } // optional, only meaningful for kind: "hls"
}
```

Return `null` for "I don't have this." That's the common case and it's not an error.

### `kind` — how the client plays it

| kind | Client behaviour |
|------|------------------|
| `"hls"` | Native player via `hls.js`. **Full control** of buffer, ABR, subtitles, speed, room sync. |
| `"file"` | Native player, direct `<video src>`. Progressive MP4/WebM. Same control. |
| `"iframe"` | Third-party embed. Detected alive via postMessage handshake, 8s timeout. **No control** over quality or sync. |
| `"deeplink"` | Not played — rendered as "Watch on X", opens externally. |

**Prefer `hls`/`file` wherever you can.** An iframe means you don't own the
`<video>` element, which means buffer tuning, subtitle tracks, dub/sub
switching, skip-intro, and frame-accurate watch-party sync are all impossible.
That's the difference between "it plays" and "it plays well."

---

## Ranking

Effective rank is `weight + health.score(id)`, computed at serve time.

`health.score()` returns roughly `-40 … +20` from the provider's rolling 24h
success rate, reported by the client after every playback attempt. Providers
with fewer than 5 attempts score `0` — neutral, so new providers get a fair
trial rather than being buried.

**You do not need to hand-tune weights over time.** A provider that starts
failing sinks on its own within a few dozen attempts. Set `weight` once to
express *preference* (own-player over iframe, higher quality over lower) and
let health handle *reliability*.

Watch it work:

```bash
curl localhost:3000/api/sources/health | jq
```

---

## Worked example

```js
// providers/example.js
const cache = require("../../lib/cache");

module.exports = {
  id:       "example",
  label:    "Example",
  kind:     "hls",
  weight:   60,
  supports: ["movie", "tv"],

  async resolve({ tmdbId, imdbId, type, season, episode }) {
    if (!imdbId) return null;                    // this one needs an IMDb id

    const key = `example:${imdbId}:${season || 0}:${episode || 0}`;
    const hit = cache.get(key);
    if (hit !== null) return hit || null;        // false = cached miss

    const res = await fetch(`https://api.example.com/lookup/${imdbId}`, {
      signal: AbortSignal.timeout(4000)
    });
    if (!res.ok) return null;

    const data = await res.json();
    const result = data.stream ? { url: data.stream, quality: data.quality } : null;

    cache.set(key, result || false, result ? 3600 : 86400);   // negative-cache misses
    return result;
  }
};
```

---

## Rules of thumb

1. **Always set a `signal: AbortSignal.timeout(…)`** on outbound fetches. The
   registry timeout protects the response, but a leaked socket still costs you.
2. **Negative-cache misses.** Most titles won't exist on most providers. Cache
   the `null` (as `false`, since the cache treats `null` as absent) for ~24h or
   you'll re-query on every page view.
3. **Never throw for "not found."** Return `null`. Reserve throwing for genuine
   upstream failures you want to see in the logs.
4. **One provider can never break another.** `resolveAll` uses `Promise.allSettled`
   with per-provider timeouts. A provider that hangs, throws, or returns garbage
   is dropped silently and the rest still serve.
5. **`id` is a stable key.** Renaming it resets that provider's health history.

## Testing a provider

```bash
node -e "require('./backend/sources/providers/archive-org')
  .resolve({ type:'movie', title:'Night of the Living Dead', year:'1968' })
  .then(console.log)"
```

Then end-to-end:

```bash
curl 'localhost:3000/api/sources?tmdbId=10331&type=movie' | jq
```
