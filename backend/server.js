require("dotenv").config();
const express    = require("express");
const http       = require("http");
const { Server } = require("socket.io");
const mongoose   = require("mongoose");
const cors       = require("cors");
const path       = require("path");

const authRoutes      = require("./routes/auth");
const watchlistRoutes = require("./routes/watchlist");
const roomRoutes      = require("./routes/rooms");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

// ── Middleware ────────────────────────────────────────────
app.use(cors());
app.use(express.json());

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

io.on("connection", (socket) => {
  console.log(`🔌 Socket connected: ${socket.id}`);

  // User joins a room
  socket.on("join-room", ({ roomCode, username }) => {
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.username = username || "Guest";

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

  // Host sets the movie
  socket.on("room-set-movie", ({ roomCode, movieId, movieTitle, mediaType, season, episode }) => {
    if (!roomStates[roomCode]) roomStates[roomCode] = {};
    roomStates[roomCode].movieId    = movieId;
    roomStates[roomCode].movieTitle = movieTitle;
    roomStates[roomCode].mediaType  = mediaType || "movie";
    roomStates[roomCode].season     = season || 1;
    roomStates[roomCode].episode    = episode || 1;
    roomStates[roomCode].playing    = false;
    roomStates[roomCode].currentTime = 0;
    roomStates[roomCode].lastUpdate  = Date.now();
    socket.to(roomCode).emit("room-movie-changed", { movieId, movieTitle, mediaType, season, episode });
  });

  // Play event
  socket.on("room-play", ({ roomCode, currentTime }) => {
    if (!roomStates[roomCode]) roomStates[roomCode] = {};
    roomStates[roomCode].playing     = true;
    roomStates[roomCode].currentTime = currentTime;
    roomStates[roomCode].lastUpdate  = Date.now();
    socket.to(roomCode).emit("sync-play", { currentTime, username: socket.username });
  });

  // Pause event
  socket.on("room-pause", ({ roomCode, currentTime }) => {
    if (!roomStates[roomCode]) roomStates[roomCode] = {};
    roomStates[roomCode].playing     = false;
    roomStates[roomCode].currentTime = currentTime;
    roomStates[roomCode].lastUpdate  = Date.now();
    socket.to(roomCode).emit("sync-pause", { currentTime, username: socket.username });
  });

  // Seek event
  socket.on("room-seek", ({ roomCode, currentTime }) => {
    if (!roomStates[roomCode]) roomStates[roomCode] = {};
    roomStates[roomCode].currentTime = currentTime;
    roomStates[roomCode].lastUpdate  = Date.now();
    socket.to(roomCode).emit("sync-seek", { currentTime, username: socket.username });
  });

  // Chat message in room
  socket.on("room-chat", ({ roomCode, message }) => {
    io.to(roomCode).emit("chat-message", {
      username: socket.username,
      message,
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
