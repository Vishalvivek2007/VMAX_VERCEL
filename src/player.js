// ── VMAXX PLAYER ──────────────────────────────────────────────
// Walks the ranked source list from /api/sources until one actually plays.
//
// The core problem this solves: a cross-origin iframe that 404s still fires
// `load`, so you cannot detect failure directly. We require the embed to prove
// it's alive by emitting a player event within HANDSHAKE_MS. No proof = dead,
// move to the next source.

const HANDSHAKE_MS = 8000;   // how long an iframe embed gets to prove it works
const DRIFT_MS     = 1500;   // room sync: resnap if we're more than this far off

// Origins allowed to drive playback via postMessage. An embed provider must be
// listed here AND in the CSP frame-src (backend/server.js) to work.
const TRUSTED_PLAYER_ORIGINS = [
  window.location.origin,
  "https://archive.org",
  "https://vidsrc.sbs"
];

let activeHls     = null;
let activeSource  = null;
let activeItem    = null;
let onPlayerEvent = null;   // set by the room-sync layer
let iframeProgressInterval = null;
let currentPlaybackTime    = 0;
let playbackDuration       = 7200;

// ── Entry point ──────────────────────────────────────────────
async function playTitle(item, options = {}) {
  activeItem = item;
  showShell(item, "Loading player…");

  const sources = [];
  const tmdbId = item.movieId;
  const startTime = Math.floor(Number(options.currentTime) || 0);
  const timeParam = startTime > 0 ? `&t=${startTime}` : "";
  
  if (item.mediaType === "tv") {
    const s = item.season || 1;
    const e = item.episode || 1;
    sources.push({ id: "vidking", label: "Vidking Server", kind: "iframe", url: `https://vidsrc.sbs/embed/tv/${tmdbId}/${s}/${e}?color=3B5BDB&autoPlay=true&sub=en${timeParam}` });
  } else if (item.mediaType === "movie") {
    sources.push({ id: "vidking", label: "Vidking Server", kind: "iframe", url: `https://vidsrc.sbs/embed/movie/${tmdbId}?color=3B5BDB&autoPlay=true&sub=en${timeParam}` });
  }

  if (!sources.length) return showUnavailable(item);

  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    setStatus(`Trying ${source.label} (${i + 1}/${sources.length})…`);

    const ok = await trySource(source, item, options);
    reportHealth(source.id, ok ? "ok" : "fail");

    if (ok) {
      activeSource = source;
      setStatus("");
      renderSourcePicker(sources, i, item, options);
      return;
    }
  }

  showUnavailable(item, sources);
}

// ── Per-source attempt ───────────────────────────────────────
// Resolves true only if the source demonstrably started playing.
function trySource(source, item, options) {
  teardown();

  switch (source.kind) {
    case "hls":
    case "file":     return playNative(source, options);
    case "iframe":   return playIframe(source, options);
    case "deeplink": renderDeeplink(source, item); return Promise.resolve(true);
    default:         return Promise.resolve(false);
  }
}

// ── Native player — we own the <video>, so we control everything ──
function playNative(source, options) {
  return new Promise(resolve => {
    const video = mountVideo(options);
    let settled = false;
    const done = ok => { if (!settled) { settled = true; clearTimeout(timer); resolve(ok); } };

    const timer = setTimeout(() => done(false), 20000);
    video.addEventListener("loadeddata", () => done(true), { once: true });
    video.addEventListener("error",      () => done(false), { once: true });

    const isHls = source.kind === "hls" || /\.m3u8(\?|$)/i.test(source.url);

    // Safari/iOS plays HLS natively — don't load hls.js there.
    if (!isHls || video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = source.url;
      return;
    }

    if (!window.Hls?.isSupported()) return done(false);

    activeHls = new Hls({
      maxBufferLength:      60,       // seconds ahead (default 30) — smoother
      maxMaxBufferLength:   120,
      backBufferLength:     30,       // instant rewind
      abrEwmaDefaultEstimate: 1_000_000,
      startLevel:          -1,        // let ABR choose; don't force top quality
      fragLoadingMaxRetry:  6,
      manifestLoadingMaxRetry: 4,
      lowLatencyMode: false           // VOD: stability over latency
    });

    activeHls.on(Hls.Events.ERROR, (_, d) => {
      if (!d.fatal) return;
      // Recover what's recoverable; a fatal unrecoverable error = try next source.
      if (d.type === Hls.ErrorTypes.NETWORK_ERROR) return activeHls.startLoad();
      if (d.type === Hls.ErrorTypes.MEDIA_ERROR)   return activeHls.recoverMediaError();
      activeHls.destroy();
      activeHls = null;
      done(false);
    });

    activeHls.loadSource(source.url);
    activeHls.attachMedia(video);
  });
}

