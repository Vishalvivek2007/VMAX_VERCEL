require("dotenv").config();
const express = require("express");
const path = require("path");

const app = express();

// Mount the Vercel serverless api
const apiApp = require("./api/index.js");
app.use(apiApp); // api/index.js handles /api/auth, /api/watchlist, etc.

// Serve the static frontend from the root directory
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Local dev server running at http://localhost:${PORT}`);
});

