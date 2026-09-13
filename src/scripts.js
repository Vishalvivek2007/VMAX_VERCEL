// ── CONFIG ───────────────────────────────────────────────────
const TOKEN_KEY   = "vmax_token";
const USER_KEY    = "vmax_user";
const APP_ORIGIN  = window.location.origin;
const API_BASE    = `${APP_ORIGIN}/api`;
const TMDB_BASE   = "https://api.themoviedb.org/3";
const TMDB_KEY    = "d21a71154cf569509f6f03739e4a33da"; // Embedded for static hosting
const IMG_BASE    = "https://image.tmdb.org/t/p/w500";
const IMG_ORIG    = "https://image.tmdb.org/t/p/original";
const ACCENT      = "3B5BDB";
const PLACEHOLDER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='175' height='263'%3E%3Crect width='175' height='263' fill='%2313131a'/%3E%3Ctext x='50%25' y='50%25' fill='%23555' font-family='sans-serif' font-size='13' text-anchor='middle'%3ENo Image%3C/text%3E%3C/svg%3E";

// ── STATE ────────────────────────────────────────────────────
let currentUser      = JSON.parse(localStorage.getItem(USER_KEY) || "null");
let authToken        = localStorage.getItem(TOKEN_KEY) || null;
let userWatchlist    = [];
let currentSection   = "home";
let currentPlayer    = null;
let searchTimeout    = null;
let seriesLoaded     = false;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── TMDB FETCH (direct) ───────────────────────────────
async function tmdb(endpoint, params = "") {
  try {
    const res = await fetch(`${TMDB_BASE}${endpoint}?api_key=${TMDB_KEY}&language=en-US&${params}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.results ?? data;
  } catch {
    return [];
  }
}

// ── API FETCH (backend) ──────────────────────────────────────
async function api(method, path, body = null) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json" }
  };
  if (authToken) opts.headers["Authorization"] = `Bearer ${authToken}`;
  if (body) opts.body = JSON.stringify(body);

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`${API_BASE}${path}`, opts);
      const data = await res.json().catch(() => ({}));

      if (res.ok) return data;
      if (![502, 503, 504].includes(res.status) || attempt === 3) {
        return data.error ? data : { error: data.message || `Request failed (${res.status})` };
      }
    } catch (err) {
      if (attempt === 3) {
        return { error: "Server is waking up. Please try again in a few seconds." };
      }
    }

    await sleep(900 * (attempt + 1));
  }

  return { error: "Server is waking up. Please try again in a few seconds." };
}

// ── INIT ─────────────────────────────────────────────────────
async function init() {
  updateNavAvatar();
  initSearch();
  initNavLinks();
  initDelegatedHandlers();
  if (authToken) await loadWatchlist();   // so hearts render correctly on first paint

  const [trending, popular, nowPlaying, action, scifi, comedy, topRated, horror] =
    await Promise.all([
      tmdb("/trending/movie/day"),
      tmdb("/movie/popular"),
      tmdb("/movie/now_playing"),
      tmdb("/discover/movie", "with_genres=28"),
      tmdb("/discover/movie", "with_genres=878"),
      tmdb("/discover/movie", "with_genres=35"),
      tmdb("/movie/top_rated"),
      tmdb("/discover/movie", "with_genres=27"),
    ]);

  buildHero(trending?.[0], "movie");
  renderContinueWatching();
  renderRow("trending-row",  trending,  "movie");
  renderTop10("top10-row",   Array.isArray(popular) ? popular.slice(0, 10) : []);
  renderRow("new-row",       nowPlaying,"movie", "NEW");
  renderRow("action-row",    action,    "movie");
  renderRow("scifi-row",     scifi,     "movie");
  renderRow("comedy-row",    comedy,    "movie");
  renderRow("toprated-row",  topRated,  "movie");
  renderRow("horror-row",    horror,    "movie");
}

// ── NAV LINKS ────────────────────────────────────────────────
function initNavLinks() {
  document.querySelectorAll(".nav-links a").forEach(a => {
    a.addEventListener("click", e => {
      e.preventDefault();
      const section = a.dataset.section;
      switchSection(section);
    });
  });

  document.getElementById("nav-avatar").addEventListener("click", () => {
    if (currentUser) showUserMenu();
    else openAuthModal();
  });
}

function switchSection(section) {
  currentSection = section;
  document.querySelectorAll(".nav-links a").forEach(a => {
    a.classList.toggle("active", a.dataset.section === section);
  });

  document.getElementById("hero-section").style.display    = (section === "home" || section === "movies") ? "" : "none";
  document.getElementById("movies-sections").style.display = (section === "home" || section === "movies") ? "" : "none";
  document.getElementById("series-sections").style.display = section === "series" ? "" : "none";
  document.getElementById("watchlist-section").style.display = section === "watchlist" ? "" : "none";

  if (section === "series" && !seriesLoaded) loadSeries();
  if (section === "watchlist") renderWatchlistSection();
}

// ── SERIES ───────────────────────────────────────────────────
async function loadSeries() {
  seriesLoaded = true;
  const [trending, popular, topRated, drama, crime, scifi] = await Promise.all([
    tmdb("/trending/tv/day"),
    tmdb("/tv/popular"),
    tmdb("/tv/top_rated"),
    tmdb("/discover/tv", "with_genres=18"),   // drama
    tmdb("/discover/tv", "with_genres=80"),   // crime
    tmdb("/discover/tv", "with_genres=10765"),// sci-fi & fantasy
  ]);

  renderRow("trending-tv-row",  trending,  "tv");
  renderRow("popular-tv-row",   popular,   "tv");
  renderRow("toprated-tv-row",  topRated,  "tv");
  renderRow("drama-tv-row",     drama,     "tv");
  renderRow("crime-tv-row",     crime,     "tv");
  renderRow("scifi-tv-row",     scifi,     "tv");
}

// ── HERO ─────────────────────────────────────────────────────
function buildHero(movie, mediaType) {
  if (!movie?.id) return;   // TMDB row failed — leave the hero in its loading state

  const bg = document.querySelector(".hero-bg-fill");
  bg.style.cssText = `
    background-image:
      linear-gradient(to right, rgba(11,11,15,.92) 30%, rgba(11,11,15,.3) 80%),
      linear-gradient(to top,   rgba(11,11,15,1)  0%,  transparent 50%),
      url(${IMG_ORIG}${movie.backdrop_path});
    background-size: cover;
    background-position: center top;
  `;
  const title = movie.title || movie.name || "Untitled";
  document.querySelector(".hero-title").textContent = title;
  document.querySelector(".hero-desc").textContent  = movie.overview || "";
  document.querySelector(".hero-rating").textContent =
    `★ ${Number.isFinite(movie.vote_average) ? movie.vote_average.toFixed(1) : "—"}`;
  document.querySelector(".btn-play").onclick = () => openPlayer(movie.id, title, mediaType);
  document.querySelector(".btn-more").onclick = () => openModal(movie.id, mediaType);
}

// ── RENDER HELPERS ───────────────────────────────────────────
function renderRow(id, movies, mediaType, badge) {
  const el = document.getElementById(id);
  if (!el) return;

  const items = Array.isArray(movies) ? movies.filter(m => m?.id) : [];
  if (!items.length) {
    // Hide the whole section rather than leaving an empty rail behind.
    el.closest(".section")?.style.setProperty("display", "none");
    return;
  }

  el.innerHTML = items.map(m => cardHTML(m, mediaType, badge)).join("");
  el.querySelectorAll(".card").forEach(card => {
    card.addEventListener("click", () => openModal(+card.dataset.id, card.dataset.type));
  });
  // Watchlist hearts are delegated — see initDelegatedHandlers()
}

function renderTop10(id, movies) {
  const el = document.getElementById(id);
  if (!el) return;

  const items = Array.isArray(movies) ? movies.filter(m => m?.poster_path) : [];
  if (!items.length) {
    el.closest(".section")?.style.setProperty("display", "none");
    return;
  }

  el.innerHTML = items.map((m, i) => top10HTML(m, i)).join("");
  el.querySelectorAll(".top10-item").forEach(el => {
    el.addEventListener("click", () => openModal(+el.dataset.id, "movie"));
  });
}

// Escape anything interpolated into HTML. TMDB titles contain quotes,
// ampersands and angle brackets often enough to matter.
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function cardHTML(m, mediaType, badge) {
  const poster = m.poster_path ? `${IMG_BASE}${m.poster_path}` : PLACEHOLDER;
  const title  = m.title || m.name || "Unknown";
  const inList = userWatchlist.some(w => w.movieId === m.id);
  const rating = Number.isFinite(m.vote_average) ? m.vote_average.toFixed(1) : "N/A";

  return `
    <div class="card" data-id="${m.id}" data-type="${esc(mediaType)}">
      ${badge ? `<div class="card-badge">${esc(badge)}</div>` : ""}
      <div class="card-watchlist-btn ${inList ? "in-list" : ""}"
           data-watchlist data-id="${m.id}" data-type="${esc(mediaType)}"
           data-title="${esc(title)}" data-poster="${esc(m.poster_path || "")}"
      >${inList ? "♥" : "♡"}</div>
      <img class="card-poster" src="${esc(poster)}" alt="${esc(title)}" loading="lazy">
      <div class="card-info">
        <div class="card-title">${esc(title)}</div>
        <div class="card-meta">
          <span class="card-star">&#9733; ${rating}</span>
          <span class="dot">&middot;</span>
          <span>${(m.release_date || m.first_air_date || "").slice(0,4) || "N/A"}</span>
        </div>
      </div>
    </div>`;
}

// One delegated listener for every watchlist heart on the page, present and
// future. Replaces inline onclick handlers that interpolated titles into JS.
function initDelegatedHandlers() {
  document.addEventListener("click", e => {
    const btn = e.target.closest("[data-watchlist]");
    if (!btn) return;
    e.stopPropagation();
    toggleWatchlist(btn, {
      movieId:   +btn.dataset.id,
      mediaType: btn.dataset.type,
      title:     btn.dataset.title,
      posterPath: btn.dataset.poster
    });
  });
}

function top10HTML(m, i) {
  return `
    <div class="top10-item" data-id="${m.id}">
      <div class="top10-num">${i + 1}</div>
      <img class="top10-img-placeholder" src="${IMG_BASE}${m.poster_path}" alt="${m.title}" loading="lazy">
    </div>`;
}

// ── CONTINUE WATCHING ────────────────────────────────────────
// Resumes from the position persisted by saveProgress(). Always the first row.
async function renderContinueWatching() {
  const section = document.getElementById("continue-section");
  if (!section) return;

  if (!authToken) { section.style.display = "none"; return; }

  const { items = [] } = await api("GET", "/history/continue");
  if (!items.length) { section.style.display = "none"; return; }

  section.style.display = "";
  document.getElementById("continue-row").innerHTML = items.map(it => {
    const left = Math.max(0, Math.round((it.duration - it.position) / 60));
    const label = it.mediaType === "tv" && it.season
      ? `${it.title || "Episode"} · S${it.season}E${it.episode}`
      : (it.title || "Untitled");

    return `
      <div class="card continue-card" data-id="${it.tmdbId}" data-type="${esc(it.mediaType)}"
           data-season="${it.season || 1}" data-episode="${it.episode || 1}"
           data-position="${it.position}" data-title="${esc(it.title || "")}">
        <div class="continue-remove" data-remove="${it.tmdbId}" title="Remove">✕</div>
        <img class="card-poster" src="${it.posterPath ? IMG_BASE + esc(it.posterPath) : PLACEHOLDER}"
             alt="${esc(label)}" loading="lazy">
        <div class="continue-progress">
          <div class="continue-progress-fill" style="width:${Math.min(100, it.percent).toFixed(1)}%"></div>
        </div>
        <div class="card-info">
          <div class="card-title">${esc(label)}</div>
          <div class="card-meta"><span class="continue-remaining">${left} min left</span></div>
        </div>
      </div>`;
  }).join("");

  document.querySelectorAll("#continue-row .continue-card").forEach(card => {
    card.addEventListener("click", e => {
      if (e.target.closest("[data-remove]")) return;
      // Resume exactly where they stopped.
      openRoomPlayer({
        movieId:   +card.dataset.id,
        title:     card.dataset.title,
        mediaType: card.dataset.type,
        season:    +card.dataset.season,
        episode:   +card.dataset.episode
      }, { currentTime: +card.dataset.position, autoplay: true });
    });
  });

  document.querySelectorAll("#continue-row [data-remove]").forEach(btn => {
    btn.addEventListener("click", async e => {
      e.stopPropagation();
      await api("DELETE", `/history/${btn.dataset.remove}`);
      renderContinueWatching();
    });
  });
}

// ── WATCHLIST ────────────────────────────────────────────────
async function loadWatchlist() {
  if (!authToken) return;
  const data = await api("GET", "/watchlist");
  if (data.watchlist) userWatchlist = data.watchlist;
}

async function toggleWatchlist(btn, item) {
  if (!authToken) { openAuthModal(); return; }

  const { movieId, mediaType, title, posterPath } = item;
  const inList = userWatchlist.some(w => w.movieId === movieId);

  // Optimistic — revert if the request fails.
  setHeart(btn, !inList);

  const data = inList
    ? await api("DELETE", `/watchlist/${movieId}`)
    : await api("POST", "/watchlist", { movieId, title, posterPath, mediaType });

  if (data.error) {
    setHeart(btn, inList);
    showToast(data.error);
    return;
  }

  userWatchlist = data.watchlist || (inList
    ? userWatchlist.filter(w => w.movieId !== movieId)
    : [...userWatchlist, { movieId, title, posterPath, mediaType }]);

  // Keep every other heart for this title in sync.
  document.querySelectorAll(`[data-watchlist][data-id="${movieId}"]`)
    .forEach(el => setHeart(el, !inList));
}

function setHeart(btn, on) {
  if (!btn) return;
  btn.textContent = on ? "♥" : "♡";
  btn.classList.toggle("in-list", on);
}

function renderWatchlistSection() {
  const row = document.getElementById("watchlist-row");
  const empty = document.getElementById("watchlist-empty");
  if (!authToken) {
    row.innerHTML = `<div class="watchlist-login-prompt">
      <p>Sign in to access your watchlist.</p>
      <button class="btn-play" onclick="openAuthModal()" style="margin-top:14px">Sign In</button>
    </div>`;
    empty.style.display = "none";
    return;
  }
  if (!userWatchlist.length) {
    row.innerHTML = "";
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";
  row.innerHTML = userWatchlist.map(w => `
    <div class="card" data-id="${w.movieId}" data-type="${esc(w.mediaType)}">
      <div class="card-watchlist-btn in-list"
           data-watchlist data-id="${w.movieId}" data-type="${esc(w.mediaType)}"
           data-title="${esc(w.title)}" data-poster="${esc(w.posterPath || "")}">♥</div>
      <img class="card-poster" src="${w.posterPath ? IMG_BASE + esc(w.posterPath) : PLACEHOLDER}" alt="${esc(w.title)}" loading="lazy">
      <div class="card-info">
        <div class="card-title">${esc(w.title)}</div>
        <div class="card-meta"><span style="color:#7B93F5;font-size:11px;text-transform:uppercase">${w.mediaType === "tv" ? "Series" : "Movie"}</span></div>
      </div>
    </div>`).join("");

  row.querySelectorAll(".card").forEach(card => {
    card.addEventListener("click", () => openModal(+card.dataset.id, card.dataset.type));
  });
}

// ── MODAL SYSTEM ─────────────────────────────────────────────
const modal     = document.getElementById("movie-modal");
const modalBody = document.getElementById("modal-body");

modal.addEventListener("click", e => { if (e.target === modal) closeModal(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") closeAllModals(); });

function closeModal() {
  modal.classList.remove("open");
  modalBody.innerHTML = "";
  currentPlayer = null;
}

function closeAllModals() {
  closeModal();
  closeAuthModal();

  closeSearch();
}

async function openModal(id, mediaType = "movie") {
  modal.classList.add("open");
  modalBody.innerHTML = `<div class="modal-loading">Loading…</div>`;

  if (mediaType === "tv") {
    await openTVModal(id);
  } else {
    await openMovieModal(id);
  }
}

async function openMovieModal(movieId) {
  const [details, videos] = await Promise.all([
    tmdb(`/movie/${movieId}`),
    tmdb(`/movie/${movieId}/videos`),
  ]);

  const trailer = videos.find(v => v.site === "YouTube" && v.type === "Trailer") ||
    videos.find(v => v.site === "YouTube") || videos[0] || null;

  const genres  = (details.genres || []).map(g => `<span>${g.name}</span>`).join("");
  const runtime = details.runtime
    ? `${Math.floor(details.runtime / 60)}h ${details.runtime % 60}m` : "N/A";

  const trailerEmbed = trailer
    ? `<iframe src="https://www.youtube.com/embed/${trailer.key}?rel=0&modestbranding=1"
         frameborder="0" allowfullscreen class="modal-trailer"></iframe>`
    : `<div class="no-trailer">No trailer available</div>`;

  const inList = userWatchlist.some(w => w.movieId === movieId);

  modalBody.innerHTML = `
    <button class="modal-close" onclick="closeModal()">✕</button>
    <div class="modal-trailer-wrap">${trailerEmbed}</div>
    <div class="modal-info">
      <h2 class="modal-title">${details.title}</h2>
      ${details.tagline ? `<p class="modal-tagline">"${details.tagline}"</p>` : ""}
      <div class="modal-meta-row">
        <span class="modal-rating">&#9733; ${details.vote_average?.toFixed(1)}</span>
        <span class="dot">&middot;</span>
        <span>${(details.release_date || "").slice(0,4)}</span>
        <span class="dot">&middot;</span>
        <span>${runtime}</span>
        ${details.adult ? `<span class="badge-adult">18+</span>` : ""}
      </div>
      <div class="modal-genres">${genres}</div>
      <p class="modal-overview">${details.overview}</p>
      <div class="modal-actions">
        <button class="btn-watch-now" onclick="openPlayer(${details.id}, '${details.title.replace(/'/g,"\\'")}', 'movie')">
          &#9654;&nbsp; Watch Now
        </button>
        <button class="btn-watchlist-modal ${inList ? "in-list" : ""}"
          data-watchlist data-id="${movieId}" data-type="movie"
          data-title="${esc(details.title)}" data-poster="${esc(details.poster_path || "")}">
          ${inList ? "♥ In My List" : "♡ Add to List"}
        </button>
      </div>
    </div>`;
}

async function openTVModal(tvId) {
  const details = await tmdb(`/tv/${tvId}`);
  const videos  = await tmdb(`/tv/${tvId}/videos`);

  const trailer = videos.find(v => v.site === "YouTube" && v.type === "Trailer") ||
    videos.find(v => v.site === "YouTube") || videos[0] || null;

  const genres  = (details.genres || []).map(g => `<span>${g.name}</span>`).join("");
  const seasons = (details.seasons || []).filter(s => s.season_number > 0);
  const inList  = userWatchlist.some(w => w.movieId === tvId);

  const trailerEmbed = trailer
    ? `<iframe src="https://www.youtube.com/embed/${trailer.key}?rel=0&modestbranding=1"
         frameborder="0" allowfullscreen class="modal-trailer"></iframe>`
    : `<div class="no-trailer">No trailer available</div>`;

  // Season selector
  const seasonOpts = seasons.map(s =>
    `<option value="${s.season_number}">Season ${s.season_number} (${s.episode_count} eps)</option>`
  ).join("");

  modalBody.innerHTML = `
    <button class="modal-close" onclick="closeModal()">✕</button>
    <div class="modal-trailer-wrap">${trailerEmbed}</div>
    <div class="modal-info">
      <div class="tv-badge">SERIES</div>
      <h2 class="modal-title">${details.name}</h2>
      ${details.tagline ? `<p class="modal-tagline">"${details.tagline}"</p>` : ""}
      <div class="modal-meta-row">
        <span class="modal-rating">&#9733; ${details.vote_average?.toFixed(1)}</span>
        <span class="dot">&middot;</span>
        <span>${(details.first_air_date || "").slice(0,4)}</span>
        <span class="dot">&middot;</span>
        <span>${details.number_of_seasons} Season${details.number_of_seasons !== 1 ? "s" : ""}</span>
        <span class="dot">&middot;</span>
        <span>${details.number_of_episodes} Episodes</span>
      </div>
      <div class="modal-genres">${genres}</div>
      <p class="modal-overview">${details.overview}</p>

      <!-- Season / Episode Picker -->
      <div class="episode-picker">
        <div class="picker-row">
          <select class="season-select" id="season-select" onchange="loadEpisodes(${tvId})">
            ${seasonOpts}
          </select>
          <select class="episode-select" id="episode-select">
            <option>Select season first</option>
          </select>
        </div>
        <div class="modal-actions">
          <button class="btn-watch-now" onclick="watchTVEpisode(${tvId}, '${details.name.replace(/'/g,"\\'")}')">
            &#9654;&nbsp; Play Episode
          </button>
          <button class="btn-watchlist-modal ${inList ? "in-list" : ""}"
            data-watchlist data-id="${tvId}" data-type="tv"
            data-title="${esc(details.name)}" data-poster="${esc(details.poster_path || "")}">
            ${inList ? "♥ In My List" : "♡ Add to List"}
          </button>
        </div>
      </div>

      <div class="episodes-grid" id="episodes-grid">
        <p style="color:#555;font-size:13px">Choose a season to see episodes.</p>
      </div>
    </div>`;

  // Auto-load season 1 episodes
  if (seasons.length) loadEpisodes(tvId);
}

async function loadEpisodes(tvId) {
  const seasonNum = +document.getElementById("season-select").value;
  const grid      = document.getElementById("episodes-grid");
  const epSelect  = document.getElementById("episode-select");
  grid.innerHTML  = `<div style="color:#555;font-size:13px">Loading episodes…</div>`;

  const season = await tmdb(`/tv/${tvId}/season/${seasonNum}`);
  const eps    = season.episodes || [];

  // Populate dropdown
  epSelect.innerHTML = eps.map(e =>
    `<option value="${e.episode_number}">Ep ${e.episode_number}: ${e.name}</option>`
  ).join("");

  // Render episode cards
  grid.innerHTML = eps.map(ep => `
    <div class="episode-card" onclick="openPlayerTV(${tvId}, '${ep.name.replace(/'/g,"\\'")}', ${seasonNum}, ${ep.episode_number})">
      <div class="ep-thumb-wrap">
        ${ep.still_path
          ? `<img class="ep-thumb" src="${IMG_BASE}${ep.still_path}" loading="lazy">`
          : `<div class="ep-thumb-placeholder">EP ${ep.episode_number}</div>`}
        <div class="ep-play-icon">▶</div>
      </div>
      <div class="ep-info">
        <div class="ep-num">Episode ${ep.episode_number}</div>
        <div class="ep-name">${ep.name}</div>
        ${ep.runtime ? `<div class="ep-runtime">${ep.runtime}m</div>` : ""}
      </div>
    </div>`).join("");
}

function watchTVEpisode(tvId, showName) {
  const seasonNum = +document.getElementById("season-select").value;
  const epNum     = +document.getElementById("episode-select").value;
  openPlayerTV(tvId, showName, seasonNum, epNum);
}

// ── PLAYER ───────────────────────────────────────────────────
// Source selection, fallback and playback all live in player.js.

function openPlayer(movieId, title, mediaType = "movie") {
  if (mediaType === "tv") return openPlayerTV(movieId, title, 1, 1);
  openRoomPlayer({ movieId, title, mediaType });
}

function openPlayerTV(tvId, showName, season, episode) {
  openRoomPlayer({ movieId: tvId, title: showName, mediaType: "tv", season, episode });
}

function openRoomPlayer(item, options = {}) {
  const normalized = {
    movieId:   item.movieId,
    channelId: item.channelId,
    title:     item.title || item.movieTitle || "Now Playing",
    mediaType: item.mediaType || "movie",
    season:    item.season  || 1,
    episode:   item.episode || 1
  };

  currentPlayer = normalized;
  playTitle(normalized, options);
}

// player.js calls this on every play/pause/seek/timeupdate.
onPlayerEvent = ({ event, currentTime, duration, item }) => {
  if (Number.isFinite(currentTime) && currentPlayer) currentPlayer.currentTime = currentTime;

  const status = document.getElementById("player-status");
  if (status && event !== "timeupdate") {
    status.textContent = { play: "▶ Playing", pause: "⏸ Paused", ended: "✓ Finished" }[event] || "";
  }

  saveProgress(item, currentTime, duration);
};

// Persist watch position — this is what Continue Watching reads.
// Throttled to one write per 10s.
let lastProgressWrite = 0;
function saveProgress(item, currentTime, duration) {
  if (!authToken || !item?.movieId || !currentTime || !duration) return;
  if (Date.now() - lastProgressWrite < 10_000) return;
  lastProgressWrite = Date.now();

  api("POST", "/history", {
    tmdbId:    item.movieId,
    mediaType: item.mediaType,
    title:     item.title,
    season:    item.season,
    episode:   item.episode,
    position:  Math.floor(currentTime),
    duration:  Math.floor(duration)
  });
}

// ── SEARCH ───────────────────────────────────────────────────
function initSearch() {
  const overlay  = document.getElementById("search-overlay");
  const input    = document.getElementById("search-input");
  const clearBtn = document.getElementById("search-clear");
  const toggleBtn = document.getElementById("search-toggle");

  toggleBtn.addEventListener("click", () => {
    overlay.classList.add("open");
    setTimeout(() => input.focus(), 100);
  });

  clearBtn.addEventListener("click", closeSearch);

  input.addEventListener("input", () => {
    clearTimeout(searchTimeout);
    const q = input.value.trim();
    if (!q) {
      document.getElementById("search-content").innerHTML = `<div class="search-hint"><p>Start typing to search across thousands of titles</p></div>`;
      return;
    }
    document.getElementById("search-content").innerHTML = `<div class="search-loading">Searching…</div>`;
    searchTimeout = setTimeout(() => runSearch(q), 350);
  });

  // Close on Escape
  input.addEventListener("keydown", e => { if (e.key === "Escape") closeSearch(); });
}

function closeSearch() {
  const overlay = document.getElementById("search-overlay");
  const input   = document.getElementById("search-input");
  overlay.classList.remove("open");
  input.value = "";
  document.getElementById("search-content").innerHTML = `<div class="search-hint"><p>Start typing to search across thousands of titles</p></div>`;
}

async function runSearch(query) {
  const [movies, tv] = await Promise.all([
    tmdb("/search/movie", `query=${encodeURIComponent(query)}`),
    tmdb("/search/tv",    `query=${encodeURIComponent(query)}`),
  ]);

  const content = document.getElementById("search-content");
  const combined = [
    ...movies.slice(0,10).map(m => ({...m, _type:"movie"})),
    ...tv.slice(0,10).map(t => ({...t, _type:"tv"})),
  ].filter(m => m.poster_path);

  if (!combined.length) {
    content.innerHTML = `<div class="search-empty">No results for "<strong>${query}</strong>"</div>`;
    return;
  }

  content.innerHTML = `
    <div class="search-label">Results for "<strong>${query}</strong>"</div>
    <div class="search-grid">${combined.map(m => searchCardHTML(m)).join("")}</div>`;

  content.querySelectorAll(".search-card").forEach(card => {
    card.addEventListener("click", () => {
      closeSearch();
      openModal(+card.dataset.id, card.dataset.type);
    });
  });
}

function searchCardHTML(m) {
  const title = m.title || m.name || "Unknown";
  const year  = (m.release_date || m.first_air_date || "").slice(0,4);
  return `
    <div class="search-card" data-id="${m.id}" data-type="${m._type}">
      <img src="${IMG_BASE}${m.poster_path}" alt="${title}" loading="lazy">
      <div class="search-card-overlay">
        <div class="search-card-title">${title}</div>
        <div class="search-card-meta">
          <span class="search-card-type">${m._type === "tv" ? "Series" : "Movie"}</span>
          ${year ? `<span>${year}</span>` : ""}
          ${m.vote_average ? `<span>★ ${m.vote_average.toFixed(1)}</span>` : ""}
        </div>
      </div>
    </div>`;
}

// ── AUTH ─────────────────────────────────────────────────────
function updateNavAvatar() {
  const avatar = document.getElementById("nav-avatar");
  if (currentUser) {
    avatar.textContent = currentUser.username.slice(0,2).toUpperCase();
    avatar.classList.add("logged-in");
  } else {
    avatar.textContent = "?";
    avatar.classList.remove("logged-in");
  }
}

function openAuthModal() {
  document.getElementById("auth-modal").classList.add("open");
}
function closeAuthModal() {
  document.getElementById("auth-modal").classList.remove("open");
  document.getElementById("login-error").textContent = "";
  document.getElementById("reg-error").textContent = "";
}

function switchAuthTab(tab) {
  document.getElementById("login-tab").classList.toggle("active", tab === "login");
  document.getElementById("register-tab").classList.toggle("active", tab === "register");
  document.getElementById("login-form").style.display    = tab === "login" ? "" : "none";
  document.getElementById("register-form").style.display = tab === "register" ? "" : "none";
}

async function handleLogin() {
  const email    = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const errEl    = document.getElementById("login-error");
  errEl.textContent = "";

  const data = await api("POST", "/auth/login", { email, password });
  if (data.error) { errEl.textContent = data.error; return; }

  authToken   = data.token;
  currentUser = data.user;
  localStorage.setItem(TOKEN_KEY, authToken);
  localStorage.setItem(USER_KEY, JSON.stringify(currentUser));
  closeAuthModal();
  updateNavAvatar();
  loadWatchlist();
}

async function handleRegister() {
  const username = document.getElementById("reg-username").value.trim();
  const email    = document.getElementById("reg-email").value.trim();
  const password = document.getElementById("reg-password").value;
  const errEl    = document.getElementById("reg-error");
  errEl.textContent = "";

  const data = await api("POST", "/auth/register", { username, email, password });
  if (data.error) { errEl.textContent = data.error; return; }

  authToken   = data.token;
  currentUser = data.user;
  localStorage.setItem(TOKEN_KEY, authToken);
  localStorage.setItem(USER_KEY, JSON.stringify(currentUser));
  closeAuthModal();
  updateNavAvatar();
}

function showUserMenu() {
  // Simple sign-out on avatar click (could expand to dropdown)
  if (confirm(`Signed in as ${currentUser.username}. Sign out?`)) {
    authToken   = null;
    currentUser = null;
    userWatchlist = [];
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    updateNavAvatar();
  }
}



// ── TABS ─────────────────────────────────────────────────────
document.querySelectorAll(".section-tabs").forEach(tabs => {
  tabs.querySelectorAll(".tab").forEach(tab => {
    tab.addEventListener("click", () => {
      tabs.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
    });
  });
});

// ── TOAST ────────────────────────────────────────────────────
function showToast(msg) {
  const t = document.createElement("div");
  t.className = "vmax-toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add("show"), 10);
  setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, 3000);
}

// ── GO ───────────────────────────────────────────────────────
init();