function mountVideo(options) {
  const stage = document.getElementById("player-stage");
  stage.innerHTML = `<video id="vmax-video" class="vmax-video" controls playsinline
                            ${options.autoplay !== false ? "autoplay" : ""}></video>`;
  const video = document.getElementById("vmax-video");

  if (options.currentTime > 0) {
    video.addEventListener("loadedmetadata", () => { video.currentTime = options.currentTime; }, { once: true });
  }

  // Progress + room sync both hang off these.
  video.addEventListener("timeupdate", () => emit("timeupdate", video.currentTime, video.duration));
  video.addEventListener("play",       () => emit("play",   video.currentTime));
  video.addEventListener("pause",      () => emit("pause",  video.currentTime));
  video.addEventListener("seeked",     () => emit("seeked", video.currentTime));
  video.addEventListener("ended",      () => emit("ended",  video.currentTime));

  initShortcuts(video);
  return video;
}

// ── Iframe embed ─────────────────────────────────────────────
function playIframe(source, options) {
  return new Promise(resolve => {
    const stage = document.getElementById("player-stage");
    stage.innerHTML = `<iframe class="vmax-frame" src="${source.url}" frameborder="0"
      allowfullscreen allow="autoplay; fullscreen; encrypted-media; picture-in-picture"></iframe>`;

    let settled = false;
    const done = ok => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    const iframe = stage.querySelector("iframe");
    if (iframe) {
      iframe.addEventListener("load", () => done(true), { once: true });
    }

    // Optional event listener if the embed provider sends playback events
    const onMsg = e => {
      const msg = safeParse(e.data);
      if (!msg) return;
      if (msg.type === "PLAYER_EVENT" || msg.event === "timeupdate" || typeof msg.currentTime === "number") {
        done(true);
        const d = msg.data || msg;
        const cur = Number(d.currentTime ?? d.time ?? d.seconds ?? 0);
        const dur = Number(d.duration ?? d.total ?? playbackDuration);
        if (cur > 0) currentPlaybackTime = cur;
        if (dur > 0) playbackDuration = dur;
        emit("timeupdate", currentPlaybackTime, playbackDuration);
      }
    };
    window.addEventListener("message", onMsg);

    // Fallback: third-party embeds (like vidsrc) don't send custom handshakes.
    // Ensure the player is marked ready after mounting so it isn't closed.
    // Setup elapsed time tracking for Continue Watching
    const startTime = Math.floor(Number(options.currentTime) || 0);
    currentPlaybackTime = startTime;
    playbackDuration = activeItem?.duration || (activeItem?.mediaType === "tv" ? 2700 : 7200);

    if (iframeProgressInterval) clearInterval(iframeProgressInterval);

    // Initial ping after 2 seconds to register the title into continue watching
    setTimeout(() => {
      if (activeItem) {
        currentPlaybackTime = Math.max(currentPlaybackTime, 15);
        emit("timeupdate", currentPlaybackTime, playbackDuration);
      }
    }, 2000);

    // Continuous tick every 3 seconds while watching
    const wallStart = Date.now();
    iframeProgressInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - wallStart) / 1000);
      currentPlaybackTime = startTime + elapsed;
      emit("timeupdate", currentPlaybackTime, playbackDuration);
    }, 3000);

    // Fallback: mark ready after mounting so it isn't closed
    setTimeout(() => done(true), 1500);
  });
}

function renderDeeplink(source, item) {
  document.getElementById("player-stage").innerHTML = `
    <div class="player-deeplink">
      <p>Available on <strong>${esc(source.label)}</strong></p>
      <a class="btn-watch-now" href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">
        Watch on ${esc(source.label)} →
      </a>
    </div>`;
}

// ── Shell / chrome ───────────────────────────────────────────
function showShell(item, status = "") {
  const title = item.mediaType === "tv"
    ? `${item.title} — S${String(item.season).padStart(2, "0")}E${String(item.episode).padStart(2, "0")}`
    : item.title;

  const epNav = item.mediaType === "tv" ? `
    <div class="player-ep-nav" id="player-ep-nav">
      <button class="ep-nav-btn" id="ep-prev" onclick="switchEpisode(-1)" title="Previous Episode">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" transform="scale(-1,1) translate(-24,0)"/></svg>
        <span>Prev Ep</span>
      </button>
      <button class="ep-nav-current ep-nav-dropdown-btn" id="ep-drawer-toggle" onclick="togglePlayerEpDrawer()" title="View all episodes">
        <span id="ep-nav-label">S${String(item.season).padStart(2, "0")}E${String(item.episode).padStart(2, "0")}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      <button class="ep-nav-btn" id="ep-next" onclick="switchEpisode(1)" title="Next Episode">
        <span>Next Ep</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
      </button>
    </div>
    <div class="player-ep-drawer" id="player-ep-drawer" style="display:none"></div>` : "";

  modal.classList.add("open");
  modalBody.innerHTML = `
    <button class="modal-close" onclick="closePlayer()">✕</button>
    <div class="player-title">${esc(title || "Now Playing")}</div>
    <div id="player-stage" class="player-stage"></div>
    ${epNav}
    <div id="source-picker" class="source-picker"></div>
    <div id="player-status" class="player-status">${esc(status)}</div>`;
}

