// Cohort metrics that need 60 days to mature: Completion Rate and Catalog Pull.
//
//   GET /api/cohorts?period=week|month|quarter&date=YYYY-MM-DD
//     -> { cohort: { from, to }, windowDays: 60, metrics: [...], programs: [{ id, current: {...}, notes: {...} }] }
//   GET /api/cohorts?...&debug=funnel&program=<id>   -> raw Amplitude funnel response (contract check)
//
// Both follow users for 60 days, so the cohort is the selected period shifted 60 days
// back: everyone in it has had the full 60 days. A cohort under MIN_COHORT users (e.g. a
// program released less than 60 days ago) gets the note "not enough data".
//
// Completion Rate: of users who opened their first lesson of the program in the cohort
//   window, the share who completed (LessonComplete) a lesson of the program's last day
//   (Airtable `program day`) within 60 days.
// Catalog Pull: of users who picked the program's goal in onboarding in the cohort window,
//   the average number of OTHER programs they started (≥1 DailyPlanItemOpen of that
//   program) within 60 days = Σ over other programs of the share who started it.

import {
  AMPLITUDE_HOST, DISPLAY_NAMES, ENTRY_GOALS, FIRST_TIME,
  addDays, amplitudeAuth, amplitudeFetch, iso, lessonOpen, loadMapping, parseDate, selectPrograms, totalsBy,
} from "./metrics.js";

export const config = { maxDuration: 60 };

const WINDOW_DAYS = 60;
const MIN_COHORT = 30;
const MIN_TARGET_USERS = 30; // other programs smaller than this are ignored for Catalog Pull
const PERIOD_DAYS = { week: 7, month: 30, quarter: 91 };
const NOT_ENOUGH = "not enough data";

const ymd = (d) => iso(d).replace(/-/g, "");

// Ordered 2-step funnel, users counted in the first step's date range, converting
// within WINDOW_DAYS. -> { entered, converted }
async function funnel(auth, step1, step2, range) {
  const url = new URL(`${AMPLITUDE_HOST}/api/2/funnels`);
  url.searchParams.append("e", JSON.stringify(step1));
  url.searchParams.append("e", JSON.stringify(step2));
  url.searchParams.set("start", ymd(range.from));
  url.searchParams.set("end", ymd(range.to));
  url.searchParams.set("mode", "ordered");
  url.searchParams.set("n", "active");
  url.searchParams.set("cs", String(WINDOW_DAYS * 86400));
  url.searchParams.set("nthTimeLookbackWindow", "365");
  const r = await amplitudeFetch(url, auth);
  if (!r.ok) throw new Error(`Amplitude funnel request failed (${r.status})${r.headers.get("x-amplitude-error") ? ": " + r.headers.get("x-amplitude-error") : ""}`);
  const body = await r.json();
  const d = Array.isArray(body.data) ? body.data[0] : body.data;
  const steps = (d && (d.cumulativeRaw || d.cumulative)) || [];
  return { entered: steps[0] || 0, converted: steps[1] || 0 };
}

// Unique users with ≥1 event in a range (to skip tiny programs as Catalog Pull targets).
async function uniques(auth, event, range) {
  const url = new URL(`${AMPLITUDE_HOST}/api/2/events/segmentation`);
  url.searchParams.set("e", JSON.stringify(event));
  url.searchParams.set("m", "uniques");
  url.searchParams.set("start", ymd(range.from));
  url.searchParams.set("end", ymd(range.to));
  const r = await amplitudeFetch(url, auth);
  if (!r.ok) throw new Error(`Amplitude request failed (${r.status})`);
  const data = (await r.json()).data || {};
  const cell = data.seriesCollapsed && data.seriesCollapsed[0] && data.seriesCollapsed[0][0];
  return cell ? cell.value : 0;
}

function goalEvent(programId) {
  return {
    event_type: "OnboardingNativeQuestionAnswered",
    filters: [{ subprop_type: "event", subprop_key: "answer", subprop_op: "is", subprop_value: [ENTRY_GOALS[programId]] }],
  };
}

const memo = new Map(); // cache key -> { at, value: Promise }
const TTL = 6 * 3600 * 1000;

