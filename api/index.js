require("dotenv").config();
const express    = require("express");
const mongoose   = require("mongoose");
const cors       = require("cors");

const authRoutes      = require("../backend/routes/auth");
const watchlistRoutes = require("../backend/routes/watchlist");
const authMiddleware  = require("../backend/middleware/auth");
const User            = require("../backend/models/User");

const app = express();

app.use(cors());
app.use(express.json());

// ── MongoDB ───────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/vmax";
if (mongoose.connection.readyState === 0) {
  mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ MongoDB connected via Serverless"))
    .catch(err => console.error("❌ MongoDB error:", err));
}

// ── API Routes ────────────────────────────────────────────
app.use("/api/auth", authRoutes);
app.use("/api/watchlist", watchlistRoutes);

// ── History Routes ─────────────────────────────────────────
app.get("/api/history/continue", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    const sorted = (user.history || []).sort((a, b) => b.updatedAt - a.updatedAt);
    res.json({ items: sorted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/history", authMiddleware, async (req, res) => {
  try {
    const { tmdbId, mediaType, title, season, episode, position, duration } = req.body;
    if (!tmdbId || !position || !duration) return res.status(400).json({ error: "Missing fields" });

    const user = await User.findById(req.user.id);
    const existing = user.history.find(h => h.tmdbId === tmdbId);
    const percent = (position / duration) * 100;
    
    if (existing) {
      existing.position = position;
      existing.duration = duration;
      existing.percent = percent;
      existing.updatedAt = Date.now();
    } else {
      user.history.push({
        tmdbId, mediaType, title, season, episode, position, duration, percent, updatedAt: Date.now()
      });
    }

    await user.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/history/:id", authMiddleware, async (req, res) => {
  try {
    const tmdbId = parseInt(req.params.id, 10);
    const user = await User.findById(req.user.id);
    user.history = user.history.filter(h => h.tmdbId !== tmdbId);
    await user.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Sources Route ──────────────────────────────────────────
app.get("/api/sources", (req, res) => {
  const { type, tmdbId, season, episode } = req.query;
  if (!tmdbId) return res.json({ sources: [] });

  const sources = [];
  if (type === "tv") {
    sources.push({ id: "vidsrc-cc", label: "Server 1", kind: "iframe", url: `https://vidsrc.cc/v2/embed/tv/${tmdbId}/${season}/${episode}` });
    sources.push({ id: "vidsrc-xyz", label: "Server 2", kind: "iframe", url: `https://vidsrc.xyz/embed/tv?tmdb=${tmdbId}&season=${season}&episode=${episode}` });
    sources.push({ id: "superembed", label: "Server 3", kind: "iframe", url: `https://multiembed.mov/?video_id=${tmdbId}&tmdb=1&s=${season}&e=${episode}` });
  } else {
    sources.push({ id: "vidsrc-cc", label: "Server 1", kind: "iframe", url: `https://vidsrc.cc/v2/embed/movie/${tmdbId}` });
    sources.push({ id: "vidsrc-xyz", label: "Server 2", kind: "iframe", url: `https://vidsrc.xyz/embed/movie?tmdb=${tmdbId}` });
    sources.push({ id: "superembed", label: "Server 3", kind: "iframe", url: `https://multiembed.mov/?video_id=${tmdbId}&tmdb=1` });
  }

  res.json({ sources });
});

app.post("/api/sources/health", (req, res) => res.json({ success: true }));

module.exports = app;
