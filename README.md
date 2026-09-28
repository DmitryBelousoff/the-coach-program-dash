# The Coach — Program Dashboard

Program Health — панель эффективности программ: метрики в разрезе программ
(Active Users, New Users, Active to New Ratio, Lifetime, Completion Rate, Return Rate, User Satisfaction,
Catalog Pull, Share of Engagement, Sharing, Monetization, Estimated Revenue).

Статический сайт без сборки, деплоится на Vercel как есть.

- `index.html` — интерфейс
- `data.js` — слой данных: берёт живые метрики из `/api/metrics`, а если эндпоинт
  недоступен (локальный запуск, не заданы ключи) или страница открыта с `?demo` —
  показывает демо-данные
- `api/metrics.js` — серверная функция Vercel: читает соответствие Headline → Program
  из Airtable и считает метрики через Amplitude Dashboard REST API

## Живые метрики

| Метрика | Как считается |
|---|---|
| Active Users | Уникальные пользователи с ≥1 `DailyPlanItemOpen`, у которого `title` — один из Headline программы в Airtable, за выбранный период. Пользователь считается один раз на программу и попадает во все программы, контент которых открывал. |

| New Users | Уникальные пользователи, выбравшие в нативном онбординге цель программы (`OnboardingNativeQuestionAnswered.answer`) за период: `BEAT PREMATURE EJACULATION` → last_longer, `BEAT ERECTILE DYSFUNCTION` → keep_it_hard, `IMPROVE SEX SKILLS` → sex_skill_man, `BOOST OVERALL HEALTH` → overall_health. Только английские ответы. |

| Active to New Ratio | Active Users ÷ New Users за тот же период. Чем больше, тем сильнее программа притягивает пользователей сверх тех, кто выбрал её цель в онбординге. Только для программ с целью в онбординге. |
| Return Rate | Из пользователей, у которых первое открытие урока программы (`DailyPlanItemOpen` с `title` из программы и historical count = 1, окно 365 дней) пришлось на период, — доля открывших урок той же программы на следующий день (N-day, день 1). Когорты по дням, учитываются только те, у кого день 1 уже завершён. |

| User Satisfaction | Средняя оценка 1–5 из `CoachLessonRating` (`rating` на Android, `value` на iOS) по урокам программы за период, взвешенная по числу оценок. Урок → программа: `lesson_id` ↔ колонка `id` в Airtable; обе стороны сравниваются без префикса `lesson_`/`exercise_` и без вставки `_video` у видеоуроков (`lessonKey` в `api/metrics.js`). Сентимент отзывов пока не считается. |

| Sharing | Сколько раз делились уроками программы за период: число событий `SharingVideoSent`, урок → программа по `lessonId` так же, как для оценок. |

Правила отбора (`selectPrograms` в `api/metrics.js`):
- Headline → Program собирается из всех таблиц базы, где есть колонки `headline` и `Program`; версии программ (`sex_skill`, `sex_skill_man`, `sex_skill_app`…) показываются отдельно.
- Только мужские программы: код программы или таблица не содержат `for_her`, `woman`, `female`, `menopause`.
- Headline, который встречается в нескольких мужских программах, не учитывается ни в одной — по `title` нельзя понять, из какой программы открыт урок.
- Программы без пользователей в текущем и предыдущем периоде скрываются.
- Кегель (`KegelTrainingOpen`) и испанские заголовки пока не учитываются.

Диагностика: `/api/metrics?debug=mapping` — какие таблицы использованы, какие программы исключены и какие headline общие.

Остальные метрики пока демо и в живом режиме показываются как «—».

## Переменные окружения (Vercel → Settings → Environment Variables)

| Переменная | Что это |
|---|---|
| `AMPLITUDE_API_KEY`, `AMPLITUDE_SECRET_KEY` | ключи проекта «The Coach: for men only» (Amplitude → Settings → Projects) |
| `AIRTABLE_TOKEN` | personal access token Airtable со scope `data.records:read` и `schema.bases:read` на базу «(PROD) The Coach Programs» (`app1k5mFTR9tmsZmO`) |
| `AIRTABLE_TABLE` | необязательно: таблица с уроками. По умолчанию ищется в базе по колонкам `headline` и `Program` (для этого нужен `schema.bases:read`) |
| `AIRTABLE_PROGRAM_FIELD`, `AIRTABLE_HEADLINE_FIELD` | необязательно: названия колонок, если не `Program` и `headline` |

Локальный запуск: `python3 -m http.server` и открыть http://localhost:8000
