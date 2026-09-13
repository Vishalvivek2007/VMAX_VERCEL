const express = require("express");
const User    = require("../models/User");
const auth    = require("../middleware/auth");

const router = express.Router();

// GET /api/watchlist  — get current user's watchlist
router.get("/", auth, async (req, res) => {
  try {
    res.json({ watchlist: req.user.watchlist });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/watchlist  — add a movie/show
router.post("/", auth, async (req, res) => {
  try {
    const { movieId, title, posterPath, mediaType } = req.body;
    if (!movieId) return res.status(400).json({ error: "movieId required" });

    const user = await User.findById(req.user._id);
    const alreadyIn = user.watchlist.some(w => w.movieId === movieId);
    if (alreadyIn) return res.status(409).json({ error: "Already in watchlist" });

    user.watchlist.push({ movieId, title, posterPath, mediaType: mediaType || "movie" });
    await user.save();

    res.status(201).json({ watchlist: user.watchlist });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/watchlist/:movieId  — remove from watchlist
router.delete("/:movieId", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    user.watchlist = user.watchlist.filter(w => w.movieId !== +req.params.movieId);
    await user.save();
    res.json({ watchlist: user.watchlist });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;