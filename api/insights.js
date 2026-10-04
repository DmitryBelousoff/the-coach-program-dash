// Key insights for the Program Health dashboard.
//
//   GET /api/insights            -> { weeks: [...], insights: [{ type, tone, title, detail, program?, metric?, score }], source }
//   GET /api/insights?debug=history -> the weekly history the insights are built from
//
// Looks for patterns that the table doesn't show at a glance: values that break a
// program's own 12-week norm, multi-week streaks, divergence between metrics,
// lagged relationships, how a program moves relative to the rest, and mismatches
// between programs (e.g. well rated but poorly retained).
//
// History = the last 12 complete calendar weeks (Mon–Sun, UTC), fetched with weekly
// buckets so the whole set costs ~40 Amplitude queries. Statistical detectors find
// and score candidates; if ANTHROPIC_API_KEY is set, Claude picks and phrases the
// top ones from those candidates and the data, otherwise the top-scored are shown.

import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import {
  AMPLITUDE_HOST, DISPLAY_NAMES, ENTRY_GOALS, FIRST_TIME,
  addDays, amplitudeAuth, amplitudeFetch, iso, lessonKey, lessonOpen, loadMapping, parseDate, selectPrograms,
} from "./metrics.js";

export const config = { maxDuration: 60 };

const WEEKS = 12;
const BASELINE_WEEKS = 8; // weeks before the latest one used as the "norm"
const MODEL = "claude-opus-5-5";

// ---------- weekly history ----------

// Monday of the week containing d (UTC).
function mondayOf(d) {
  const day = (d.getUTCDay() + 6) % 7; // Mon = 0
  return addDays(d, -day);
}

function weekRange() {
  const today = parseDate(iso(new Date()));
  const lastMonday = addDays(mondayOf(today), -7); // last complete week starts here
  const from = addDays(lastMonday, -7 * (WEEKS - 1));
  const to = addDays(lastMonday, 6);
  const weeks = Array.from({ length: WEEKS }, (_, i) => iso(addDays(from, 7 * i)));
  return { from, to, weeks };
}

function ymd(d) { return iso(d).replace(/-/g, ""); }

async function segmentation(auth, event, range, { metric = "uniques", interval = 7, limit } = {}) {
  const url = new URL(`${AMPLITUDE_HOST}/api/2/events/segmentation`);
  url.searchParams.set("e", JSON.stringify(event));
  url.searchParams.set("m", metric);
  url.searchParams.set("i", String(interval));
  url.searchParams.set("start", ymd(range.from));
  url.searchParams.set("end", ymd(range.to));
  if (limit) url.searchParams.set("limit", String(limit));
  const r = await amplitudeFetch(url, auth);
  if (!r.ok) throw new Error(`Amplitude request failed (${r.status})${r.headers.get("x-amplitude-error") ? ": " + r.headers.get("x-amplitude-error") : ""}`);
  return (await r.json()).data || {};
}

// Weekly series aligned to `weeks` (Monday ISO dates) from a segmentation response.
function weeklySeries(data, weeks, seriesIndex = 0) {
  const xs = (data.xValues || []).map((x) => String(x).slice(0, 10));
  const values = (data.series && data.series[seriesIndex]) || [];
  return weeks.map((w) => {
    const i = xs.indexOf(w);
    if (i < 0) return null;
    const v = values[i];
    return v == null ? null : (typeof v === "object" ? v.value : v);
  });
}

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
function parseCohortDate(s) {
  const m = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/.exec(s);
  if (m) return new Date(Date.UTC(+m[3], MONTHS[m[1]], +m[2]));
  const d = parseDate(String(s).slice(0, 10));
  return d;
}

