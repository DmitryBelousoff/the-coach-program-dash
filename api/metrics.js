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
// Entry Users = unique users who picked the program's goal in the native
// onboarding survey (OnboardingNativeQuestionAnswered.answer) within the date range.
//
// Env: AMPLITUDE_API_KEY, AMPLITUDE_SECRET_KEY, AIRTABLE_TOKEN
// Optional: AIRTABLE_TABLE (otherwise found in the base by its headline/Program columns),
//           AIRTABLE_BASE, AIRTABLE_PROGRAM_FIELD, AIRTABLE_HEADLINE_FIELD, AMPLITUDE_HOST

const AIRTABLE_BASE = process.env.AIRTABLE_BASE || "app1k5mFTR9tmsZmO"; // (PROD) The Coach Programs
const PROGRAM_FIELD = process.env.AIRTABLE_PROGRAM_FIELD || "Program";
const HEADLINE_FIELD = process.env.AIRTABLE_HEADLINE_FIELD || "headline";
const LESSON_ID_FIELD = process.env.AIRTABLE_LESSON_ID_FIELD || "id"; // = lesson_id in Amplitude
const DAY_FIELD = process.env.AIRTABLE_DAY_FIELD || "program day";   // the program's last day = completion
export const AMPLITUDE_HOST = process.env.AMPLITUDE_HOST || "https://amplitude.com"; // EU: https://analytics.eu.amplitude.com

const PERIOD_DAYS = { week: 7, month: 30, quarter: 91 };

// Onboarding goal (answer, as tracked) -> program id (slug of the Airtable Program).
// English answers only for now.
// Display names for program ids (slug of the Airtable Program code); others show the code.
export const DISPLAY_NAMES = {
  "sex-skill-man": "Sex is a skill",
  "navigating-arguments-man": "Solving couple fights",
  "sexting-man": "A man's guide to sexting",
  "last-longer": "Last longer",
  "keep-it-hard": "Keep it hard",
  "kegel-only": "Kegel Challenge",
  "overall-health": "Overall Health",
};

export const ENTRY_GOALS = {
  "last-longer": "BEAT PREMATURE EJACULATION",
  "keep-it-hard": "BEAT ERECTILE DYSFUNCTION",
  "sex-skill-man": "IMPROVE SEX SKILLS",
  "overall-health": "BOOST OVERALL HEALTH",
};
const MAX_HISTORY_POINTS = 13;
export const AMPLITUDE_CONCURRENCY = 5; // Amplitude allows 5 concurrent Dashboard API requests
const AIRTABLE_CONCURRENCY = 4;  // Airtable allows 5 requests/s per base
const MAPPING_TTL_MS = 10 * 60 * 1000;

// ---------- dates ----------

export function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return isNaN(d) ? null : d;
}

export function addDays(d, n) {
  return new Date(d.getTime() + n * 86400000);
}

export function iso(d) {
  return d.toISOString().slice(0, 10);
}

// Same convention as the UI: the period ends on `date` and spans PERIOD_DAYS days.
function rangeEndingAt(period, to) {
  return { from: addDays(to, -PERIOD_DAYS[period] + 1), to };
}

// ---------- Airtable mapping ----------

