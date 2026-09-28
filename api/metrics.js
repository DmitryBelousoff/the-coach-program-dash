// Live metrics for the Program Health dashboard.
//
//   GET /api/metrics?period=week|month|quarter&date=YYYY-MM-DD
//     -> { range, prevRange, source: "amplitude", metrics: ["totalUsers"], programs: [...] }
//   GET /api/metrics?period=…&date=…&history=<programId>&metric=totalUsers&points=11
//     -> { series: [{ from, to, value }] }
//
// Program ↔ content mapping comes from Airtable (Headline → Program). Amplitude's
// DailyPlanItemOpen.title equals the Airtable Headline.
//
// Total Users = unique users with ≥1 DailyPlanItemOpen whose title belongs to the
// program, within the date range. A user counts once per program, and counts for
// every program they touched.
//
// Env: AMPLITUDE_API_KEY, AMPLITUDE_SECRET_KEY, AIRTABLE_TOKEN, AIRTABLE_TABLE
// Optional: AIRTABLE_BASE, AIRTABLE_PROGRAM_FIELD, AIRTABLE_HEADLINE_FIELD, AMPLITUDE_HOST

const AIRTABLE_BASE = process.env.AIRTABLE_BASE || "app1k5mFTR9tmsZmO";
const PROGRAM_FIELD = process.env.AIRTABLE_PROGRAM_FIELD || "Program";
const HEADLINE_FIELD = process.env.AIRTABLE_HEADLINE_FIELD || "Headline";
const AMPLITUDE_HOST = process.env.AMPLITUDE_HOST || "https://amplitude.com"; // EU: https://analytics.eu.amplitude.com

const PERIOD_DAYS = { week: 7, month: 30, quarter: 91 };
const MAX_HISTORY_POINTS = 13;
const AMPLITUDE_CONCURRENCY = 4; // Amplitude allows 5 concurrent Dashboard API requests

// ---------- dates ----------

function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return isNaN(d) ? null : d;
}

function addDays(d, n) {
  return new Date(d.getTime() + n * 86400000);
}

function iso(d) {
  return d.toISOString().slice(0, 10);
}

// Same convention as the UI: the period ends on `date` and spans PERIOD_DAYS days.
function rangeEndingAt(period, to) {
  return { from: addDays(to, -PERIOD_DAYS[period] + 1), to };
}

// ---------- Airtable mapping ----------

