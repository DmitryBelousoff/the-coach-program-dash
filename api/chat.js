// Analytics chat for the Program Health dashboard.
//
//   POST /api/chat  { messages: [{ role: "user"|"assistant", content: string }], context?: { period, date } }
//     -> { reply: string }
//
// Claude answers questions about program metrics. Numbers come only from tools that
// run the same calculations as the dashboard (api/metrics.js), never from the model.
//
// Env: ANTHROPIC_API_KEY (plus everything api/metrics.js needs).

import Anthropic from "@anthropic-ai/sdk";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import metricsHandler from "./metrics.js";

export const config = { maxDuration: 60 };

const MODEL = "claude-opus-5-5";
const MAX_TURNS = 20;           // conversation turns kept from the client
const MAX_MESSAGE_CHARS = 4000; // per message

const SYSTEM = `Ты — аналитик продукта The Coach (мужское приложение, проект Amplitude «The Coach: for men only»). Отвечаешь на вопросы о дашборде «Панель эффективности программ» на языке вопроса (обычно русский).

## Как отвечать
- Все цифры бери только из инструментов get_program_metrics и get_metric_history. Не придумывай и не экстраполируй значения. Если данных нет — так и скажи.
- Всегда называй период явно (даты, UTC). Период заканчивается последним полным днём; предыдущий период — той же длины прямо перед ним.
- Для относительных метрик показывай рядом абсолютные (Active Users, число оценок). Предупреждай о малых выборках: меньше ~30 оценок или маленькая когорта Return Rate — шумно.
- Отвечай коротко и по делу: сначала вывод, потом цифры. Таблицы — в Markdown, когда сравниваешь несколько программ.
- Если вопрос не про эти данные (другие события Amplitude, выручка, реклама) — скажи, что в дашборде этого нет.

## Метрики (ключи API → названия в таблице)
- totalUsers → Active Users: уникальные пользователи с ≥1 DailyPlanItemOpen, у которого title — headline урока программы (Airtable), за период.
- entryUsers → New Users: уникальные пользователи, выбравшие цель программы в онбординге (OnboardingNativeQuestionAnswered.answer) за период. Есть только у Last longer (BEAT PREMATURE EJACULATION), Keep it hard (BEAT ERECTILE DYSFUNCTION), Sex is a skill (IMPROVE SEX SKILLS), Overall Health (BOOST OVERALL HEALTH). Только английские ответы.
- pullRatio → Active to New Ratio: Active Users ÷ New Users. Чем больше, тем сильнее программа притягивает пользователей сверх выбравших её цель.
- returnRate → Return Rate: из впервые открывших урок программы в периоде (historical count = 1) — доля открывших урок той же программы на следующий день. Когорты с незавершённым днём 1 не учитываются.
- rating → User Satisfaction: средняя оценка 1–5 из CoachLessonRating по урокам программы; ratingCount — число оценок.
- shares → Sharing: число SharingVideoSent по урокам программы.
- shareOfEngagement → Share of Engagement: доля программы во всех событиях вовлечения приложения за период: LessonOpen и LessonComplete её уроков, DailyPlanItemOpen её пунктов плана, KegelTrainingStart её тренировок (workout_id *_pe → Last longer, *_kegel_only → Kegel Challenge, workout_N → Keep it hard, workout_custom_retain → maintenance_pe) ÷ все такие события. Предыдущий период для неё не считается (previous = null) — для динамики используй get_metric_history.
- shareOfTraffic → Share of Traffic: доля программы во всех New Users — её New Users ÷ сумма New Users всех программ с целью в онбординге (Last longer, Keep it hard, Sex is a skill, Overall Health). Предыдущий период не считается — для динамики используй get_metric_history.
- Completion Rate (в таблице, не в инструментах): из вошедших в программу (первый CurrentDay с её program_id) — доля дошедших до последнего дня (CurrentDay с day = последний «program day» из Airtable) за длину программы + 50% (ceil(дни × 1,5): 60 дней → 90, 70 → 105). Когорта — выбранный период, сдвинутый назад на это окно; меньше 30 человек — «not enough data».
- Catalog Pull (в таблице): сколько других программ в среднем начали за 14 дней выбравшие цель программы в онбординге (≥1 DailyPlanItemOpen другой программы). Когорта — выбранный период, сдвинутый на 14 дней назад.
- Health score (кольцо у названия) — предварительный, считается в браузере: Return Rate 40% (30% = 100), User Satisfaction 33% (3,5→0, 5,0→100, от 30 оценок), Active to New Ratio 27% (5× = 100); нет составляющей — веса перераспределяются. Sharing не входит (шерятся только уроки Sex is a skill).
- Lifetime, Monetization, Estimated Revenue — ещё не подключены.

## Ограничения данных
- Уроки с одинаковым headline/lesson_id в нескольких программах не учитываются ни в одной (нельзя понять, из какой программы открыт урок). Сильнее всего это занижает Keep it hard, Kegel Challenge и пары версий Sex is a skill.
- Женские программы (for her, sex_skill_app и т. п.) исключены. Кегель-тренировки (KegelTrainingOpen) и испанские заголовки пока не учитываются.

## Программы (id → название)
last-longer → Last longer; keep-it-hard → Keep it hard; sex-skill-man → Sex is a skill; overall-health → Overall Health; sexting-man → A man's guide to sexting; navigating-arguments-man → Solving couple fights; kegel-only → Kegel Challenge. Остальные показываются кодом из Airtable.`;