export function slug(name) {
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
      return { all: [], schemas: [{ table: process.env.AIRTABLE_TABLE, name: process.env.AIRTABLE_TABLE, program: PROGRAM_FIELD, headline: HEADLINE_FIELD, lessonId: LESSON_ID_FIELD }] };
    }
    throw new Error("Set AIRTABLE_TABLE, or give the Airtable token the schema.bases:read scope so the table can be found");
  }
  const wanted = process.env.AIRTABLE_TABLE;
  const schemas = [];
  for (const t of tables) {
    if (wanted && t.id !== wanted && !eq(t.name, wanted)) continue;
    const program = t.fields.find((f) => eq(f.name, PROGRAM_FIELD));
    const headline = t.fields.find((f) => eq(f.name, HEADLINE_FIELD));
    const lessonId = t.fields.find((f) => eq(f.name, LESSON_ID_FIELD));
    const day = t.fields.find((f) => eq(f.name, DAY_FIELD));
    if (!program || !headline) continue;
    const schema = { table: t.id, name: t.name, program: program.name, programType: program.type, headline: headline.name, lessonId: lessonId && lessonId.name, day: day && day.name };
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
// Lesson ids in Amplitude events differ from the Airtable `id` column: the type prefix
// is sometimes dropped ("lesson_x" -> "x") and video lessons get "_video" inserted
// ("lesson_x_sqrt" -> "lesson_x_video_sqrt"). Both sides are compared by this key.
export function lessonKey(id) {
  return String(id).trim().replace(/^(lesson|exercise)_/, "").replace(/_video(?=_|$)/, "");
}

// The mapping changes rarely; a warm function instance reuses it for a while.
let mappingCache = null; // { at, value: Promise }

export function loadMapping() {
  if (mappingCache && Date.now() - mappingCache.at < MAPPING_TTL_MS) return mappingCache.value;
  const value = fetchMapping();
  mappingCache = { at: Date.now(), value };
  value.catch(() => { mappingCache = null; });
  return value;
}

async function fetchMapping() {
  if (!process.env.AIRTABLE_TOKEN) throw new Error("AIRTABLE_TOKEN must be configured");
  const { all, schemas } = await resolveSchemas();
  const programs = new Map();
  const stats = [];

  // Fetch all tables in parallel (bounded), then process them in a stable order.
  const loaded = await pool(schemas.map((schema) => async () => {
    // Linked Program: record id -> program name from the linked table's primary field.
    let linkNames = null;
    if (schema.link) {
      linkNames = new Map();
      for (const rec of await allRecords(schema.link.table, [schema.link.field])) {
        fieldValues(rec.fields[schema.link.field]).forEach((n) => linkNames.set(rec.id, n));
      }
    }
    const fields = [schema.program, schema.headline, ...(schema.lessonId ? [schema.lessonId] : []), ...(schema.day ? [schema.day] : [])];
    return { schema, linkNames, records: await allRecords(schema.table, fields) };
  }), AIRTABLE_CONCURRENCY);

  for (const { schema, linkNames, records } of loaded) {
    const st = { table: schema.name, program: `${schema.program} (${schema.programType || "?"})`, headline: schema.headline, records: 0, noProgram: 0, noHeadline: 0, programs: {} };
    // Last program day of this table (per program): lessons on it mark completion.
    const dayOf = (rec) => {
      const m = schema.day && /\d+/.exec(fieldValues(rec.fields[schema.day]).join(" "));
      return m ? Number(m[0]) : null;
    };
    const lastDay = new Map(); // program name -> max day in this table
    for (const rec of records) {
      const d = dayOf(rec);
      if (d == null) continue;
      for (const v of fieldValues(rec.fields[schema.program])) {
        const n = ((linkNames && linkNames.get(v)) || v).trim();
        if (n && (!lastDay.has(n) || d > lastDay.get(n))) lastDay.set(n, d);
      }
    }
    st.lastDay = Object.fromEntries(lastDay);
    // Plan items that mark reaching the end of the program in this table: headlines of the
    // last day (and, as a fallback, of the day before it) that don't appear on earlier days.
    const daysOf = new Map(); // program name -> headline -> Set of days
    for (const rec of records) {
      const d = dayOf(rec);
      if (d == null) continue;
      const hs = fieldValues(rec.fields[schema.headline]).map((x) => x.trim()).filter(Boolean);
      for (const v of fieldValues(rec.fields[schema.program])) {
        const n = ((linkNames && linkNames.get(v)) || v).trim();
        if (!daysOf.has(n)) daysOf.set(n, new Map());
        for (const h of hs) {
          if (!daysOf.get(n).has(h)) daysOf.get(n).set(h, new Set());
          daysOf.get(n).get(h).add(d);
        }
      }
    }
    const endHeadlines = (name, day) => {
      const out = new Set();
      for (const [h, ds] of daysOf.get(name) || []) if (ds.has(day) && Math.min(...ds) === day) out.add(h);
      return out;
    };
    for (const rec of records) {
      st.records++;
      const headlines = fieldValues(rec.fields[schema.headline]).map((s) => s.trim()).filter(Boolean);
      const lessonIds = (schema.lessonId ? fieldValues(rec.fields[schema.lessonId]) : [])
        .map((s) => s.trim()).filter(Boolean).map(lessonKey);
      const names = fieldValues(rec.fields[schema.program]).map((v) => (linkNames && linkNames.get(v)) || v)
        .map((s) => s.trim()).filter(Boolean);
      if (!headlines.length) st.noHeadline++;
      if (!names.length) st.noProgram++;
      for (const name of names) {
        const id = slug(name);
        if (!programs.has(id)) programs.set(id, { id, name, headlines: new Set(), lessonIds: new Set(), finalLessonIds: new Set(), finalHeadlines: new Set(), penultimateHeadlines: new Set(), tables: new Set(), days: 0 });
        if (lastDay.has(name) && !programs.get(id).tables.has(schema.name)) {
          const pr = programs.get(id), last = lastDay.get(name);
          pr.days = Math.max(pr.days, last);
          endHeadlines(name, last).forEach((h) => pr.finalHeadlines.add(h));
          const before = Math.max(-Infinity, ...[...(daysOf.get(name) || new Map()).values()].flatMap((ds) => [...ds]).filter((x) => x < last));
          if (Number.isFinite(before)) endHeadlines(name, before).forEach((h) => pr.penultimateHeadlines.add(h));
        }
        headlines.forEach((h) => programs.get(id).headlines.add(h));
        lessonIds.forEach((l) => programs.get(id).lessonIds.add(l));
        const d = dayOf(rec);
        if (d != null && d === lastDay.get(name)) lessonIds.forEach((l) => programs.get(id).finalLessonIds.add(l));
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
// Programs for women whose code or tables don't say so.
const FEMALE_PROGRAMS = new Set(["sex_skill_app"]);

// Which programs the dashboard shows, and with which headlines:
//  - men's programs only;
//  - only headlines unique to one program: a lesson shared between programs can't
//    be attributed from DailyPlanItemOpen.title, so it counts for none of them.
export function selectPrograms(all) {
  const excluded = [];
  const male = all.filter((p) => {
    const female = FEMALE_PROGRAMS.has(p.name) || FEMALE.test(p.name) || [...p.tables].some((t) => FEMALE.test(t));
    if (female) excluded.push({ name: p.name, reason: "for women" });
    return !female;
  });
  // Keeps only the values (headlines, lesson ids) that belong to exactly one program.
  const onlyUnique = (key) => {
    const owners = new Map();
    for (const p of male) for (const v of p[key]) owners.set(v, (owners.get(v) || 0) + 1);
    return {
      shared: [...owners].filter(([, n]) => n > 1).map(([v]) => v),
      keep: (p) => new Set([...p[key]].filter((v) => owners.get(v) === 1)),
    };
  };
  const byHeadline = onlyUnique("headlines");
  const byLessonId = onlyUnique("lessonIds");
  const programs = [];
  for (const p of male) {
    const unique = byHeadline.keep(p);
    if (!unique.size) { excluded.push({ name: p.name, reason: "all headlines shared with other programs" }); continue; }
    const lessonIds = byLessonId.keep(p);
    programs.push({
      ...p, headlines: unique, lessonIds,
      finalLessonIds: new Set([...p.finalLessonIds].filter((l) => lessonIds.has(l))),
      // Completion: last-day / day-before plan items unique to this program.
      finalHeadlines: new Set([...p.finalHeadlines].filter((h) => unique.has(h))),
      penultimateHeadlines: new Set([...p.penultimateHeadlines].filter((h) => unique.has(h))),
      sharedDropped: p.headlines.size - unique.size,
    });
  }
  return { programs, excluded, shared: byHeadline.shared };
}

// ---------- Amplitude ----------

// Global limiter: Amplitude caps both the number of concurrent Dashboard API queries
// (5) and their summed cost ("Exceeded concurrent limit with query of cost 415" for an
// 84-day query). Cost grows with the date range, so it is estimated from the query's
// days (~5 units/day observed) and the in-flight total is kept under a budget.
const AMPLITUDE_COST_BUDGET = 900;
let amplitudeActive = 0, amplitudeCost = 0;
const amplitudeQueue = []; // [{ cost, resolve }]

function estimateCost(url) {
  const u = new URL(url);
  const start = parseDate(String(u.searchParams.get("start") || "").replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3"));
  const end = parseDate(String(u.searchParams.get("end") || "").replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3"));
  let days = start && end ? Math.round((end - start) / 86400000) + 1 : 30;
  // Funnels also scan their conversion window after the range.
  const cs = Number(u.searchParams.get("cs"));
  if (cs > 0) days += Math.round(cs / 86400);
  return Math.min(AMPLITUDE_COST_BUDGET, days * 5);
}

function canStart(cost) {
  return amplitudeActive < AMPLITUDE_CONCURRENCY && (amplitudeActive === 0 || amplitudeCost + cost <= AMPLITUDE_COST_BUDGET);
}

function releaseNext() {
  // Start queued queries in order while they fit.
  while (amplitudeQueue.length && canStart(amplitudeQueue[0].cost)) {
    const next = amplitudeQueue.shift();
    amplitudeActive++; amplitudeCost += next.cost;
    next.resolve();
  }
}

export async function amplitudeFetch(url, auth) {
  const cost = estimateCost(url);
  if (amplitudeQueue.length || !canStart(cost)) await new Promise((resolve) => amplitudeQueue.push({ cost, resolve }));
  else { amplitudeActive++; amplitudeCost += cost; }
  try {
    // Amplitude answers 429 when the project's concurrency/cost limit is hit
    // (e.g. several dashboard loads at once): wait and retry a few times.
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(url, { headers: { Authorization: auth } });
      if (r.status !== 429 || attempt >= 3) {
        if (r.status === 429) {
          // Surface Amplitude's explanation (concurrency vs hourly cost limit) in logs and errors.
          const text = await r.text().catch(() => "");
          console.error("Amplitude 429:", text.slice(0, 300));
          return new Response(text, { status: 429, headers: { "x-amplitude-error": text.replace(/\s+/g, " ").slice(0, 200) } });
        }
        return r;
      }
      const retryAfter = Number(r.headers.get("retry-after"));
      const waitMs = retryAfter > 0 ? Math.min(retryAfter * 1000, 10000) : 1500 * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  } finally {
    amplitudeActive--; amplitudeCost -= cost;
    releaseNext();
  }
}

export function amplitudeAuth() {
  const key = process.env.AMPLITUDE_API_KEY, secret = process.env.AMPLITUDE_SECRET_KEY;
  if (!key || !secret) throw new Error("AMPLITUDE_API_KEY and AMPLITUDE_SECRET_KEY must be configured");
  return "Basic " + Buffer.from(`${key}:${secret}`).toString("base64");
}

// Amplitude event definitions per metric; null when the metric has no source for a program.
export function lessonOpen(p, extraFilters = []) {
  return {
    event_type: "DailyPlanItemOpen",
    filters: [{ subprop_type: "event", subprop_key: "title", subprop_op: "is", subprop_value: [...p.headlines] }, ...extraFilters],
  };
}

// "First time" filter (Amplitude's historical count = 1, within a 365-day lookback).
export const FIRST_TIME = { group_type: "User", subprop_type: "nth_time_hack", subprop_key: "nth_time_performed", subprop_op: "is", subprop_value: ["1"] };

// Events that count as engagement for Share of Engagement.
const ENGAGEMENT_EVENTS = ["LessonOpen", "LessonComplete", "DailyPlanItemOpen", "KegelTrainingStart"];

// Kegel workouts aren't in Airtable; their workout_id encodes the program:
// workout_<n>_pe / workout_custom_*_pe_* -> Last longer, *_kegel_only -> Kegel Challenge,
// plain workout_<n> -> Keep it hard (ED), workout_custom_retain -> maintenance_pe. Anything else stays unattributed.
export function kegelProgram(workoutId) {
  if (/_kegel_only(_|$)/.test(workoutId)) return "kegel-only";
  if (/_pe(_|$)/.test(workoutId)) return "last-longer";
  if (/^workout_\d+$/.test(workoutId)) return "keep-it-hard";
  if (workoutId === "workout_custom_retain") return "maintenance-pe";
  return null;
}

// Metrics without a previous-period comparison in the table.
const NO_PREVIOUS = new Set(["shareOfEngagement", "shareOfTraffic"]);

// metric -> (program) -> null (no source for this program) | (auth, range) => Promise<number>
const METRICS = {
  totalUsers: (p) => (auth, range) => uniqueUsers(auth, lessonOpen(p), range),
  entryUsers: (p) => ENTRY_GOALS[p.id]
    ? (auth, range) => uniqueUsers(auth, {
        event_type: "OnboardingNativeQuestionAnswered",
        filters: [{ subprop_type: "event", subprop_key: "answer", subprop_op: "is", subprop_value: [ENTRY_GOALS[p.id]] }],
      }, range)
    : null,
  // Active to New Ratio (pullRatio): Active Users ÷ New Users — how many people the program reaches per
  // user who picked its goal in onboarding. Higher = more interesting beyond its own entrants.
  pullRatio: (p) => ENTRY_GOALS[p.id]
    ? async (auth, range) => {
        const [total, entry] = await Promise.all([METRICS.totalUsers(p)(auth, range), METRICS.entryUsers(p)(auth, range)]);
        return entry ? total / entry : null;
      }
    : null,
  // Return Rate: of users whose first lesson of the program falls in the range,
  // the share who opened a lesson of the same program again the next day.
  returnRate: (p) => (auth, range) => dayOneReturn(auth, lessonOpen(p, [FIRST_TIME]), lessonOpen(p), range),
  // User Satisfaction: average 1–5 lesson rating of the program's lessons in the range
  // (CoachLessonRating: `rating` on Android, `value` on iOS), weighted by number of ratings.
  rating: (p) => p.lessonIds.size ? async (auth, range) => averageRating(await ratingsByLesson(auth, range), p) : null,
  // Number of ratings behind the average (shown next to it).
  ratingCount: (p) => p.lessonIds.size
    ? async (auth, range) => { const byLesson = await ratingsByLesson(auth, range); let n = 0; for (const id of p.lessonIds) n += (byLesson.get(id) || { n: 0 }).n; return n; }
    : null,
  // Share of Engagement: the program's share of all engagement events in the app —
  // LessonOpen + LessonComplete (by lesson_id), DailyPlanItemOpen (by title = headline)
  // and KegelTrainingStart (by workout_id, see kegelProgram). Denominator = every event of
  // these four types in the period, including ones no program can be attributed to.
  shareOfEngagement: (p) => async (auth, range) => {
    const [opens, completes, kegel, planOpens, total] = await Promise.all([
      p.lessonIds.size ? totalsBy(auth, { event_type: "LessonOpen", filters: [] }, "lesson_id", range) : new Map(),
      p.lessonIds.size ? totalsBy(auth, { event_type: "LessonComplete", filters: [] }, "lesson_id", range) : new Map(),
      totalsBy(auth, { event_type: "KegelTrainingStart", filters: [] }, "workout_id", range),
      totalsBy(auth, { event_type: "DailyPlanItemOpen", filters: [] }, "title", range),
      Promise.all(ENGAGEMENT_EVENTS.map((e) => eventTotal(auth, { event_type: e, filters: [] }, range))).then((xs) => xs.reduce((a, x) => a + x, 0)),
    ]);
    let planOwn = 0, kegelOwn = 0;
    for (const h of p.headlines) planOwn += planOpens.rawCounts.get(h) || 0;
    for (const [workoutId, n] of kegel.rawCounts) if (kegelProgram(workoutId) === p.id) kegelOwn += n;
    const own = sumForLessons(opens, p) + sumForLessons(completes, p) + planOwn + kegelOwn;
    return total ? own / total : null;
  },
  // Share of Traffic: the program's share of all New Users — its New Users ÷ the sum of
  // New Users over every program with an onboarding goal (shares add up to 100%).
  shareOfTraffic: (p) => ENTRY_GOALS[p.id]
    ? async (auth, range) => {
        const all = await Promise.all(Object.keys(ENTRY_GOALS).map((id) => METRICS.entryUsers({ id })(auth, range)));
        const total = all.reduce((a, x) => a + x, 0);
        return total ? all[Object.keys(ENTRY_GOALS).indexOf(p.id)] / total : null;
      }
    : null,
  // Sharing: how many times the program's lessons were shared (SharingVideoSent by lessonId).
  shares: (p) => p.lessonIds.size
    ? async (auth, range) => sumForLessons(await totalsBy(auth, { event_type: "SharingVideoSent", filters: [] }, "lessonId", range), p)
    : null,
};
const LIVE_METRICS = Object.keys(METRICS);

// Unique users over the whole range (deduplicated across days), via Event Segmentation.
// Memoized: derived metrics (Active to New Ratio) reuse the same queries as their inputs.
const uniquesMemo = new Map(); // key -> { at, value: Promise }

function uniqueUsers(auth, event, range) {
  const key = JSON.stringify([event, iso(range.from), iso(range.to)]);
  const hit = uniquesMemo.get(key);
  if (hit && Date.now() - hit.at < MAPPING_TTL_MS) return hit.value;
  const value = fetchUniqueUsers(auth, event, range);
  uniquesMemo.set(key, { at: Date.now(), value });
  value.catch(() => uniquesMemo.delete(key));
  return value;
}

async function fetchUniqueUsers(auth, event, range) {
  const url = new URL(`${AMPLITUDE_HOST}/api/2/events/segmentation`);
  url.searchParams.set("e", JSON.stringify(event));
  url.searchParams.set("m", "uniques");
  url.searchParams.set("start", iso(range.from).replace(/-/g, ""));
  url.searchParams.set("end", iso(range.to).replace(/-/g, ""));
  const r = await amplitudeFetch(url, auth);
  if (!r.ok) throw new Error(`Amplitude request failed (${r.status})${r.headers.get("x-amplitude-error") ? ": " + r.headers.get("x-amplitude-error") : ""}`);
  const data = (await r.json()).data || {};
  // seriesCollapsed holds the de-duplicated total for the whole range.
  const collapsed = data.seriesCollapsed && data.seriesCollapsed[0] && data.seriesCollapsed[0][0];
  return collapsed ? collapsed.value : 0;
}

// Counts CoachLessonRating events per score (1–5) for the program's lessons, from both
// the Android (`rating`) and iOS (`value`) properties, and returns the weighted mean.
// Event totals for a range grouped by a lesson-id property, memoized per query:
// the same result serves every program. -> Map lessonKey -> count
export const totalsMemo = new Map(); // key -> { at, value: Promise }

export function totalsBy(auth, event, groupProp, range) {
  const key = JSON.stringify([event, groupProp, iso(range.from), iso(range.to)]);
  const hit = totalsMemo.get(key);
  if (hit && Date.now() - hit.at < MAPPING_TTL_MS) return hit.value;
  const value = (async () => {
    const url = new URL(`${AMPLITUDE_HOST}/api/2/events/segmentation`);
    url.searchParams.set("e", JSON.stringify({ ...event, group_by: [{ type: "event", value: groupProp }] }));
    url.searchParams.set("m", "totals");
    url.searchParams.set("start", iso(range.from).replace(/-/g, ""));
    url.searchParams.set("end", iso(range.to).replace(/-/g, ""));
    url.searchParams.set("limit", "1000");
    const r = await amplitudeFetch(url, auth);
    if (!r.ok) throw new Error(`Amplitude request failed (${r.status})`);
    const data = (await r.json()).data || {};
    const out = new Map();
    out.raw = new Map(); // lessonKey -> Set of the exact lesson ids seen in events
    out.rawCounts = new Map(); // exact id -> count
    (data.seriesLabels || []).forEach((label, i) => {
      const rawId = String(Array.isArray(label) ? label[label.length - 1] : label);
      const v = lessonKey(rawId);
      if (!out.raw.has(v)) out.raw.set(v, new Set());
      out.raw.get(v).add(rawId);
      const cell = data.seriesCollapsed && data.seriesCollapsed[i] && data.seriesCollapsed[i][0];
      out.rawCounts.set(rawId, (out.rawCounts.get(rawId) || 0) + (cell ? cell.value : 0));
      out.set(v, (out.get(v) || 0) + (cell ? cell.value : 0));
    });
    return out;
  })();
  totalsMemo.set(key, { at: Date.now(), value });
  value.catch(() => totalsMemo.delete(key));
  return value;
}

// Total number of events in a range (memoized, shared by all programs).
export function eventTotal(auth, event, range) {
  const key = JSON.stringify(["total", event, iso(range.from), iso(range.to)]);
  const hit = totalsMemo.get(key);
  if (hit && Date.now() - hit.at < MAPPING_TTL_MS) return hit.value;
  const value = (async () => {
    const url = new URL(`${AMPLITUDE_HOST}/api/2/events/segmentation`);
    url.searchParams.set("e", JSON.stringify(event));
    url.searchParams.set("m", "totals");
    url.searchParams.set("start", iso(range.from).replace(/-/g, ""));
    url.searchParams.set("end", iso(range.to).replace(/-/g, ""));
    const r = await amplitudeFetch(url, auth);
    if (!r.ok) throw new Error(`Amplitude request failed (${r.status})`);
    const data = (await r.json()).data || {};
    const cell = data.seriesCollapsed && data.seriesCollapsed[0] && data.seriesCollapsed[0][0];
    return cell ? cell.value : 0;
  })();
  totalsMemo.set(key, { at: Date.now(), value });
  value.catch(() => totalsMemo.delete(key));
  return value;
}

// Rating counts per lesson: one query per score and platform property (5 × 2),
// grouped by lesson_id. -> Map lesson_id -> { sum, n }
async function ratingsByLesson(auth, range) {
  const byLesson = new Map();
  const tasks = [];
  for (const prop of ["rating", "value"]) for (let score = 1; score <= 5; score++) {
    tasks.push(totalsBy(auth, {
      event_type: "CoachLessonRating",
      filters: [{ subprop_type: "event", subprop_key: prop, subprop_op: "is", subprop_value: [String(score)] }],
    }, "lesson_id", range).then((counts) => {
      for (const [lesson, count] of counts) {
        const acc = byLesson.get(lesson) || { sum: 0, n: 0 };
        acc.sum += score * count; acc.n += count;
        byLesson.set(lesson, acc);
      }
    }));
  }
  await Promise.all(tasks);
  return byLesson;
}

// Sum of per-lesson counts over the program's lessons.
function sumForLessons(counts, p) {
  let n = 0;
  for (const id of p.lessonIds) n += counts.get(id) || 0;
  return n;
}

// Weighted mean over the program's lessons; null when nobody rated them.
function averageRating(byLesson, p) {
  let sum = 0, n = 0;
  for (const id of p.lessonIds) {
    const acc = byLesson.get(id);
    if (acc) { sum += acc.sum; n += acc.n; }
  }
  return n ? sum / n : null;
}

// Day-1 (N-day) retention pooled over all daily cohorts in the range whose day 1
// is already complete: Σ returned on day 1 / Σ cohort size. null when no cohort.
async function dayOneReturn(auth, startEvent, returnEvent, range) {
  const url = new URL(`${AMPLITUDE_HOST}/api/2/retention`);
  url.searchParams.set("se", JSON.stringify(startEvent));
  url.searchParams.set("re", JSON.stringify(returnEvent));
  url.searchParams.set("i", "1");
  url.searchParams.set("nthTimeLookbackWindow", "365");
  url.searchParams.set("start", iso(range.from).replace(/-/g, ""));
  url.searchParams.set("end", iso(range.to).replace(/-/g, ""));
  const r = await amplitudeFetch(url, auth);
  if (!r.ok) throw new Error(`Amplitude retention request failed (${r.status})`);
  const data = (await r.json()).data || {};
  const series = (data.series && data.series[0]) || {};
  let returned = 0, cohort = 0;
  // Each cohort's array is [cohort size, day 0, day 1, day 2, …].
  for (const days of Object.values(series.values || {})) {
    const d1 = days && days[2];
    if (!d1 || d1.incomplete) continue;
    returned += d1.count;
    cohort += d1.outof;
  }
  return cohort ? returned / cohort : null;
}

export async function pool(tasks, limit) {
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

// Many Amplitude queries per request (programs × metrics × 2 periods).
export const config = { maxDuration: 60 };

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
          lessonIds: p.lessonIds.size, lessonIdSample: [...p.lessonIds].slice(0, 5),
          finalLessonIds: [...p.finalLessonIds], days: p.days, finalHeadlines: [...p.finalHeadlines], penultimateHeadlines: [...p.penultimateHeadlines],
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

  // Diagnostics: which programs (before and after the shared-value rule) own a lesson id or headline.
  if (req.query.debug === "lookup") {
    try {
      const mapping = await loadMapping();
      const { programs } = selectPrograms(mapping.programs);
      const q = String(req.query.q || "");
      const owners = (list) => list.filter((p) => p.lessonIds.has(lessonKey(q)) || p.headlines.has(q)).map((p) => p.name);
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({ q, allPrograms: owners(mapping.programs), afterRules: owners(programs) });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
    return;
  }

  // Diagnostics: raw Amplitude segmentation for one program's ratings, grouped by `prop`.
  if (req.query.debug === "rating") {
    try {
      const { programs } = selectPrograms((await loadMapping()).programs);
      const p = programs.find((x) => x.id === String(req.query.program || "last-longer"));
      const url = new URL(`${AMPLITUDE_HOST}/api/2/events/segmentation`);
      url.searchParams.set("e", JSON.stringify({
        event_type: "CoachLessonRating",
        filters: [{ subprop_type: "event", subprop_key: "lesson_id", subprop_op: "is", subprop_value: [...p.lessonIds] }],
        group_by: [{ type: "event", value: String(req.query.prop || "value") }],
      }));
      url.searchParams.set("m", "totals");
      url.searchParams.set("start", String(req.query.from).replace(/-/g, ""));
      url.searchParams.set("end", String(req.query.to).replace(/-/g, ""));
      const r = await fetch(url, { headers: { Authorization: amplitudeAuth() } });
      const body = await r.json();
      res.setHeader("Cache-Control", "no-store");
      res.status(r.status).json({ lessonIds: p.lessonIds.size, seriesLabels: body.data && body.data.seriesLabels, seriesCollapsed: body.data && body.data.seriesCollapsed });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
    return;
  }

  // Diagnostics: raw Amplitude retention response for one program (verifies the API contract).
  if (req.query.debug === "retention") {
    try {
      const { programs } = selectPrograms((await loadMapping()).programs);
      const p = programs.find((x) => x.id === String(req.query.program || "last-longer"));
      const range = { from: parseDate(String(req.query.from)), to: parseDate(String(req.query.to)) };
      const url = new URL(`${AMPLITUDE_HOST}/api/2/retention`);
      url.searchParams.set("se", JSON.stringify(lessonOpen(p, req.query.nth === "0" ? [] : [FIRST_TIME])));
      url.searchParams.set("re", JSON.stringify(lessonOpen(p)));
      url.searchParams.set("i", "1");
      url.searchParams.set("nthTimeLookbackWindow", "365");
      url.searchParams.set("start", iso(range.from).replace(/-/g, ""));
      url.searchParams.set("end", iso(range.to).replace(/-/g, ""));
      const r = await fetch(url, { headers: { Authorization: amplitudeAuth() } });
      res.setHeader("Cache-Control", "no-store");
      res.status(r.status).send(await r.text());
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
    return;
  }

  const period = String(req.query.period || "week");
  let date = parseDate(String(req.query.date || ""));
  if (!PERIOD_DAYS[period] || !date) {
    res.status(400).json({ error: "period (week|month|quarter) and date (YYYY-MM-DD) are required" });
    return;
  }

  // Periods end on the last complete day (UTC, the Amplitude project's timezone):
  // a period that includes today would be shorter than the one it's compared with.
  const lastComplete = addDays(parseDate(iso(new Date())), -1);
  const isLatest = date >= lastComplete;
  if (isLatest) date = lastComplete;

  try {
    const auth = amplitudeAuth();
    const { programs } = selectPrograms((await loadMapping()).programs);
    const days = PERIOD_DAYS[period];
    const range = rangeEndingAt(period, date);

    // Older periods don't change; the latest one may still receive late events.
    res.setHeader("Cache-Control", isLatest ? "s-maxage=3600, stale-while-revalidate=600" : "s-maxage=86400, stale-while-revalidate=3600");

    if (req.query.history) {
      const p = programs.find((x) => x.id === String(req.query.history));
      if (!p) { res.status(404).json({ error: "unknown program" }); return; }
      const metric = String(req.query.metric || "totalUsers");
      const compute = METRICS[metric] && METRICS[metric](p);
      if (!compute) { res.status(400).json({ error: `no live data for ${metric} of ${p.id}` }); return; }
      const points = Math.min(Math.max(parseInt(req.query.points, 10) || 11, 2), MAX_HISTORY_POINTS);
      const ranges = Array.from({ length: points }, (_, k) => {
        const shift = (points - 1 - k) * days;
        return { from: addDays(range.from, -shift), to: addDays(range.to, -shift) };
      });
      const values = await pool(ranges.map((r) => () => compute(auth, r)), AMPLITUDE_CONCURRENCY);
      res.status(200).json({
        series: ranges.map((r, k) => ({ from: iso(r.from), to: iso(r.to), value: values[k] })),
      });
      return;
    }

    const prevRange = { from: addDays(range.from, -days), to: addDays(range.to, -days) };
    // One task per program × metric × period; metrics without a source stay null.
    const rows = programs.map((p) => ({ id: p.id, name: DISPLAY_NAMES[p.id] || p.name, code: p.name, current: {}, previous: {} }));
    const tasks = [];
    programs.forEach((p, i) => {
      for (const metric of LIVE_METRICS) {
        const compute = METRICS[metric](p);
        rows[i].current[metric] = rows[i].previous[metric] = null;
        if (!compute) continue;
        tasks.push(async () => { rows[i].current[metric] = await compute(auth, range); });
        if (!NO_PREVIOUS.has(metric)) tasks.push(async () => { rows[i].previous[metric] = await compute(auth, prevRange); });
      }
    });
    await pool(tasks, AMPLITUDE_CONCURRENCY);

    res.status(200).json({
      range: { from: iso(range.from), to: iso(range.to) },
      prevRange: { from: iso(prevRange.from), to: iso(prevRange.to) },
      source: "amplitude",
      metrics: LIVE_METRICS,
      // Programs with no activity in either period are hidden.
      programs: rows.filter((r) => LIVE_METRICS.some((m) => r.current[m] > 0 || r.previous[m] > 0)),
    });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: e.message });
  }
}
