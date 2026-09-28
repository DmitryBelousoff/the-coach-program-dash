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
// Env: AMPLITUDE_API_KEY, AMPLITUDE_SECRET_KEY, AIRTABLE_TOKEN
// Optional: AIRTABLE_TABLE (otherwise found in the base by its headline/Program columns),
//           AIRTABLE_BASE, AIRTABLE_PROGRAM_FIELD, AIRTABLE_HEADLINE_FIELD, AMPLITUDE_HOST

const AIRTABLE_BASE = process.env.AIRTABLE_BASE || "app1k5mFTR9tmsZmO"; // (PROD) The Coach Programs
const PROGRAM_FIELD = process.env.AIRTABLE_PROGRAM_FIELD || "Program";
const HEADLINE_FIELD = process.env.AIRTABLE_HEADLINE_FIELD || "headline";
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

async function airtable(path, params = []) {
  const url = new URL(`https://api.airtable.com/v0/${path}`);
  for (const [k, v] of params) url.searchParams.append(k, v);
  const r = await fetch(url, { headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` } });
  if (!r.ok) throw new Error(`Airtable request failed (${r.status}) for ${url.pathname}`);
  return r.json();
}

async function allRecords(table, fields) {
  const out = [];
  let offset;
  do {
    const params = [...fields.map((f) => ["fields[]", f]), ["pageSize", "100"]];
    if (offset) params.push(["offset", offset]);
    const data = await airtable(`${AIRTABLE_BASE}/${encodeURIComponent(table)}`, params);
    out.push(...(data.records || []));
    offset = data.offset;
  } while (offset);
  return out;
}

const eq = (a, b) => a.toLowerCase() === b.toLowerCase();

// Finds every table in the base that has both columns (or the one named in
// AIRTABLE_TABLE) via the Meta API, which needs the schema.bases:read scope.
// If Program is a link to another table, also says how to turn linked record ids
// into program names.
async function resolveSchemas() {
  let tables;
  try {
    tables = (await airtable(`meta/bases/${AIRTABLE_BASE}/tables`)).tables || [];
  } catch (e) {
    if (process.env.AIRTABLE_TABLE) {
      return { all: [], schemas: [{ table: process.env.AIRTABLE_TABLE, name: process.env.AIRTABLE_TABLE, program: PROGRAM_FIELD, headline: HEADLINE_FIELD }] };
    }
    throw new Error("Set AIRTABLE_TABLE, or give the Airtable token the schema.bases:read scope so the table can be found");
  }
  const wanted = process.env.AIRTABLE_TABLE;
  const schemas = [];
  for (const t of tables) {
    if (wanted && t.id !== wanted && !eq(t.name, wanted)) continue;
    const program = t.fields.find((f) => eq(f.name, PROGRAM_FIELD));
    const headline = t.fields.find((f) => eq(f.name, HEADLINE_FIELD));
    if (!program || !headline) continue;
    const schema = { table: t.id, name: t.name, program: program.name, programType: program.type, headline: headline.name };
    if (program.type === "multipleRecordLinks") {
      const linked = tables.find((x) => x.id === program.options.linkedTableId);
      const primary = linked && linked.fields.find((f) => f.id === linked.primaryFieldId);
      if (linked && primary) schema.link = { table: linked.id, field: primary.name };
    }
    schemas.push(schema);
  }
  if (!schemas.length) throw new Error(`No Airtable table with "${PROGRAM_FIELD}" and "${HEADLINE_FIELD}" columns`);
  return { all: tables.map((t) => ({ name: t.name, fields: t.fields.map((f) => `${f.name} (${f.type})`) })), schemas };
}

// Returns programs [{ id, name, headlines: Set }] plus stats for ?debug=mapping.
async function loadMapping() {
  if (!process.env.AIRTABLE_TOKEN) throw new Error("AIRTABLE_TOKEN must be configured");
  const { all, schemas } = await resolveSchemas();
  const programs = new Map();
  const stats = [];

  for (const schema of schemas) {
    // Linked Program: record id -> program name from the linked table's primary field.
    let linkNames = null;
    if (schema.link) {
      linkNames = new Map();
      for (const rec of await allRecords(schema.link.table, [schema.link.field])) {
        fieldValues(rec.fields[schema.link.field]).forEach((n) => linkNames.set(rec.id, n));
      }
    }
    const st = { table: schema.name, program: `${schema.program} (${schema.programType || "?"})`, headline: schema.headline, records: 0, noProgram: 0, noHeadline: 0, programs: {} };
    for (const rec of await allRecords(schema.table, [schema.program, schema.headline])) {
      st.records++;
      const headlines = fieldValues(rec.fields[schema.headline]).map((s) => s.trim()).filter(Boolean);
      const names = fieldValues(rec.fields[schema.program]).map((v) => (linkNames && linkNames.get(v)) || v)
        .map((s) => s.trim()).filter(Boolean);
      if (!headlines.length) st.noHeadline++;
      if (!names.length) st.noProgram++;
      for (const name of names) {
        const id = slug(name);
        if (!programs.has(id)) programs.set(id, { id, name, headlines: new Set(), tables: new Set() });
        headlines.forEach((h) => programs.get(id).headlines.add(h));
        programs.get(id).tables.add(schema.name);
        st.programs[name] = (st.programs[name] || 0) + 1;
      }
    }
    stats.push(st);
  }

  return { programs: [...programs.values()].filter((p) => p.headlines.size > 0), stats, tables: all };
}

// The Amplitude project is the men's app, so programs for women are left out
// (matched by program code or by the name of any table they come from).
const FEMALE = /for_?her|woman|female|menopause/i;

// Which programs the dashboard shows, and with which headlines:
//  - men's programs only;
//  - only headlines unique to one program: a lesson shared between programs can't
//    be attributed from DailyPlanItemOpen.title, so it counts for none of them.
function selectPrograms(all) {
  const excluded = [];
  const male = all.filter((p) => {
    const female = FEMALE.test(p.name) || [...p.tables].some((t) => FEMALE.test(t));
    if (female) excluded.push({ name: p.name, reason: "for women" });
    return !female;
  });
  const owners = new Map();
  for (const p of male) for (const h of p.headlines) owners.set(h, (owners.get(h) || 0) + 1);
  const shared = [...owners].filter(([, n]) => n > 1).map(([h]) => h);
  const programs = [];
  for (const p of male) {
    const unique = new Set([...p.headlines].filter((h) => owners.get(h) === 1));
    if (!unique.size) { excluded.push({ name: p.name, reason: "all headlines shared with other programs" }); continue; }
    programs.push({ ...p, headlines: unique, sharedDropped: p.headlines.size - unique.size });
  }
  return { programs, excluded, shared };
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
  // Diagnostics: which Airtable tables/columns were used and what programs they yield.
  if (req.query.debug === "mapping") {
    try {
      const mapping = await loadMapping();
      const { programs, excluded, shared } = selectPrograms(mapping.programs);
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({
        base: AIRTABLE_BASE,
        used: mapping.stats,
        programs: programs.map((p) => ({
          id: p.id, name: p.name, tables: [...p.tables],
          headlines: p.headlines.size, sharedDropped: p.sharedDropped, sample: [...p.headlines].slice(0, 5),
        })),
        excluded,
        // Headlines in more than one men's program; not counted for any of them.
        shared,
        allTables: mapping.tables,
      });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
    return;
  }

  const period = String(req.query.period || "week");
  const date = parseDate(String(req.query.date || ""));
  if (!PERIOD_DAYS[period] || !date) {
    res.status(400).json({ error: "period (week|month|quarter) and date (YYYY-MM-DD) are required" });
    return;
  }

  try {
    const auth = amplitudeAuth();
    const { programs } = selectPrograms((await loadMapping()).programs);
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
      // Programs with no activity in either period are hidden.
      programs: programs.map((p, i) => ({
        id: p.id,
        name: p.name,
        current: { totalUsers: values[2 * i] },
        previous: { totalUsers: values[2 * i + 1] },
      })).filter((p) => p.current.totalUsers > 0 || p.previous.totalUsers > 0),
    });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: e.message });
  }
}