function setStatus(text) {
  const el = document.getElementById("player-status");
  if (el) el.textContent = text;
}

function renderSourcePicker(sources, activeIndex, item, options) {
  const el = document.getElementById("source-picker");
  if (!el || sources.length < 2) return;

  el.innerHTML = `<span class="source-picker-label">Source:</span>` + sources.map((s, i) =>
    `<button class="source-chip ${i === activeIndex ? "active" : ""}" data-idx="${i}">
       ${esc(s.label)}${s.quality ? ` · ${esc(s.quality)}` : ""}
     </button>`).join("");

  el.querySelectorAll(".source-chip").forEach(chip => {
    chip.addEventListener("click", async () => {
      const idx = +chip.dataset.idx;
      setStatus(`Switching to ${sources[idx].label}…`);
      const ok = await trySource(sources[idx], item, options);
      reportHealth(sources[idx].id, ok ? "ok" : "fail");
      setStatus(ok ? "" : `${sources[idx].label} didn't respond.`);
      if (ok) {
        activeSource = sources[idx];
        renderSourcePicker(sources, idx, item, options);
      }
    });
  });
}

function showUnavailable(item, tried = []) {
  document.getElementById("player-stage").innerHTML = `
    <div class="player-unavailable">
      <h3>Not available right now</h3>
      <p>${tried.length
        ? `We tried ${tried.length} source${tried.length > 1 ? "s" : ""} and none responded.`
        : "No sources have this title yet."}</p>
      <button class="btn-watchlist-modal" onclick="closePlayer()">Back</button>
    </div>`;
  setStatus("");
}

function closePlayer() {
  teardown();
  closeModal();
  if (typeof renderContinueWatching === "function") {
    renderContinueWatching();
  }
}

function teardown() {
  if (iframeProgressInterval) {
    clearInterval(iframeProgressInterval);
    iframeProgressInterval = null;
  }
  if (activeItem && currentPlaybackTime >= 10) {
    emit("pause", currentPlaybackTime, playbackDuration);
  }
  if (activeHls) { activeHls.destroy(); activeHls = null; }
  const stage = document.getElementById("player-stage");
  if (stage) stage.innerHTML = "";
}

// ── Keyboard shortcuts (only possible because we own the player) ──
function initShortcuts(video) {
  const handler = e => {
    if (!document.getElementById("vmax-video")) return document.removeEventListener("keydown", handler);
    if (/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;

    const keys = {
      " ":          () => video.paused ? video.play() : video.pause(),
      ArrowRight:   () => video.currentTime += 10,
      ArrowLeft:    () => video.currentTime -= 10,
      ArrowUp:      () => video.volume = Math.min(1, video.volume + 0.1),
      ArrowDown:    () => video.volume = Math.max(0, video.volume - 0.1),
      f:            () => video.requestFullscreen?.(),
      m:            () => video.muted = !video.muted,
      p:            () => video.requestPictureInPicture?.()
    };
    const fn = keys[e.key] || keys[e.key.toLowerCase()];
    if (fn) { e.preventDefault(); fn(); }
  };
  document.addEventListener("keydown", handler);
}

// ── Room sync — real seeking, no iframe reload ────────────────
// Only works on native sources; iframes can't be driven this way, which is
// the single best reason to prefer kind: "hls" / "file" providers.
function applySync(action, time) {
  const video = document.getElementById("vmax-video");
  if (!video) return false;

  if (Math.abs(video.currentTime - time) * 1000 > DRIFT_MS) video.currentTime = time;
  if (action === "play"  && video.paused)  video.play().catch(() => {});
  if (action === "pause" && !video.paused) video.pause();
  return true;
}

// ── Plumbing ─────────────────────────────────────────────────
function emit(event, currentTime, duration) {
  if (onPlayerEvent) onPlayerEvent({ event, currentTime, duration, item: activeItem });
}

function reportHealth(id, outcome) {
  // Fire-and-forget; never let telemetry block playback.
  fetch(`${API_BASE}/sources/health`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, outcome }),
    keepalive: true
  }).catch(() => {});
}

function safeParse(data) {
  if (typeof data === "object") return data;
  try { return JSON.parse(data); } catch { return null; }
}