// Runs api/metrics.js in-process with a fake req/res; returns parsed JSON or throws.
async function callMetrics(query) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      setHeader() {},
      json(body) {
        if (this.statusCode >= 400) reject(new Error(body && body.error ? body.error : `metrics error ${this.statusCode}`));
        else resolve(body);
      },
      send(body) { this.json(typeof body === "string" ? JSON.parse(body) : body); },
    };
    Promise.resolve(metricsHandler({ query }, res)).catch(reject);
  });
}

const PERIOD = { type: "string", enum: ["week", "month", "quarter"], description: "Длина периода: 7, 30 или 91 день" };
const END_DATE = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Последний день периода, YYYY-MM-DD (UTC). Не позже вчерашнего дня; более поздняя дата сдвигается на вчера." };

const tools = [
  betaTool({
    name: "get_program_metrics",
    description: "Все подключённые метрики по каждой программе за период и за предыдущий период той же длины. Возвращает range, prevRange и programs[{ id, name, current, previous }]. Запрос может занять 20–30 секунд.",
    inputSchema: {
      type: "object",
      properties: { period: PERIOD, end_date: END_DATE },
      required: ["period", "end_date"],
      additionalProperties: false,
    },
    run: async ({ period, end_date }) => {
      try {
        const data = await callMetrics({ period, date: end_date });
        return JSON.stringify(data);
      } catch (e) {
        return `Ошибка: ${e.message}`;
      }
    },
  }),
  betaTool({
    name: "get_metric_history",
    description: "Динамика одной метрики одной программы: значения за несколько последовательных периодов, заканчивая выбранным. Используй для трендов («как менялось», «за последние N недель»).",
    inputSchema: {
      type: "object",
      properties: {
        program_id: { type: "string", description: "id программы, например last-longer" },
        metric: { type: "string", enum: ["totalUsers", "entryUsers", "pullRatio", "returnRate", "rating", "ratingCount", "shares", "shareOfEngagement", "shareOfTraffic"] },
        period: PERIOD,
        end_date: END_DATE,
        points: { type: "integer", minimum: 2, maximum: 13, description: "Сколько периодов вернуть" },
      },
      required: ["program_id", "metric", "period", "end_date", "points"],
      additionalProperties: false,
    },
    run: async ({ program_id, metric, period, end_date, points }) => {
      try {
        const data = await callMetrics({ period, date: end_date, history: program_id, metric, points: String(points) });
        return JSON.stringify(data);
      } catch (e) {
        return `Ошибка: ${e.message}`;
      }
    },
  }),
];

function cleanMessages(raw) {
  if (!Array.isArray(raw)) return null;
  const msgs = raw
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) }))
    .slice(-MAX_TURNS);
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return null;
  return msgs;
}

function yesterdayUTC() {
  return new Date(Date.now() - 86400000).toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  if (!process.env.ANTHROPIC_API_KEY) { res.status(500).json({ error: "ANTHROPIC_API_KEY is not configured" }); return; }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const messages = cleanMessages(body.messages);
  if (!messages) { res.status(400).json({ error: "messages must end with a user message" }); return; }

  // What the user is looking at goes into the latest turn (keeps the system prompt cacheable).
  const ctx = body.context || {};
  const last = messages[messages.length - 1];
  last.content =
    `[Контекст: сегодня ${new Date().toISOString().slice(0, 10)}, последний полный день ${yesterdayUTC()}. ` +
    `На дашборде выбран период «${ctx.period || "week"}» до ${ctx.date || yesterdayUTC()}.]\n\n` + last.content;

  try {
    const client = new Anthropic();
    const runner = client.beta.messages.toolRunner({
      model: MODEL,
      max_tokens: 16000,
      max_iterations: 6,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      tools,
      messages,
    });
    const final = await runner.runUntilDone();

    if (final.stop_reason === "refusal") {
      res.status(200).json({ reply: "Не могу ответить на этот вопрос. Попробуйте переформулировать." });
      return;
    }
    const reply = final.content.filter((b) => b.type === "text").map((b) => b.text).join("\n\n").trim();
    res.status(200).json({ reply: reply || "Не получилось сформировать ответ — попробуйте ещё раз." });
  } catch (e) {
    console.error(e);
    if (e instanceof Anthropic.RateLimitError) res.status(429).json({ error: "Слишком много запросов, попробуйте через минуту" });
    else if (e instanceof Anthropic.APIError) res.status(502).json({ error: `Claude API: ${e.status} ${e.message}` });
    else res.status(500).json({ error: e.message });
  }
}
