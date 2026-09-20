module.exports = {
  id:        "vidsrc-xyz",
  label:     "VidSrc XYZ",
  kind:      "iframe",
  weight:    90,
  countries: ["*"],
  supports:  ["movie", "tv"],
  timeout:   3000,

  async resolve({ tmdbId, type, season, episode }) {
    if (!tmdbId) return null;
    
    if (type === "tv") {
      return { url: `https://vidsrc.xyz/embed/tv?tmdb=${tmdbId}&season=${season}&episode=${episode}` };
    } else {
      return { url: `https://vidsrc.xyz/embed/movie?tmdb=${tmdbId}` };
    }
  }
};