// Day-1 return per week: pools the daily cohorts of each week (only complete day 1).
async function weeklyReturn(auth, p, range, weeks) {
  const url = new URL(`${AMPLITUDE_HOST}/api/2/retention`);
  url.searchParams.set("se", JSON.stringify(lessonOpen(p, [FIRST_TIME])));
  url.searchParams.set("re", JSON.stringify(lessonOpen(p)));
  url.searchParams.set("i", "1");
  url.searchParams.set("nthTimeLookbackWindow", "365");
  url.searchParams.set("start", ymd(range.from));
  url.searchParams.set("end", ymd(range.to));
  const r = await amplitudeFetch(url, auth);
  if (!r.ok) throw new Error(`Amplitude retention request failed (${r.status})${r.headers.get("x-amplitude-error") ? ": " + r.headers.get("x-amplitude-error") : ""}`);
  const data = (await r.json()).data || {};
  const values = (data.series && data.series[0] && data.series[0].values) || {};
  const acc = weeks.map(() => ({ returned: 0, cohort: 0 }));
  for (const [date, days] of Object.entries(values)) {
    const d = parseCohortDate(date);
    if (!d) continue;
    const i = weeks.indexOf(iso(mondayOf(d)));
    const d1 = days && days[2]; // [cohort size, day 0, day 1, …]
    if (i < 0 || !d1 || d1.incomplete) continue;
    acc[i].returned += d1.count;
    acc[i].cohort += d1.outof;
  }
  return { rate: acc.map((a) => (a.cohort ? a.returned / a.cohort : null)), cohort: acc.map((a) => a.cohort) };
}

// Per-lesson weekly totals of an event grouped by a lesson-id property. -> Map lessonKey -> number[]
async function weeklyByLesson(auth, event, prop, range, weeks) {
  const data = await segmentation(auth, { ...event, group_by: [{ type: "event", value: prop }] }, range, { metric: "totals", limit: 1000 });
  const out = new Map();
  (data.seriesLabels || []).forEach((label, i) => {
    const key = lessonKey(Array.isArray(label) ? label[label.length - 1] : label);
    const series = weeklySeries(data, weeks, i).map((v) => v || 0);
    const prev = out.get(key);
    out.set(key, prev ? prev.map((v, j) => v + series[j]) : series);
  });
  return out;
}

const sumWeeks = (map, keys, n) => {
  const total = Array(n).fill(0);
  for (const k of keys) { const s = map.get(k); if (s) s.forEach((v, i) => { total[i] += v; }); }
  return total;
};

let historyCache = null; // { at, key, value: Promise }

async function loadHistory() {
  const { from, to, weeks } = weekRange();
  const key = iso(to);
  if (historyCache && historyCache.key === key && Date.now() - historyCache.at < 6 * 3600 * 1000) return historyCache.value;
  const value = (async () => {
    const auth = amplitudeAuth();
    const range = { from, to };
    const { programs } = selectPrograms((await loadMapping()).programs);
    const n = weeks.length;

    // Shared per-lesson queries: ratings (5 scores × 2 platform props) and shares.
    const ratingTasks = [];
    for (const prop of ["rating", "value"]) for (let score = 1; score <= 5; score++) {
      ratingTasks.push(weeklyByLesson(auth, {
        event_type: "CoachLessonRating",
        filters: [{ subprop_type: "event", subprop_key: prop, subprop_op: "is", subprop_value: [String(score)] }],
      }, "lesson_id", range, weeks).then((m) => ({ score, m })));
    }
    const sharesP = weeklyByLesson(auth, { event_type: "SharingVideoSent", filters: [] }, "lessonId", range, weeks);

    const perProgram = programs.map(async (p) => {
      const [active, ret, entry] = await Promise.all([
        segmentation(auth, lessonOpen(p), range).then((d) => weeklySeries(d, weeks)),
        weeklyReturn(auth, p, range, weeks),
        ENTRY_GOALS[p.id]
          ? segmentation(auth, {
              event_type: "OnboardingNativeQuestionAnswered",
              filters: [{ subprop_type: "event", subprop_key: "answer", subprop_op: "is", subprop_value: [ENTRY_GOALS[p.id]] }],
            }, range).then((d) => weeklySeries(d, weeks))
          : null,
      ]);
      return { p, active, ret, entry };
    });

    const [ratings, shares, rows] = await Promise.all([Promise.all(ratingTasks), sharesP, Promise.all(perProgram)]);

    return {
      weeks,
      programs: rows.map(({ p, active, ret, entry }) => {
        const keys = [...p.lessonIds];
        const sum = Array(n).fill(0), cnt = Array(n).fill(0);
        for (const { score, m } of ratings) {
          sumWeeks(m, keys, n).forEach((c, i) => { sum[i] += score * c; cnt[i] += c; });
        }
        return {
          id: p.id,
          name: DISPLAY_NAMES[p.id] || p.name,
          active,
          newUsers: entry,
          returnRate: ret.rate,
          returnCohort: ret.cohort,
          rating: cnt.map((c, i) => (c ? sum[i] / c : null)),
          ratingCount: cnt,
          shares: sumWeeks(shares, keys, n),
        };
      }).filter((p) => p.active.some((v) => v > 0)),
    };
  })();
  historyCache = { at: Date.now(), key, value };
  value.catch(() => { historyCache = null; });
  return value;
}

