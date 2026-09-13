module.exports = {
  id:        "superembed",
  label:     "SuperEmbed",
  kind:      "iframe",
  weight:    85,
  countries: ["*"],
  supports:  ["movie", "tv"],
  timeout:   3000,

  async resolve({ tmdbId, type, season, episode }) {
    if (!tmdbId) return null;
    
    if (type === "tv") {
      return { url: `https://multiembed.mov/?video_id=${tmdbId}&tmdb=1&s=${season}&e=${episode}` };
    } else {
      return { url: `https://multiembed.mov/?video_id=${tmdbId}&tmdb=1` };
    }
  }
};
