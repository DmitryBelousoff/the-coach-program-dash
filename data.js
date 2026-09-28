// Data layer for the Program Health dashboard.
//
// load() first asks the serverless endpoint /api/metrics, which queries Amplitude.
// Only some metrics are live so far (the response lists them in `metrics`); the rest
// come back as null. When the endpoint is unavailable (local preview, keys not
// configured) or the page is opened with ?demo, everything falls back to
// deterministic mock data so the UI stays reviewable.
//
// load({ period, date }) -> Promise<{
//   range:     { from: Date, to: Date },
//   prevRange: { from: Date, to: Date },
//   source:    "mock" | "amplitude",
//   liveMetrics: string[],   // metrics with real data (empty for mock)
//   error?:    string,       // why live data isn't shown, when it was expected
//   programs:  [{ id, name, current: Metrics, previous: Metrics }]
// }>
//
// Metrics = {
//   totalUsers, entryOrganic, entryWeb,          // counts
//   lifetimeOrganic, lifetimeWeb,                 // days
//   completionRate, returnRate,                   // 0..1
//   rating, sentiment,                            // rating 1..5, sentiment -1..1
//   catalogPull,                                  // avg programs started after this one
//   shareOfEngagement,                            // 0..1
//   monetization, estimatedRevenue,               // USD
//   shares,                                       // share events
// }
// Any metric may be null when there is no data yet.