// ---------- statistics ----------

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
const clean = (a) => a.filter((v) => v != null && isFinite(v));

function pearson(x, y) {
  const pairs = x.map((v, i) => [v, y[i]]).filter(([a, b]) => a != null && b != null);
  if (pairs.length < 6) return null;
  const xs = pairs.map((p) => p[0]), ys = pairs.map((p) => p[1]);
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

// Least-squares slope as % of the mean per week.
function trendPct(a) {
  const pts = a.map((v, i) => [i, v]).filter(([, v]) => v != null);
  if (pts.length < 4) return null;
  const mx = mean(pts.map((p) => p[0])), my = mean(pts.map((p) => p[1]));
  let num = 0, den = 0;
  for (const [x, y] of pts) { num += (x - mx) * (y - my); den += (x - mx) ** 2; }
  return my ? (num / den) / my * 100 : null;
}

const fmtInt = (v) => Math.round(v).toLocaleString("ru-RU");
const fmtPct = (v, d = 1) => (v * 100).toLocaleString("ru-RU", { minimumFractionDigits: d, maximumFractionDigits: d }) + "%";
const fmtNum = (v, d = 2) => v.toLocaleString("ru-RU", { minimumFractionDigits: d, maximumFractionDigits: d });
const signed = (v, d = 0) => (v > 0 ? "+" : "−") + Math.abs(v).toLocaleString("ru-RU", { maximumFractionDigits: d }) + "%";
const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};
const weeksWord = (n) => `${n} ${plural(n, "неделю", "недели", "недель")}`;
const weekLabel = (w) => { const d = parseDate(w); return `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}`; };

const METRICS = {
  active: { label: "Active Users", fmt: fmtInt, minLevel: 100, dashboardKey: "totalUsers" },
  newUsers: { label: "New Users", fmt: fmtInt, minLevel: 50, dashboardKey: "entryUsers" },
  returnRate: { label: "Return Rate", fmt: (v) => fmtPct(v), dashboardKey: "returnRate" },
  rating: { label: "User Satisfaction", fmt: (v) => fmtNum(v), dashboardKey: "rating" },
};

// Masks values with too little data behind them (small cohorts / few ratings).
function reliable(p, metric) {
  const s = p[metric];
  if (!s) return null;
  if (metric === "returnRate") return s.map((v, i) => (p.returnCohort[i] >= 100 ? v : null));
  if (metric === "rating") return s.map((v, i) => (p.ratingCount[i] >= 30 ? v : null));
  return s;
}

