# VMAX — What you actually built (resume reference)

Full-stack streaming/watch-party web app. Node.js/Express + MongoDB backend,
vanilla JS frontend, Socket.IO for real-time sync, deployed on Render.

## Stack
- **Backend:** Node.js, Express 4, MongoDB/Mongoose, Socket.IO, JWT (jsonwebtoken),
  bcryptjs, Helmet (CSP), express-rate-limit, dotenv
- **Frontend:** Vanilla JS (no framework), hls.js (vendored, self-hosted for CSP),
  custom CSS
- **Infra:** Render (web service), env-based config, PM2 ecosystem file for process mgmt

## Architecture you built

### 1. Pluggable video-source registry (`backend/sources/`)
Replaced a single hardcoded video provider with a **provider-plugin system**:
- `registry.js` — auto-loads any `.js` file dropped into `sources/providers/`
  at boot (no manual registration), resolves all eligible providers **in
  parallel** via `Promise.allSettled` with a per-provider timeout so one slow
  provider can't stall the response.
- Each provider exports a `resolve(ctx)` function returning a playable URL or
  `null`; providers are ranked by a base `weight` plus a live health score.
- `health.js` — rolling 24h success/fail tracking per provider; failing
  providers get demoted in ranking automatically (self-healing, no manual
  intervention).
- Shipped two real providers: Internet Archive (public-domain films,
  progressive MP4) and iptv-org (50k+ legal live HLS channels).
- `GET /api/sources` — returns a ranked, verified list of playable sources for
  a given TMDB id, cached (TTL cache you wrote yourself, `lib/cache.js`, zero
  dependencies).

**Resume line:** *"Designed and implemented a pluggable video-source provider
architecture (registry + health-scored ranking + parallel resolution with
timeouts) to replace a single hardcoded embed provider, enabling automatic
failover across multiple content sources."*

### 2. Custom HLS video player (`frontend/src/player.js`, 303 lines)
- Iframe-embed player replaced with a **native `<video>` + hls.js** player you
  control directly (buffer tuning, ABR config, error recovery).
- **Fallback chain with failure detection:** since a broken cross-origin
  iframe never fires a usable error event, you built a **handshake-timeout
  protocol** — an embed must prove it's alive within N seconds via
  `postMessage`, or the player automatically advances to the next source in
  the ranked list ("Trying source 2 of 4…" UX).
- Origin-validated `postMessage` handling (`TRUSTED_PLAYER_ORIGINS`
  allowlist) to stop other iframes from forging playback events.
- hls.js error handling: network errors trigger `hls.startLoad()` retry,
  media errors trigger `hls.recoverMediaError()`, fatal errors mark the
  source failed and cascade to the next provider.

**Resume line:** *"Built a custom HLS.js-based video player with automatic
multi-source failover, using a postMessage handshake protocol to detect
silent iframe playback failures that the browser cannot otherwise report."*

### 3. Real-time watch-party rooms (Socket.IO)
- Synchronized playback (play/pause/seek) across multiple clients in a room.
- Room chat with server-side XSS sanitization (`textContent`-based DOM
  construction, not `innerHTML`; 500-char server-side cap).
- **Socket authentication:** `io.use()` middleware verifies JWT before
  allowing a socket to join; usernames are **server-assigned from the
  verified token**, never trusted from client payload (closes an
  impersonation/hijack hole).
- Handlers keyed off `socket.roomCode` (server-tracked) rather than a
  client-supplied `roomCode` field, preventing cross-room message injection.

**Resume line:** *"Implemented real-time synchronized watch parties with
Socket.IO, including JWT-authenticated socket connections and server-side
sanitization to close a stored-XSS and session-hijack vector."*

### 4. Auth & security hardening
- JWT auth (`bcryptjs` password hashing, `jsonwebtoken`), with the app
  refusing to boot in production if `JWT_SECRET` is unset (removed a silent
  hardcoded-fallback-secret vulnerability).
- `express-rate-limit` on auth routes (login/register throttled per IP) to
  stop credential stuffing.
- Moved a previously **client-side, git-history-leaked TMDB API bearer
  token** into a server-side proxy (`backend/routes/tmdb.js`) with an
  **allowlist of permitted TMDB endpoints** and per-endpoint cache TTLs —
  fixes both the credential leak and cuts homepage load from ~8 parallel
  cross-origin API calls to 1.
- `helmet` with an explicit CSP `frame-src` allowlist; CORS restricted to a
  configured origin list instead of `*` on both HTTP and WebSocket.
- Username validation regex at registration to block markup injection via
  display name.

**Resume line:** *"Performed a security audit of an existing codebase and
remediated a live stored-XSS vulnerability, a leaked API credential, missing
rate limiting on auth endpoints, and an open CORS/WebSocket policy."*

### 5. Data model / persistence
- `WatchHistory` model — replaced an unbounded array embedded in the `User`
  document (a MongoDB anti-pattern that risks the 16MB document cap and
  rewrites the whole user doc on every write) with a separate, properly
  indexed collection (compound index on user+title+season+episode, plus a
  descending `updatedAt` index for an efficient "Continue Watching" query).
- `POST /api/history` — progress upsert wired to the player's `postMessage`
  events, which were previously received and discarded entirely.

**Resume line:** *"Redesigned the watch-progress data model from an unbounded
embedded array to a normalized, indexed MongoDB collection to support a
Continue Watching feature and avoid document-size/write-amplification
issues."*

### 6. TMDB metadata integration
- Server-side proxy/cache layer (`backend/lib/tmdb.js`) for The Movie
  Database API — trending, popular, search, genre discovery, series data.
- Frontend renders horizontally-scrolling category rows, a hero banner, modal
  detail views, and search — all driven by proxied/cached TMDB responses.

## Rough scale
~2,200 lines of hand-written JS across backend (registry, routes, models,
providers) and frontend (player, main app script), plus a self-authored
technical audit/roadmap document (`ROADMAP.md`) covering the full defect
list, architecture rationale, and remaining roadmap — useful if you want to
talk through "how did you find these bugs and prioritize the fixes" in an
interview.

## How to talk about it in an interview
The strongest story here isn't "I added hls.js" — it's the **diagnosis**:
tracing "half the movies don't play" down to five compounding root causes
(no fallback, no failure detection, no origin validation, discarded progress
data, single provider), then fixing the actual architectural gap (a
registry + health-ranked fallback chain) instead of patching the symptom.
That, plus the security remediation (XSS, leaked token, auth rate limiting,
socket hijacking) is the meatiest, most interview-defensible material.
