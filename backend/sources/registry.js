const fs   = require("fs");
const path = require("path");

// ── Provider auto-loader ─────────────────────────────────────
// Drop a .js file in ./providers and it's live. No registration step.
// See ./README.md for the provider contract.
const PROVIDERS_DIR = path.join(__dirname, "providers");

function loadProviders() {
  const providers = [
    require("./providers/archive-org.js"),
    require("./providers/iptv-org.js")
  ];

  return providers
    .map(provider => {
      try {
        const problem = validate(provider, provider.id);
        if (problem) {
          console.warn(`⚠️  Skipping provider ${provider.id}: ${problem}`);
          return null;
        }
        return normalize(provider);
      } catch (err) {
        console.warn(`⚠️  Provider failed to load: ${err.message}`);
        return null;
      }
    })
    .filter(Boolean);
}

// Fail loudly at boot rather than mysteriously at request time.
function validate(p, filename) {
  if (!p || typeof p !== "object")     return "module must export an object";
  if (!p.id)                           return "missing `id`";
  if (typeof p.resolve !== "function") return "missing `resolve(ctx)` function";
  if (p.kind && !["hls", "file", "iframe", "deeplink"].includes(p.kind))
    return `invalid kind "${p.kind}" (expected hls | file | iframe | deeplink)`;
  return null;
}

function normalize(p) {
  return {
    kind:      "iframe",
    weight:    50,
    countries: ["*"],
    supports:  ["movie", "tv"],
    enabled:   true,
    timeout:   5000,
    ...p
  };
}

const SOURCES = loadProviders();
console.log(`🎬 Loaded ${SOURCES.length} source provider(s): ${SOURCES.map(s => s.id).join(", ") || "none"}`);

// ── Selection ────────────────────────────────────────────────
function eligible({ type = "movie", country = "US" }) {
  return SOURCES.filter(s =>
    s.enabled &&
    s.supports.includes(type) &&
    (s.countries.includes("*") || s.countries.includes(country))
  );
}

// Resolve every eligible provider in parallel. A provider that throws,
// times out, or returns null is simply absent from the result — it can
// never break the response for the others.
async function resolveAll(ctx) {
  const providers = eligible(ctx);

  const settled = await Promise.allSettled(providers.map(async p => {
    const result = await withTimeout(p.resolve(ctx), p.timeout, p.id);
    if (!result || !result.url) return null;
    return {
      id:      p.id,
      kind:    p.kind,
      weight:  p.weight,
      label:   result.label   || p.label || p.id,
      url:     result.url,
      quality: result.quality || null,
      headers: result.headers || null
    };
  }));

  settled.forEach((r, i) => {
    if (r.status === "rejected") {
      console.warn(`⚠️  ${providers[i].id} resolve failed: ${r.reason?.message || r.reason}`);
    }
  });

  return settled
    .filter(r => r.status === "fulfilled" && r.value)
    .map(r => r.value);
}

function withTimeout(promise, ms, id) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${id} timed out after ${ms}ms`)), ms))
  ]);
}

module.exports = { SOURCES, eligible, resolveAll };