function detect(history) {
  const { weeks, programs } = history;
  const last = weeks.length - 1;
  const out = [];
  const add = (c) => out.push(c);

  for (const p of programs) {
    for (const [metric, m] of Object.entries(METRICS)) {
      const s = reliable(p, metric);
      if (!s || s[last] == null) continue;
      if (m.minLevel && s[last] < m.minLevel) continue;
      const base = clean(s.slice(last - BASELINE_WEEKS, last));
      if (base.length < 5) continue;

      // 1. Latest week vs the program's own norm.
      const mu = mean(base), sigma = sd(base);
      const z = sigma ? (s[last] - mu) / sigma : 0;
      const allPrev = clean(s.slice(0, last));
      const isMin = allPrev.length >= 8 && s[last] < Math.min(...allPrev);
      const isMax = allPrev.length >= 8 && s[last] > Math.max(...allPrev);
      if (Math.abs(z) >= 2 || isMin || isMax) {
        const extreme = isMin ? `минимум за ${allPrev.length + 1} недель` : isMax ? `максимум за ${allPrev.length + 1} недель` : (z > 0 ? "заметно выше нормы" : "заметно ниже нормы");
        add({
          type: "Аномалия", tone: z > 0 ? "up" : "down", program: p.id, metric: m.dashboardKey,
          // A record without a strong deviation from the norm is a weaker signal.
          score: (Math.min(Math.abs(z), 4) * 1.6 + (isMin || isMax ? 1.5 : 0)) * (Math.abs(z) >= 2 ? 1 : 0.6),
          title: `${m.label} у ${p.name}: ${extreme}`,
          detail: `Неделя ${weekLabel(weeks[last])}: ${m.fmt(s[last])} при норме ${m.fmt(mu)} (среднее ${base.length} предыдущих недель${Math.abs(z) < 10 ? `, отклонение ${fmtNum(Math.abs(z), 1)}σ` : ""}).`,
        });
      }

      // 2. Streaks of consecutive moves in one direction.
      let k = 0, dir = 0;
      for (let i = last; i > 0 && s[i] != null && s[i - 1] != null; i--) {
        const d = Math.sign(s[i] - s[i - 1]);
        if (!d || (dir && d !== dir)) break;
        dir = d; k++;
      }
      if (k >= 4 && metric !== "rating") {
        const change = s[last - k] ? (s[last] - s[last - k]) / s[last - k] * 100 : 0;
        if (Math.abs(change) >= 8) add({
          type: "Тренд", tone: dir > 0 ? "up" : "down", program: p.id, metric: m.dashboardKey,
          score: k * 0.9 + Math.min(Math.abs(change), 40) / 10,
          title: `${m.label} у ${p.name} ${dir > 0 ? "растёт" : "снижается"} ${weeksWord(k)} подряд`,
          detail: `С недели ${weekLabel(weeks[last - k])} по ${weekLabel(weeks[last])}: ${m.fmt(s[last - k])} → ${m.fmt(s[last])} (${signed(change)}).`,
        });
      }
    }

    // 2b. Rating drifting: last 4 weeks vs the 4 before (or since launch), enough ratings.
    {
      const r = reliable(p, "rating");
      let recent = clean(r.slice(-4)), ref = clean(r.slice(-8, -4));
      if (ref.length < 2) {
        // Young program: compare the second half of its rated weeks with the first.
        const all = clean(r);
        if (all.length >= 4) { const h = Math.floor(all.length / 2); ref = all.slice(0, h); recent = all.slice(h); }
      }
      if (recent.length >= 2 && ref.length >= 2) {
        const d = mean(recent) - mean(ref);
        const firstR = r.findIndex((v) => v != null);
        if (Math.abs(d) >= 0.12) add({
          type: "Тренд", tone: d > 0 ? "up" : "down", program: p.id, metric: "rating",
          score: Math.abs(d) * 22,
          title: `Оценка ${p.name} ${d > 0 ? "растёт" : "снижается"}`,
          detail: `Последние ${weeksWord(recent.length)} в среднем ${fmtNum(mean(recent))} против ${fmtNum(mean(ref))} раньше; неделя ${weekLabel(weeks[last])}: ${r[last] == null ? "мало оценок" : fmtNum(r[last])}${firstR >= 0 && r[firstR] != null ? ` (в первую неделю было ${fmtNum(r[firstR])})` : ""}.`,
        });
      }
    }

    // 2c. New program: launched inside the window and fading after its launch peak.
    {
      const first = p.active.findIndex((v) => v >= 50);
      if (first > 0 && p.active.slice(0, first).every((v) => !v || v < 10) && last - first >= 3) {
        const after = p.active.slice(first);
        const peak = Math.max(...after), peakAt = first + after.indexOf(peak);
        const drop = (p.active[last] - peak) / peak * 100;
        const r = reliable(p, "rating");
        const rFirst = r.slice(first).find((v) => v != null), rLast = r[last];
        if (drop <= -20 && peakAt < last) add({
          type: "Запуск", tone: "down", program: p.id, metric: "totalUsers",
          score: 5 + Math.min(Math.abs(drop), 60) / 10,
          title: `${p.name}: интерес после запуска угасает`,
          detail: `Программа появилась на неделе ${weekLabel(weeks[first])}, пик ${fmtInt(peak)} активных на неделе ${weekLabel(weeks[peakAt])}, сейчас ${fmtInt(p.active[last])} (${signed(drop)})${rFirst != null && rLast != null ? `; оценка за это время ${fmtNum(rFirst)} → ${fmtNum(rLast)}` : ""}.`,
        });
      }
    }

    // 2d. Audience size vs rating within the program: growth that dilutes satisfaction.
    {
      const rAR = pearson(p.active, reliable(p, "rating"));
      const r = clean(reliable(p, "rating"));
      if (rAR != null && rAR <= -0.7 && r.length >= 8) {
        const a = clean(p.active);
        add({
          type: "Корреляция", tone: "down", program: p.id, metric: "rating",
          score: (Math.abs(rAR) - 0.6) * 14,
          title: `${p.name}: чем больше аудитория, тем ниже оценка`,
          detail: `Корреляция Active Users и оценки по неделям r = ${fmtNum(rAR)}: аудитория ${fmtInt(a[0])} → ${fmtInt(a[a.length - 1])}, оценка ${fmtNum(r[0])} → ${fmtNum(r[r.length - 1])}. Новые волны пользователей, похоже, менее довольны контентом, чем первые.`,
        });
      }
    }

    // 3. New Users vs Active Users moving apart (6-week trends).
    if (p.newUsers) {
      const tNew = trendPct(p.newUsers.slice(-6)), tAct = trendPct(p.active.slice(-6));
      if (tNew != null && tAct != null && Math.sign(tNew) !== Math.sign(tAct) && Math.abs(tNew - tAct) >= 4) {
        const story = tNew > 0
          ? "приток растёт, а аудитория программы — нет: новые пользователи доходят до уроков хуже, чем раньше"
          : "приток снижается, а аудитория программы держится или растёт: программу всё больше находят не через онбординг";
        add({
          type: "Расхождение", tone: tNew > 0 ? "down" : "up", program: p.id, metric: "pullRatio",
          score: Math.min(Math.abs(tNew - tAct), 15) / 2 + 2,
          title: `${p.name}: New Users и Active Users идут в разные стороны`,
          detail: `За 6 недель New Users ${signed(tNew, 1)} в неделю, Active Users ${signed(tAct, 1)} в неделю — ${story}.`,
        });
      }

      // 3b. Share of new users who actually reach the lessons: first 4 vs last 4 weeks.
      const ratio = p.active.map((a, i) => (p.newUsers[i] ? a / p.newUsers[i] : null));
      const early = clean(ratio.slice(0, 4)), late = clean(ratio.slice(-4));
      if (early.length >= 3 && late.length >= 3) {
        const ch = (mean(late) - mean(early)) / mean(early) * 100;
        const tNew = trendPct(p.newUsers);
        if (Math.abs(ch) >= 20) add({
          type: "Расхождение", tone: ch > 0 ? "up" : "down", program: p.id, metric: "pullRatio",
          score: Math.min(Math.abs(ch), 50) / 7 + 1.5,
          title: ch < 0
            ? `${p.name}: всё меньше пришедших за этой целью доходят до уроков`
            : `${p.name}: программа собирает всё больше аудитории сверх онбординга`,
          detail: `Active to New Ratio ${fmtNum(mean(early))}× в начале периода и ${fmtNum(mean(late))}× в последние 4 недели (${signed(ch)}) при ${Math.abs(tNew || 0) < 1.5 ? "стабильном" : (tNew > 0 ? "растущем" : "снижающемся")} притоке New Users.`,
        });
      }

      // 4. Lagged relationship: does this week's influx show up in next week's audience?
      const r0 = pearson(p.newUsers, p.active);
      const r1 = pearson(p.newUsers.slice(0, -1), p.active.slice(1));
      if (r1 != null && r1 >= 0.7 && (r0 == null || r1 > r0 + 0.05)) add({
        type: "Корреляция", tone: "info", program: p.id, metric: "totalUsers",
        score: (r1 - 0.6) * 12,
        title: `${p.name}: Active Users повторяют New Users с задержкой в неделю`,
        detail: `Корреляция New Users с Active Users следующей недели r = ${fmtNum(r1)} (в ту же неделю ${r0 == null ? "—" : fmtNum(r0)}). Аудиторию программы во многом определяет приток неделей раньше.`,
      });
      const rNR = pearson(p.newUsers, reliable(p, "returnRate"));
      if (rNR != null && Math.abs(rNR) >= 0.65) add({
        type: "Корреляция", tone: "info", program: p.id, metric: "returnRate",
        score: (Math.abs(rNR) - 0.55) * 12,
        title: `${p.name}: ${rNR < 0 ? "в недели с большим притоком Return Rate ниже" : "Return Rate растёт вместе с притоком"}`,
        detail: `Корреляция New Users и Return Rate по неделям r = ${fmtNum(rNR)}. ${rNR < 0 ? "Новый трафик, вероятно, менее мотивирован, чем аудитория в спокойные недели." : "Вероятно, приток в эти недели был более целевым."}`,
      });
    }
  }

  // 5. A program vs the rest: same direction everywhere means an external cause.
  const actChange = programs
    .filter((p) => p.active[last] >= 100 && p.active[last - 4] >= 100)
    .map((p) => ({ p, ch: (p.active[last] - p.active[last - 4]) / p.active[last - 4] * 100 }));
  if (actChange.length >= 4) {
    const med = [...actChange].map((x) => x.ch).sort((a, b) => a - b)[Math.floor(actChange.length / 2)];
    const sameDir = actChange.filter((x) => Math.sign(x.ch) === Math.sign(med)).length;
    if (sameDir === actChange.length && Math.abs(med) >= 6) add({
      type: "Сравнение", tone: med > 0 ? "up" : "down", metric: "totalUsers",
      score: 4 + Math.min(Math.abs(med), 30) / 10,
      title: `Active Users ${med > 0 ? "растут" : "снижаются"} во всех ${actChange.length} крупных программах сразу`,
      detail: `За 4 недели медиана ${signed(med)}: изменение общее, вероятнее внешняя причина (трафик, сезон, релиз), а не контент отдельных программ.`,
    });
    for (const { p, ch } of actChange) {
      const gap = ch - med;
      if (Math.abs(gap) >= 12) add({
        type: "Сравнение", tone: gap > 0 ? "up" : "down", program: p.id, metric: "totalUsers",
        score: Math.min(Math.abs(gap), 40) / 6 + 1,
        title: `${p.name}: аудитория ${gap > 0 ? "растёт быстрее" : "растёт медленнее"} остальных программ`,
        detail: `Active Users за 4 недели ${signed(ch)} при медиане по программам ${signed(med)} — разница ${Math.abs(Math.round(gap))} п. п.`,
      });
    }
  }

  // 6. Mismatch across programs: rated well but retained poorly (or the opposite).
  const pairs = programs
    .map((p) => {
      const r = clean(reliable(p, "rating").slice(-4)), rr = clean(reliable(p, "returnRate").slice(-4));
      return r.length && rr.length ? { p, rating: mean(r), ret: mean(rr) } : null;
    })
    .filter(Boolean);
  if (pairs.length >= 4) {
    const rank = (arr, key) => { const s = [...arr].sort((a, b) => b[key] - a[key]); return (x) => s.indexOf(x); };
    const rr = rank(pairs, "rating"), rt = rank(pairs, "ret");
    for (const x of pairs) {
      const gap = rt(x) - rr(x);
      if (Math.abs(gap) >= Math.max(3, pairs.length / 2)) add({
        type: "Сравнение", tone: gap > 0 ? "down" : "info", program: x.p.id, metric: "returnRate",
        score: Math.abs(gap) * 1.3,
        title: gap > 0
          ? `${x.p.name}: уроки оценивают высоко, но возвращаются редко`
          : `${x.p.name}: оценки скромные, но возвращаются часто`,
        detail: `За 4 недели оценка ${fmtNum(x.rating)} (${rr(x) + 1}-е место из ${pairs.length}), Return Rate ${fmtPct(x.ret)} (${rt(x) + 1}-е место). ${gap > 0 ? "Контент нравится, но не создаёт привычки — стоит посмотреть на напоминания и следующий шаг после урока." : "Привычку программа формирует, а качество уроков есть куда поднять."}`,
      });
    }
  }

  // When every program moved the same way, single-program volume anomalies in that
  // direction are the same story — keep the shared insight on top, demote the rest.
  const shared = out.find((c) => c.type === "Сравнение" && !c.program);
  if (shared) for (const c of out) {
    if (c.type === "Аномалия" && c.tone === shared.tone && (c.metric === "totalUsers" || c.metric === "entryUsers")) c.score *= 0.45;
  }

  // Highest first, spread across programs and types: first pass takes one insight per
  // program (and at most two per type), the second fills up to five with at most two
  // per program; never two of the same type for one program.
  out.sort((a, b) => b.score - a.score);
  const picked = [], perProgram = {}, perType = {}, seen = new Set();
  const take = (maxPerProgram) => {
    for (const c of out) {
      if (picked.length === 5) return;
      const prog = c.program || "*", key = `${prog}|${c.type}`;
      if (picked.includes(c) || seen.has(key) || (perType[c.type] || 0) >= 2 || (perProgram[prog] || 0) >= maxPerProgram) continue;
      picked.push(c); seen.add(key);
      perType[c.type] = (perType[c.type] || 0) + 1;
      perProgram[prog] = (perProgram[prog] || 0) + 1;
    }
  };
  take(1);
  take(2);
  return { candidates: out, top: picked };
}