(function () {
  const PROGRAMS_KEY = "ph.customPrograms";

  const BASE_PROGRAMS = [
    {
      id: "last-longer", name: "Last Longer",
      base: { totalUsers: 4200, entryOrganic: 620, entryWeb: 310, lifetimeOrganic: 46, lifetimeWeb: 39,
        completionRate: 0.61, returnRate: 0.54, rating: 4.3, sentiment: 0.41, catalogPull: 2.1,
        shareOfEngagement: 0.18, monetization: 3800, estimatedRevenue: 21400, shares: 340 },
    },
    {
      id: "keep-it-hard", name: "Keep it Hard",
      base: { totalUsers: 3100, entryOrganic: 450, entryWeb: 260, lifetimeOrganic: 52, lifetimeWeb: 44,
        completionRate: 0.57, returnRate: 0.49, rating: 4.1, sentiment: 0.28, catalogPull: 1.8,
        shareOfEngagement: 0.14, monetization: 5200, estimatedRevenue: 18900, shares: 190 },
    },
    {
      id: "sex-is-a-skill", name: "Sex is a Skill",
      base: { totalUsers: 5600, entryOrganic: 980, entryWeb: 540, lifetimeOrganic: 38, lifetimeWeb: 31,
        completionRate: 0.68, returnRate: 0.63, rating: 4.6, sentiment: 0.62, catalogPull: 2.9,
        shareOfEngagement: 0.24, monetization: 2900, estimatedRevenue: 26300, shares: 720 },
    },
    {
      id: "overall-health", name: "Overall Health",
      base: { totalUsers: 7800, entryOrganic: 1450, entryWeb: 890, lifetimeOrganic: 33, lifetimeWeb: 28,
        completionRate: 0.72, returnRate: 0.58, rating: 4.4, sentiment: 0.47, catalogPull: 3.4,
        shareOfEngagement: 0.29, monetization: 2100, estimatedRevenue: 31800, shares: 510 },
    },
  ];

  // Period metrics scale with period length; rates and averages do not.
  const VOLUME_KEYS = ["totalUsers", "entryOrganic", "entryWeb", "monetization", "estimatedRevenue", "shares"];
  const PERIOD_SCALE = { week: 1, month: 4.2, quarter: 12.5 };
  const PERIOD_DAYS = { week: 7, month: 30, quarter: 91 };

  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function rng(seed) {
    let s = seed || 1;
    return () => {
      s = (Math.imul(s ^ (s >>> 15), 1 | s) + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 7), 61 | s) ^ s;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function round(v, digits) {
    const k = Math.pow(10, digits);
    return Math.round(v * k) / k;
  }

  // Slow, deterministic drift per program × metric, so a series of periods
  // looks like a real trend instead of pure noise.
  function wave(programId, key, bucket) {
    const h = hash(programId + "|" + key);
    const phase = (h % 1000) / 1000 * Math.PI * 2;
    // Bounded scores (rating 1..5, sentiment) move much less than volumes.
    const damp = key === "rating" ? 0.25 : key === "sentiment" ? 0.6 : 1;
    const amp = (0.06 + ((h >>> 10) % 100) / 100 * 0.10) * damp; // 6–16%
    return 1 + amp * Math.sin(bucket / 4 + phase) + amp * 0.4 * Math.sin(bucket / 1.7 + phase * 2);
  }

  function jitter(base, period, bucket, programId) {
    const rand = rng(hash(programId + "|" + period + "|" + bucket));
    const scale = PERIOD_SCALE[period];
    const out = {};
    for (const key of Object.keys(base)) {
      const noise = 1 + (rand() - 0.5) * 0.08; // ±4%
      let v = base[key] * noise * wave(programId, key, bucket);
      if (VOLUME_KEYS.includes(key)) v *= scale;
      switch (key) {
        case "completionRate": case "returnRate": case "shareOfEngagement":
          v = Math.min(0.99, round(v, 3)); break;
        case "rating": v = Math.min(5, round(v, 1)); break;
        case "sentiment": v = Math.max(-1, Math.min(1, round(v, 2))); break;
        case "catalogPull": v = round(v, 1); break;
        case "lifetimeOrganic": case "lifetimeWeb": v = Math.round(v); break;
        default: v = Math.round(v / 10) * 10;
      }
      out[key] = v;
    }
    return out;
  }

  function emptyMetrics() {
    const m = {};
    for (const key of Object.keys(BASE_PROGRAMS[0].base)) m[key] = null;
    return m;
  }

  function rangeFor(period, date) {
    const to = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const from = new Date(to);
    from.setDate(from.getDate() - PERIOD_DAYS[period] + 1);
    return { from, to };
  }

  function shift(range, days) {
    const from = new Date(range.from); from.setDate(from.getDate() - days);
    const to = new Date(range.to); to.setDate(to.getDate() - days);
    return { from, to };
  }

  function bucketOf(period, date) {
    return Math.floor(date.getTime() / 86400000 / PERIOD_DAYS[period]);
  }

  function readCustomPrograms() {
    try {
      const raw = localStorage.getItem(PROGRAMS_KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list.filter((p) => p && p.id && p.name) : [];
    } catch (e) {
      return [];
    }
  }

  function writeCustomPrograms(list) {
    try { localStorage.setItem(PROGRAMS_KEY, JSON.stringify(list)); } catch (e) { /* storage unavailable */ }
  }

  function localISO(d) {
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }

  function parseISO(s) {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  const forceDemo = /[?&]demo\b/.test(location.search);
  let liveMetrics = []; // set by the last successful live load

  async function fetchJSON(params) {
    const r = await fetch("/api/metrics?" + new URLSearchParams(params));
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return body;
  }

  async function liveLoad({ period, date }) {
    const data = await fetchJSON({ period, date: localISO(date) });
    liveMetrics = data.metrics || [];
    const programs = data.programs.map((p) => ({
      id: p.id,
      name: p.name,
      current: Object.assign(emptyMetrics(), p.current),
      previous: Object.assign(emptyMetrics(), p.previous),
    }));
    return {
      range: { from: parseISO(data.range.from), to: parseISO(data.range.to) },
      prevRange: { from: parseISO(data.prevRange.from), to: parseISO(data.prevRange.to) },
      source: "amplitude",
      liveMetrics,
      programs,
    };
  }

  const mock = {
    async load({ period, date }) {
      const range = rangeFor(period, date);
      const prevRange = shift(range, PERIOD_DAYS[period]);
      const bucket = bucketOf(period, range.to);

      const programs = BASE_PROGRAMS.map((p) => ({
        id: p.id,
        name: p.name,
        current: jitter(p.base, period, bucket, p.id),
        previous: jitter(p.base, period, bucket - 1, p.id),
      }));

      for (const p of readCustomPrograms()) {
        programs.push({ id: p.id, name: p.name, custom: true, current: emptyMetrics(), previous: emptyMetrics() });
      }

      return { range, prevRange, source: "mock", liveMetrics: [], programs };
    },

    // Series of `points` consecutive periods ending with the one that contains `date`.
    // history({ programId, metric, period, date, points }) -> Promise<[{ from, to, value }]>
    async history({ programId, metric, period, date, points }) {
      const p = BASE_PROGRAMS.find((x) => x.id === programId);
      if (!p) return [];
      const range = rangeFor(period, date);
      const bucket = bucketOf(period, range.to);
      const out = [];
      for (let i = points - 1; i >= 0; i--) {
        const r = shift(range, PERIOD_DAYS[period] * i);
        out.push({ from: r.from, to: r.to, value: jitter(p.base, period, bucket - i, p.id)[metric] });
      }
      return out;
    },
  };

  window.DashboardData = {
    async load(args) {
      if (!forceDemo) {
        try {
          const data = await liveLoad(args);
          for (const p of readCustomPrograms()) {
            data.programs.push({ id: p.id, name: p.name, custom: true, current: emptyMetrics(), previous: emptyMetrics() });
          }
          return data;
        } catch (e) {
          console.warn("Live metrics unavailable, showing demo data:", e.message);
          liveMetrics = [];
          const data = await mock.load(args);
          data.error = e.message;
          return data;
        }
      }
      liveMetrics = [];
      return mock.load(args);
    },

    async history(args) {
      if (!liveMetrics.length) return mock.history(args);
      if (!liveMetrics.includes(args.metric)) return [];
      const data = await fetchJSON({
        period: args.period, date: localISO(args.date),
        history: args.programId, metric: args.metric, points: args.points,
      });
      return data.series.map((d) => ({ from: parseISO(d.from), to: parseISO(d.to), value: d.value }));
    },

    addProgram(name) {
      const list = readCustomPrograms();
      const id = "custom-" + Date.now().toString(36);
      list.push({ id, name });
      writeCustomPrograms(list);
      return id;
    },

    removeProgram(id) {
      writeCustomPrograms(readCustomPrograms().filter((p) => p.id !== id));
    },
  };
})();
