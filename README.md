# The Coach — Program Dashboard

Program Health — панель эффективности программ: метрики в разрезе программ
(Total Users, Entry Users, Lifetime, Completion Rate, Return Rate, User Satisfaction,
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
| Total Users | Уникальные пользователи с ≥1 `DailyPlanItemOpen`, у которого `title` — один из Headline программы в Airtable, за выбранный период. Пользователь считается один раз на программу и попадает во все программы, контент которых открывал. |

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
