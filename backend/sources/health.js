// Rolling success rate per provider, reported by the client after each
// playback attempt. Feeds back into ranking so dead providers sink on their
// own and you never have to hand-edit weights.
//
// ponytail: in-memory + non-persistent. Survives fine for ranking purposes
// (it re-learns within minutes of a restart). Move to Redis alongside room
// state when you scale past one instance.
const stats = new Map();   // id → { ok, fail, updated }

const WINDOW_MS = 24 * 3600 * 1000;

function report(id, outcome) {
  const s = stats.get(id) || { ok: 0, fail: 0, updated: Date.now() };

  // Decay the window: halve counts once a day so old failures stop counting.
  if (Date.now() - s.updated > WINDOW_MS) {
    s.ok /= 2;
    s.fail /= 2;
    s.updated = Date.now();
  }

  if (outcome === "ok") s.ok++; else s.fail++;
  stats.set(id, s);
}

// Returns a ranking adjustment in roughly [-40, +20].
// Providers with no data score 0 — neutral, so new providers get a fair trial.
function score(id) {
  const s = stats.get(id);
  if (!s) return 0;

  const total = s.ok + s.fail;
  if (total < 5) return 0;              // not enough signal yet

  const rate = s.ok / total;
  return Math.round(rate * 60 - 40);    // 100% → +20, 50% → -10, 0% → -40
}

function snapshot() {
  return [...stats.entries()].map(([id, s]) => ({
    id,
    ok: Math.round(s.ok),
    fail: Math.round(s.fail),
    successRate: s.ok + s.fail ? +(s.ok / (s.ok + s.fail)).toFixed(3) : null,
    score: score(id)
  }));
}

module.exports = { report, score, snapshot };