async function compute(period, date) {
  const auth = amplitudeAuth();
  const { programs } = selectPrograms((await loadMapping()).programs);
  const days = PERIOD_DAYS[period];
  const cohortTo = addDays(date, -WINDOW_DAYS);
  const cohort = { from: addDays(cohortTo, -days + 1), to: cohortTo };
  const followUp = { from: cohort.from, to: date }; // cohort + its 60 days

  // Exact lesson ids of LessonComplete events (they differ from Airtable ids by prefix/_video).
  const lessonIds = await totalsBy(auth, { event_type: "LessonComplete", filters: [] }, "lesson_id", followUp);
  const rawIds = (keys) => [...keys].flatMap((k) => [...(lessonIds.raw.get(k) || [])]);

  // Programs active enough to count as "started" targets for Catalog Pull.
  const targets = [];
  await Promise.all(programs.map(async (p) => {
    if ((await uniques(auth, lessonOpen(p), followUp)) >= MIN_TARGET_USERS) targets.push(p);
  }));

  const rows = await Promise.all(programs.map(async (p) => {
    const current = { completionRate: null, catalogPull: null };
    const notes = {};

    // Completion Rate
    const finals = rawIds(p.finalLessonIds);
    if (finals.length) {
      const f = await funnel(auth, lessonOpen(p, [FIRST_TIME]), {
        event_type: "LessonComplete",
        filters: [{ subprop_type: "event", subprop_key: "lesson_id", subprop_op: "is", subprop_value: finals }],
      }, cohort);
      if (f.entered >= MIN_COHORT) current.completionRate = f.converted / f.entered;
      else notes.completionRate = NOT_ENOUGH;
      current.completionCohort = f.entered;
    } else if (p.finalLessonIds.size) {
      // Final lessons exist in Airtable but nobody completed any of them in the window.
      notes.completionRate = NOT_ENOUGH;
    }

    // Catalog Pull (only programs with an onboarding goal)
    if (ENTRY_GOALS[p.id]) {
      const others = targets.filter((t) => t.id !== p.id);
      const results = await Promise.all(others.map((t) => funnel(auth, goalEvent(p.id), lessonOpen(t), cohort)));
      const entered = Math.max(0, ...results.map((x) => x.entered));
      if (entered >= MIN_COHORT) {
        current.catalogPull = results.reduce((a, x) => a + (x.entered ? x.converted / x.entered : 0), 0);
        current.catalogCohort = entered;
        current.catalogBreakdown = Object.fromEntries(others.map((t, i) => [t.id, results[i].entered ? results[i].converted / results[i].entered : 0]));
      } else notes.catalogPull = NOT_ENOUGH;
    }

    return { id: p.id, name: DISPLAY_NAMES[p.id] || p.name, current, notes };
  }));

  return {
    cohort: { from: iso(cohort.from), to: iso(cohort.to) },
    windowDays: WINDOW_DAYS,
    metrics: ["completionRate", "catalogPull"],
    programs: rows,
  };
}

export default async function handler(req, res) {
  const period = String(req.query.period || "week");
  let date = parseDate(String(req.query.date || ""));
  if (!PERIOD_DAYS[period] || !date) {
    res.status(400).json({ error: "period (week|month|quarter) and date (YYYY-MM-DD) are required" });
    return;
  }
  const lastComplete = addDays(parseDate(iso(new Date())), -1);
  if (date > lastComplete) date = lastComplete;

  try {
    if (req.query.debug === "funnel") {
      const { programs } = selectPrograms((await loadMapping()).programs);
      const p = programs.find((x) => x.id === String(req.query.program || "last-longer"));
      const cohortTo = addDays(date, -WINDOW_DAYS);
      const url = new URL(`${AMPLITUDE_HOST}/api/2/funnels`);
      url.searchParams.append("e", JSON.stringify(goalEvent(p.id)));
      url.searchParams.append("e", JSON.stringify(lessonOpen(p)));
      url.searchParams.set("start", ymd(addDays(cohortTo, -6)));
      url.searchParams.set("end", ymd(cohortTo));
      url.searchParams.set("mode", "ordered");
      url.searchParams.set("n", "active");
      url.searchParams.set("cs", String(WINDOW_DAYS * 86400));
      const r = await amplitudeFetch(url, amplitudeAuth());
      res.setHeader("Cache-Control", "no-store");
      res.status(r.status).send(await r.text());
      return;
    }

    const key = `${period}|${iso(date)}`;
    let hit = memo.get(key);
    if (!hit || Date.now() - hit.at > TTL) {
      hit = { at: Date.now(), value: compute(period, date) };
      memo.set(key, hit);
      hit.value.catch(() => memo.delete(key));
    }
    // Closed cohorts don't change; cache at the edge for a day.
    res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=3600");
    res.status(200).json(await hit.value);
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: e.message });
  }
}