// ---------- optional: Claude picks and phrases ----------

const INSIGHT_SCHEMA = {
  type: "object",
  properties: {
    insights: {
      type: "array",
      items: {
        type: "object",
        properties: {
          candidate: { type: "integer", description: "Index of the candidate the insight is based on" },
          title: { type: "string" },
          detail: { type: "string" },
        },
        required: ["candidate", "title", "detail"],
        additionalProperties: false,
      },
    },
  },
  required: ["insights"],
  additionalProperties: false,
};

async function phraseWithClaude(history, candidates) {
  const client = new Anthropic();
  const shortlist = candidates.slice(0, 15);
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: "medium", format: jsonSchemaOutputFormat(INSIGHT_SCHEMA) },
    system: "Ты продуктовый аналитик приложения The Coach. Из кандидатов-закономерностей выбери 3–5 самых полезных для продакт-менеджера: неочевидных по таблице дашборда, с выводом или гипотезой, что делать. Не пересказывай простую динамику неделя к неделе. Используй только цифры из данных. Пиши по-русски: title — одна короткая фраза, detail — 1–2 предложения с цифрами.",
    messages: [{
      role: "user",
      content: `Недели (понедельники): ${history.weeks.join(", ")}\n\nДанные по программам (по неделям):\n${JSON.stringify(history.programs)}\n\nКандидаты:\n${shortlist.map((c, i) => `${i}. [${c.type}] ${c.title} — ${c.detail}`).join("\n")}`,
    }],
  });
  if (response.stop_reason === "refusal" || !response.parsed_output) return null;
  return response.parsed_output.insights
    .filter((i) => shortlist[i.candidate])
    .slice(0, 5)
    .map((i) => ({ ...shortlist[i.candidate], title: i.title, detail: i.detail }));
}

// ---------- handler ----------

export default async function handler(req, res) {
  try {
    const history = await loadHistory();
    if (req.query && req.query.debug === "history") {
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json(history);
      return;
    }
    const { candidates, top } = detect(history);
    let insights = top, source = "rules";
    if (process.env.ANTHROPIC_API_KEY && candidates.length) {
      try {
        const phrased = await phraseWithClaude(history, candidates);
        if (phrased && phrased.length) { insights = phrased; source = "claude"; }
      } catch (e) {
        console.error("Claude phrasing failed, using rule-based insights:", e.message);
      }
    }
    // Weekly history changes once a week; cache at the edge for a few hours.
    res.setHeader("Cache-Control", "s-maxage=21600, stale-while-revalidate=3600");
    res.status(200).json({
      weeks: { from: history.weeks[0], to: iso(addDays(parseDate(history.weeks[history.weeks.length - 1]), 6)), count: history.weeks.length },
      source,
      insights,
    });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: e.message });
  }
}
export { detect };
