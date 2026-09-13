const express = require("express");
const WatchHistory = require("../models/WatchHistory");
const auth = require("../middleware/auth");

const router = express.Router();

// Below this we assume a mis-click, above it we assume you finished.
const MIN_PERCENT = 2;
const DONE_PERCENT = 90;

// POST /api/history — upsert playback position (called every ~10s while playing)
router.post("/", auth, async (req, res) => {
  try {
    const { tmdbId, mediaType, season, episode, position, duration, title, posterPath, sourceId } = req.body;
    if (!tmdbId || !duration) return res.status(400).json({ error: "tmdbId and duration required" });

    const percent = Math.min(100, (position / duration) * 100);

    await WatchHistory.findOneAndUpdate(
      {
        user: req.user._id,
        tmdbId,
        season:  season  ?? null,
        episode: episode ?? null
      },
      {
        $set: {
          mediaType: mediaType || "movie",
          position, duration, percent,
          completed: percent >= DONE_PERCENT,
          updatedAt: new Date(),
          ...(title      && { title }),
          ...(posterPath && { posterPath }),
          ...(sourceId   && { sourceId })
        }
      },
      { upsert: true, new: true }
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/history/continue — the Continue Watching row
router.get("/continue", auth, async (req, res) => {
  try {
    const items = await WatchHistory.find({
      user: req.user._id,
      completed: false,
      percent: { $gte: MIN_PERCENT }
    })
      .sort({ updatedAt: -1 })
      .limit(20)
      .lean();

    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/history — full history, newest first
router.get("/", auth, async (req, res) => {
  try {
    const items = await WatchHistory.find({ user: req.user._id })
      .sort({ updatedAt: -1 })
      .limit(Math.min(Number(req.query.limit) || 100, 200))
      .lean();
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/history/:tmdbId — remove from Continue Watching
router.delete("/:tmdbId", auth, async (req, res) => {
  try {
    await WatchHistory.deleteMany({ user: req.user._id, tmdbId: Number(req.params.tmdbId) });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
