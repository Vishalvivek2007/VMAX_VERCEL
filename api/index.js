require("dotenv").config();
const express    = require("express");
const mongoose   = require("mongoose");
const cors       = require("cors");

const authRoutes      = require("../backend/routes/auth");
const watchlistRoutes = require("../backend/routes/watchlist");
const historyRoutes   = require("../backend/routes/history");
const roomRoutes      = require("../backend/routes/rooms");
const sourcesRoutes   = require("../backend/routes/sources");
const tmdbRoutes      = require("../backend/routes/tmdb");

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
app.use("/api/auth",      authRoutes);
app.use("/api/watchlist", watchlistRoutes);
app.use("/api/history",   historyRoutes);
app.use("/api/rooms",     roomRoutes);
app.use("/api/sources",   sourcesRoutes);
app.use("/api/tmdb",      tmdbRoutes);

module.exports = app;
