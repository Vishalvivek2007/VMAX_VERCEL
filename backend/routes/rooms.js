const express = require("express");
const { v4: uuidv4 } = require("uuid");
const Room = require("../models/Room");
const auth = require("../middleware/auth");

const router = express.Router();

function generateCode() {
  return uuidv4().replace(/-/g, "").toUpperCase().slice(0, 6);
}

// POST /api/rooms/create
router.post("/create", auth, async (req, res) => {
  try {
    const { movieId, movieTitle, mediaType } = req.body;

    // Deactivate any old rooms by this host
    await Room.updateMany({ host: req.user._id }, { isActive: false });

    const code = generateCode();
    const room = await Room.create({
      code,
      host:       req.user._id,
      hostName:   req.user.username,
      movieId:    movieId   || null,
      movieTitle: movieTitle || "",
      mediaType:  mediaType || "movie"
    });

    res.status(201).json({ room });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/rooms/:code  — validate a room code
router.get("/:code", async (req, res) => {
  try {
    const room = await Room.findOne({
      code: req.params.code.toUpperCase(),
      isActive: true
    });
    if (!room) return res.status(404).json({ error: "Room not found or expired" });
    res.json({ room });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/rooms/:code  — host closes room
router.delete("/:code", auth, async (req, res) => {
  try {
    const room = await Room.findOne({ code: req.params.code.toUpperCase() });
    if (!room) return res.status(404).json({ error: "Room not found" });
    if (room.host.toString() !== req.user._id.toString())
      return res.status(403).json({ error: "Only host can close the room" });

    room.isActive = false;
    await room.save();
    res.json({ message: "Room closed" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;