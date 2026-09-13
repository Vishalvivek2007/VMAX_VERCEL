const mongoose = require("mongoose");

const roomSchema = new mongoose.Schema({
  code:       { type: String, required: true, unique: true, uppercase: true },
  host:       { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  hostName:   { type: String, required: true },
  movieId:    { type: Number, default: null },
  movieTitle: { type: String, default: "" },
  mediaType:  { type: String, enum: ["movie", "tv"], default: "movie" },
  isActive:   { type: Boolean, default: true },
  createdAt:  { type: Date, default: Date.now, expires: 86400 } // auto-delete after 24h
});

module.exports = mongoose.model("Room", roomSchema);