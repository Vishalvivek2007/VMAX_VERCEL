require("dotenv").config();
const express    = require("express");
const http       = require("http");
const { Server } = require("socket.io");
const mongoose   = require("mongoose");
const cors       = require("cors");
const helmet     = require("helmet");
const rateLimit  = require("express-rate-limit");
const jwt        = require("jsonwebtoken");
const path       = require("path");

const authRoutes      = require("./routes/auth");
const watchlistRoutes = require("./routes/watchlist");
const roomRoutes      = require("./routes/rooms");
const tmdbRoutes      = require("./routes/tmdb");
const sourceRoutes    = require("./routes/sources");
const historyRoutes   = require("./routes/history");

// Fail fast rather than silently running prod on a known-public secret.
if (!process.env.JWT_SECRET) {
  if (process.env.NODE_ENV === "production") {
    console.error("❌ JWT_SECRET is required in production. Refusing to start.");
    process.exit(1);
  }
  console.warn("⚠️  JWT_SECRET unset — using a dev-only fallback.");
}

// Comma-separated list, e.g. "https://vmax.example.com,https://www.vmax.example.com"
const ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map(o => o.trim()).filter(Boolean);
const corsOptions = ORIGINS.length
  ? { origin: ORIGINS, credentials: true }
  : { origin: true, credentials: true };   // dev: reflect request origin

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: ORIGINS.length ? ORIGINS : true, methods: ["GET", "POST"] }
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

// ── Middleware ────────────────────────────────────────────
app.set("trust proxy", 1);   // behind Render/Cloudflare — needed for correct rate-limit IPs

app.use(helmet({
  // Player embeds and TMDB images are cross-origin by nature.
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "https://cdn.socket.io"],
      styleSrc:    ["'self'", "'unsafe-inline'"],
      imgSrc:      ["'self'", "data:", "https://image.tmdb.org", "https://archive.org"],
      mediaSrc:    ["'self'", "https:", "blob:"],
      connectSrc:  ["'self'", "https:", "wss:"],
      // Allowlist of embed origins. Add a provider's origin here when you add
      // the provider itself — an embed not listed here will be blocked.
      frameSrc:    ["'self'", "https://www.youtube.com", "https://archive.org"],
      objectSrc:   ["'none'"],
      baseUri:     ["'self'"]
    }
  }
}));
app.use(cors(corsOptions));
app.use(express.json({ limit: "100kb" }));

app.use("/api", rateLimit({
  windowMs: 60_000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, slow down." }
}));

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "vmax",
    mongo: mongoose.connection.readyState === 1 ? "connected" : "connecting"
  });
});

app.get("/api/warmup", (req, res) => {
  res.json({
    ok: true,
    service: "vmax",
    warmedAt: new Date().toISOString(),
    mongo: mongoose.connection.readyState === 1 ? "connected" : "connecting"
  });
});

// Serve frontend static files
app.use(express.static(path.join(__dirname, "../frontend"), {
  maxAge: "1h",
  etag: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".html") || filePath.endsWith(".js")) {
      res.setHeader("Cache-Control", "no-cache");
    }
  }
}));

// ── API Routes ────────────────────────────────────────────
app.use("/api/auth",      authRoutes);
app.use("/api/watchlist", watchlistRoutes);
app.use("/api/rooms",     roomRoutes);
app.use("/api/tmdb",      tmdbRoutes);
app.use("/api/sources",   sourceRoutes);
app.use("/api/history",   historyRoutes);

// ── MongoDB ───────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/vmax";
mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.error("❌ MongoDB error:", err));

// ── Socket.io — Watch Room Sync ───────────────────────────
// roomStates: { [roomCode]: { movieId, movieTitle, mediaType, playing, currentTime, lastUpdate } }
const roomStates = {};

function stateForJoin(roomCode) {
  const state = roomStates[roomCode];
  if (!state) return null;

  const elapsed = state.playing && state.lastUpdate
    ? (Date.now() - state.lastUpdate) / 1000
    : 0;

  return {
    ...state,
    currentTime: (Number(state.currentTime) || 0) + elapsed
  };
}

