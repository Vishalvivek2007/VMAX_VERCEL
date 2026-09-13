// Tiny in-process TTL cache. No dependency needed for this.
// ponytail: single-process Map — swap for Redis when you run >1 instance
// (rooms need Redis first anyway, see ROADMAP 6.2).
const store = new Map();

function get(key) {
  const hit = store.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    store.delete(key);
    return null;
  }
  return hit.value;
}

function set(key, value, ttlSeconds) {
  store.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
}

// Bound memory: evict expired entries every 10 min.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of store) if (now > v.expires) store.delete(k);
}, 600_000).unref();

module.exports = { get, set };
