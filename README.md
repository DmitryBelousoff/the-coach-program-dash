# The Coach — Program Dashboard

Program Health — панель эффективности программ: метрики в разрезе программ
(Total Users, Entry Users, Lifetime, Completion Rate, Return Rate, User Satisfaction,
Catalog Pull, Share of Engagement, Sharing, Monetization, Estimated Revenue).

Статический сайт без сборки, деплоится на Vercel как есть.

- `index.html` — интерфейс
- `data.js` — слой данных. Сейчас генерирует демо-данные; следующим шагом
  будет заменён на запрос к серверному эндпоинту с данными из Amplitude.

Локальный запуск: `python3 -m http.server` и открыть http://localhost:8000