// Authenticate the socket from the JWT. Without this, anyone who guesses a
// room code can hijack playback and impersonate any username.
io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error("auth required"));
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "vmax_secret_change_in_prod");
    const user = await require("./models/User").findById(decoded.id).select("username");
    if (!user) return next(new Error("user not found"));
    socket.userId   = String(user._id);
    socket.username = user.username;   // server-assigned — clients can't spoof it
    next();
  } catch {
    next(new Error("invalid token"));
  }
});

io.on("connection", (socket) => {
  console.log(`🔌 Socket connected: ${socket.id} (${socket.username})`);

  // User joins a room
  socket.on("join-room", ({ roomCode }) => {
    if (!/^[A-Z0-9]{4,12}$/.test(String(roomCode || ""))) return;
    socket.join(roomCode);
    socket.roomCode = roomCode;

    // Send current room state to the new joiner
    const currentState = stateForJoin(roomCode);
    if (currentState) {
      socket.emit("room-state", currentState);
    }

    // Notify others
    socket.to(roomCode).emit("user-joined", { username: socket.username });

    // Send updated member count to all in room
    const count = io.sockets.adapter.rooms.get(roomCode)?.size || 0;
    io.to(roomCode).emit("member-count", count);

    console.log(`👥 ${socket.username} joined room ${roomCode}`);
  });

  // Every handler below acts on socket.roomCode — the room this socket
  // actually joined — never on a roomCode from the client payload. Otherwise
  // any authenticated socket could drive a room it was never in.
  const room = () => socket.roomCode;

  // Host sets the movie
  socket.on("room-set-movie", ({ movieId, movieTitle, mediaType, season, episode }) => {
    const code = room();
    if (!code) return;
    roomStates[code] = {
      movieId,
      movieTitle:  String(movieTitle || "").slice(0, 200),
      mediaType:   mediaType === "tv" ? "tv" : "movie",
      season:      Number(season)  || 1,
      episode:     Number(episode) || 1,
      playing:     false,
      currentTime: 0,
      lastUpdate:  Date.now()
    };
    socket.to(code).emit("room-movie-changed", roomStates[code]);
  });

  // Play / pause / seek all mutate the same shape.
  const syncHandler = (action, playing) => ({ currentTime }) => {
    const code = room();
    if (!code) return;
    const time = Number(currentTime);
    if (!Number.isFinite(time) || time < 0) return;

    if (!roomStates[code]) roomStates[code] = {};
    if (playing !== null) roomStates[code].playing = playing;
    roomStates[code].currentTime = time;
    roomStates[code].lastUpdate  = Date.now();
    socket.to(code).emit(`sync-${action}`, { currentTime: time, username: socket.username });
  };

  socket.on("room-play",  syncHandler("play",  true));
  socket.on("room-pause", syncHandler("pause", false));
  socket.on("room-seek",  syncHandler("seek",  null));

  // Chat message in room
  socket.on("room-chat", ({ message }) => {
    const code = room();
    const text = String(message || "").slice(0, 500).trim();
    if (!code || !text) return;
    io.to(code).emit("chat-message", {
      username: socket.username,   // never from the client
      message: text,               // rendered with textContent on the client
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    });
  });

  // Disconnect
  socket.on("disconnect", () => {
    if (socket.roomCode) {
      const count = (io.sockets.adapter.rooms.get(socket.roomCode)?.size || 0);
      io.to(socket.roomCode).emit("member-count", count);
      socket.to(socket.roomCode).emit("user-left", { username: socket.username });
      // Clean up state if room empty
      if (count === 0) delete roomStates[socket.roomCode];
    }
    console.log(`🔌 Socket disconnected: ${socket.id}`);
  });
});

// ── Start ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 VMAX server running on http://localhost:${PORT}`);
});