function slug(name) {
  return String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// A field may be plain text, a single/multiple select, or a lookup — normalise to strings.
function fieldValues(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.flatMap(fieldValues);
  if (typeof v === "object") return v.name ? [String(v.name)] : [];
  return [String(v)];
}

async function loadMapping() {
  const token = process.env.AIRTABLE_TOKEN;
  const table = process.env.AIRTABLE_TABLE;
  if (!token || !table) throw new Error("AIRTABLE_TOKEN and AIRTABLE_TABLE must be configured");

  const programs = new Map(); // id -> { id, name, headlines: Set }
  let offset;
  do {
    const url = new URL(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(table)}`);
    url.searchParams.append("fields[]", PROGRAM_FIELD);
    url.searchParams.append("fields[]", HEADLINE_FIELD);
    url.searchParams.set("pageSize", "100");
    if (offset) url.searchParams.set("offset", offset);
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`Airtable request failed (${r.status})`);
    const data = await r.json();
    for (const rec of data.records || []) {
      const headlines = fieldValues(rec.fields[HEADLINE_FIELD]).map((s) => s.trim()).filter(Boolean);
      for (const name of fieldValues(rec.fields[PROGRAM_FIELD]).map((s) => s.trim()).filter(Boolean)) {
        const id = slug(name);
        if (!programs.has(id)) programs.set(id, { id, name, headlines: new Set() });
        headlines.forEach((h) => programs.get(id).headlines.add(h));
      }
    }
    offset = data.offset;
  } while (offset);

  return [...programs.values()].filter((p) => p.headlines.size > 0);
}

// ---------- Amplitude ----------

function amplitudeAuth() {
  const key = process.env.AMPLITUDE_API_KEY, secret = process.env.AMPLITUDE_SECRET_KEY;
  if (!key || !secret) throw new Error("AMPLITUDE_API_KEY and AMPLITUDE_SECRET_KEY must be configured");
  return "Basic " + Buffer.from(`${key}:${secret}`).toString("base64");
}

// Unique users over the whole range (deduplicated across days), via Event Segmentation.
async function uniqueUsers(auth, headlines, range) {
  const event = {
    event_type: "DailyPlanItemOpen",
    filters: [{ subprop_type: "event", subprop_key: "title", subprop_op: "is", subprop_value: [...headlines] }],
  };
  const url = new URL(`${AMPLITUDE_HOST}/api/2/events/segmentation`);
  url.searchParams.set("e", JSON.stringify(event));
  url.searchParams.set("m", "uniques");
  url.searchParams.set("start", iso(range.from).replace(/-/g, ""));
  url.searchParams.set("end", iso(range.to).replace(/-/g, ""));
  const r = await fetch(url, { headers: { Authorization: auth } });
  if (!r.ok) throw new Error(`Amplitude request failed (${r.status})`);
  const data = (await r.json()).data || {};
  // seriesCollapsed holds the de-duplicated total for the whole range.
  const collapsed = data.seriesCollapsed && data.seriesCollapsed[0] && data.seriesCollapsed[0][0];
  return collapsed ? collapsed.value : 0;
}

async function pool(tasks, limit) {
  const out = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      out[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return out;
}

// ---------- handler ----------

export default async function handler(req, res) {
  const period = String(req.query.period || "week");
  const date = parseDate(String(req.query.date || ""));
  if (!PERIOD_DAYS[period] || !date) {
    res.status(400).json({ error: "period (week|month|quarter) and date (YYYY-MM-DD) are required" });
    return;
  }

  try {
    const auth = amplitudeAuth();
    const programs = await loadMapping();
    const days = PERIOD_DAYS[period];
    const range = rangeEndingAt(period, date);

    // Past periods don't change; the current one is cached briefly.
    const isPast = date < addDays(new Date(), -1);
    res.setHeader("Cache-Control", isPast ? "s-maxage=86400, stale-while-revalidate=3600" : "s-maxage=900, stale-while-revalidate=300");

    if (req.query.history) {
      const p = programs.find((x) => x.id === String(req.query.history));
      if (!p) { res.status(404).json({ error: "unknown program" }); return; }
      if (String(req.query.metric || "totalUsers") !== "totalUsers") {
        res.status(400).json({ error: "only totalUsers is live so far" });
        return;
      }
      const points = Math.min(Math.max(parseInt(req.query.points, 10) || 11, 2), MAX_HISTORY_POINTS);
      const ranges = Array.from({ length: points }, (_, k) => {
        const shift = (points - 1 - k) * days;
        return { from: addDays(range.from, -shift), to: addDays(range.to, -shift) };
      });
      const values = await pool(ranges.map((r) => () => uniqueUsers(auth, p.headlines, r)), AMPLITUDE_CONCURRENCY);
      res.status(200).json({
        series: ranges.map((r, k) => ({ from: iso(r.from), to: iso(r.to), value: values[k] })),
      });
      return;
    }

    const prevRange = { from: addDays(range.from, -days), to: addDays(range.to, -days) };
    const tasks = programs.flatMap((p) => [
      () => uniqueUsers(auth, p.headlines, range),
      () => uniqueUsers(auth, p.headlines, prevRange),
    ]);
    const values = await pool(tasks, AMPLITUDE_CONCURRENCY);

    res.status(200).json({
      range: { from: iso(range.from), to: iso(range.to) },
      prevRange: { from: iso(prevRange.from), to: iso(prevRange.to) },
      source: "amplitude",
      metrics: ["totalUsers"],
      programs: programs.map((p, i) => ({
        id: p.id,
        name: p.name,
        current: { totalUsers: values[2 * i] },
        previous: { totalUsers: values[2 * i + 1] },
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: e.message });
  }
}
