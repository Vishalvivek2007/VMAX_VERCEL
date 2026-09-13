const mongoose = require("mongoose");

// One document per user per title (per episode for TV). Kept out of the User
// doc deliberately — an embedded array would rewrite the whole user on every
// progress tick and eventually hit the 16MB document cap.
const watchHistorySchema = new mongoose.Schema({
  user:      { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  tmdbId:    { type: Number, required: true },
  mediaType: { type: String, enum: ["movie", "tv", "anime"], default: "movie" },
  season:    { type: Number, default: null },
  episode:   { type: Number, default: null },

  title:     String,
  posterPath: String,

  position:  { type: Number, default: 0 },   // seconds
  duration:  { type: Number, default: 0 },   // seconds
  percent:   { type: Number, default: 0 },
  completed: { type: Boolean, default: false },
  sourceId:  String,                         // which provider actually worked

  updatedAt: { type: Date, default: Date.now }
});

// Upsert key.
watchHistorySchema.index({ user: 1, tmdbId: 1, season: 1, episode: 1 }, { unique: true });
// Continue Watching query.
watchHistorySchema.index({ user: 1, completed: 1, updatedAt: -1 });

module.exports = mongoose.model("WatchHistory", watchHistorySchema);
