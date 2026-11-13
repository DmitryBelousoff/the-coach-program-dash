# Program Health: как устроен дашборд

Справочник для тех, кто поддерживает дашборд: откуда берутся данные, как считается каждая метрика, какие допущения и упрощения мы приняли и почему. Состояние на ноябрь 2026.

- Сайт: https://the-coach-program-dash.vercel.app (открыт без входа)
- Код: GitHub `DmitryBelousoff/the-coach-program-dash`, рабочая ветка `claude/program-dashboard`. В `main` не пушим.
- Хостинг: Vercel, проект `the-coach-program-dash`. Production branch = `claude/program-dashboard`: любой push в неё сразу выкатывается на сайт.

---

## 1. Архитектура

Статический сайт без сборки + серверные функции Vercel (Node, ESM).

| Файл | Что делает |
|---|---|
| `index.html` | Весь интерфейс: таблица, Health score, окно динамики, плашка закономерностей, чат |
| `data.js` | Загружает данные из `/api/metrics`; если API недоступен или открыт `?demo`, показывает демо-данные |
| `api/metrics.js` | Ядро. Маппинг уроков из Airtable, запросы в Amplitude, большинство метрик, история для окна динамики |
| `api/cohorts.js` | Когортные метрики, которым нужно время «дозреть»: Completion Rate и Catalog Pull |
| `api/insights.js` | «Закономерности за 12 недель» |
| `api/chat.js` | Чат «AI analyst» (Claude с инструментами, которые вызывают те же расчёты, что и таблица) |

Источники данных:
- **Amplitude**, проект «The Coach: for men only» (id 282803), через Dashboard REST API (segmentation, retention, funnels).
- **Airtable**, база «(PROD) The Coach Programs» (`app1k5mFTR9tmsZmO`): какие уроки (headline, id, program day) к какой программе относятся.

Переменные окружения (Vercel → Settings → Environment Variables):

| Переменная | Назначение |
|---|---|
| `AMPLITUDE_API_KEY`, `AMPLITUDE_SECRET_KEY` | Ключи проекта Amplitude |
| `AIRTABLE_TOKEN` | Personal access token Airtable со scope `data.records:read` + `schema.bases:read` на базу |
| `ANTHROPIC_API_KEY` | Для чата и формулировок инсайтов. **Пока не задан**: без него чат отвечает ошибкой, а инсайты формулируются шаблонами |
| `AIRTABLE_TABLE`, `AIRTABLE_PROGRAM_FIELD`, `AIRTABLE_HEADLINE_FIELD`, `AIRTABLE_DAY_FIELD` | Необязательно: переопределить таблицу или названия колонок |

Ключи сейчас выпущены от имени Дмитрия. Если его доступы отключат, дашборд перестанет получать данные: ключи нужно будет заменить.

---

## 2. Общие правила расчёта

### Периоды
- Неделя / месяц / квартал = 7 / 30 / 91 дней.
- Период **заканчивается последним полным днём** (вчера по UTC). Более позднюю дату API сдвигает на вчера. Так мы не сравниваем неполный текущий день с полным.
- «Предыдущий период» — такой же длины, сразу перед выбранным. От него считается процент изменения в ячейке.

### Какие программы показываются
1. **Маппинг собирается из всех таблиц базы**, где есть колонки `headline` и `Program` (сейчас 39 таблиц). Версии и варианты одной программы (например, таблицы `sex_skill_man`, `sex_skill_man_v2`, `sex_skill_man_v3`) объединяются по значению `Program`. При этом разные коды (`sex_skill` и `sex_skill_man`, `last_longer` и `last_longer_v2`) считаются разными программами.
2. **Только мужские программы.** Исключаются программы и таблицы, в названии которых есть `for_her`, `woman`, `female`, `menopause`, а также явно заданная женская `sex_skill_app` (список `FEMALE_PROGRAMS` в `api/metrics.js`). Сейчас исключены: for_her, for_her_retain, sex_skill_app, kegel_journey, sex_skill_forher_lgbt, menopause_for_her, sexting_woman, squirt_woman.
3. **Скрываются программы, у которых нет ни одного ненулевого значения** ни в текущем, ни в предыдущем периоде.
4. **Отображаемые названия** заданы в `DISPLAY_NAMES`. Сейчас это last-longer → Last longer, keep-it-hard → Keep it hard, sex-skill-man → Sex is a skill, overall-health → Overall Health, sexting-man → A man's guide to sexting, navigating-arguments-man → Solving couple fights, kegel-only → Kegel Challenge. Остальные программы показываются кодом из Airtable (например, `maintenance_pe`, `squirt_man`, `massage_man`).

### Как событие привязывается к программе
- `DailyPlanItemOpen` — по `title`: он совпадает с колонкой `headline` в Airtable.
- `LessonOpen`, `LessonComplete`, `CoachLessonRating` — по `lesson_id`; `SharingVideoSent` — по `lessonId`. Сравнивается с колонкой `id` в Airtable. У событий и Airtable id немного различаются, поэтому обе стороны нормализуются (`lessonKey`): убирается префикс `lesson_` / `exercise_` и вставка `_video` (`exercise_x_video_y` → `x_y`).
- `KegelTrainingStart` — по `workout_id` (тренировок нет в Airtable, см. §4.4).
- `CurrentDay` — по `program_id`: он совпадает с кодом программы в Airtable (`last_longer` и т. д.).
- `payment_succeeded` и `OnboardingNativeQuestionAnswered` — по цели онбординга (§3).

### Кэш и скорость
- Маппинг Airtable кэшируется на 10 минут, запросы Amplitude внутри функции — тоже на 10 минут.
- На уровне CDN: последний период кэшируется на 1 час, прошлые — на сутки. Когорты — на сутки, инсайты — на 6 часов.
- Холодная загрузка: неделя ~30 с, месяц ~60 с, квартал ~2–2,5 мин. Лимит функции поднят до 300 с (`maxDuration`).
- У Amplitude есть лимит на «стоимость» одновременных запросов. В `amplitudeFetch` стоит ограничитель (≈5 единиц на день диапазона, бюджет 900) и повтор при 429.

---

## 3. Цели онбординга (используются в нескольких метриках)

Событие `OnboardingNativeQuestionAnswered`, свойство `answer`.

| Программа | Ответ (англ.) | Другие языки (в расчётах **не** используются) |
|---|---|---|
| Last longer | BEAT PREMATURE EJACULATION | SCONFIGGERE L'EIACULAZIONE PRECOCE · SURMONTER L'ÉJACULATION PRÉCOCE · VORZEITIGE EJAKULATION ÜBERWINDEN · SUPERAR LA EYACULACIÓN PREMATURA |
| Keep it hard | BEAT ERECTILE DYSFUNCTION | SCONFIGGERE LA DISFUNZIONE ERETTILE · TRAITER LES TROUBLES DE L'ÉRECTION · EREKTILE DYSFUNKTION BEHANDELN · TRATAR LA DISFUNCIÓN ERÉCTIL |
| Sex is a skill | IMPROVE SEX SKILLS | MIGLIORARE LE ABILITÀ SESSUALI · AMÉLIORER VOS COMPÉTENCES SEXUELLES · SEXUELLE FÄHIGKEITEN VERBESSERN · MEJORAR LAS HABILIDADES SEXUALES |
| Overall Health | BOOST OVERALL HEALTH | MIGLIORARE LA SALUTE GENERALE · AMÉLIORER VOTRE SANTÉ GLOBALE · ALLGEMEINE GESUNDHEIT VERBESSERN · MEJORAR LA SALUD GENERAL |

**Допущение: учитываются только английские ответы** (`ENTRY_GOALS`). Ответы с несколькими целями в квадратных скобках (`[A, B, C]`) тоже не учитываются. Цели есть только у этих четырёх программ. У остальных программ New Users, Active to New Ratio, Share of Traffic, Catalog Pull, Monetization и LTV показываются как «—».

Для Monetization вместо события используется пользовательское свойство `gp:goals` (цель, сохранённая у пользователя). В нём встречаются и старые формулировки, мы их тоже засчитываем: FIX PREMATURE EJACULATION, LAST LONGER IN BED → Last longer; FIX ERECTILE DYSFUNCTION → Keep it hard.

---

## 4. Метрики

Порядок столбцов: сначала посчитанные метрики, справа те, что ещё не подключены.

### 4.1 Active Users
Уникальные пользователи с ≥1 `DailyPlanItemOpen`, у которого `title` — headline урока программы, за период. Один пользователь считается один раз на программу, но попадает во **все** программы, контент которых открывал.

### 4.2 New Users
Уникальные пользователи, выбравшие цель программы в онбординге (английский ответ, §3) **внутри выбранного периода**.

### 4.3 Active to New Ratio
Active Users ÷ New Users за тот же период. Чем выше, тем сильнее программа притягивает людей сверх тех, кто пришёл за её целью. Отношение может быть сильно больше 1: Active Users включает всех активных, в том числе пришедших давно, а New Users — только новых за период.

### 4.4 Share of Engagement
Доля программы во всех «событиях вовлечения» приложения за период:

```
(LessonOpen + LessonComplete по lesson_id уроков программы
 + DailyPlanItemOpen по headline программы
 + KegelTrainingStart тренировок программы)
÷ все события этих четырёх типов в приложении
```

- Кегель-тренировок нет в Airtable, программа определяется по `workout_id` (функция `kegelProgram`). Правила согласованы с командой:
  - `workout_N_pe`, `workout_custom_morning_pe_*`, `workout_custom_evening_pe_*` → Last longer
  - `*_kegel_only` (включая `workout_custom_*_kegel_only`) → Kegel Challenge
  - `workout_N` без суффикса → Keep it hard
  - `workout_custom_retain` → maintenance_pe
  - остальные тренировки попадают только в знаменатель
- В знаменатель входят и события, которые нельзя приписать ни одной программе (общие уроки, женские программы, неизвестные тренировки). Поэтому доли в сумме дают меньше 100%: в октябре было около 80%.
- **Предыдущий период не считается и не показывается** (решение команды). Клик по значению открывает динамику.

### 4.5 Share of Traffic
Доля программы во всех New Users: New Users программы ÷ сумма New Users четырёх программ с целью. Доли в сумме дают 100%. Предыдущий период не показывается.

### 4.6 Return Rate
Из пользователей, у которых **первое в жизни** открытие урока программы (`DailyPlanItemOpen` с её headline и historical count = 1, окно 365 дней) пришлось на период, — доля тех, кто открыл урок той же программы **на следующий день** (retention N-day, день 1).
- Когорты дневные. Учитываются только когорты, у которых день 1 уже завершился.
- В ответе Amplitude Retention API у каждой когорты массив `[размер когорты, день 0, день 1, …]`, поэтому день 1 — это **индекс 2** (сначала была ошибка с индексом 1).

### 4.7 User Satisfaction
Средняя оценка 1–5 из `CoachLessonRating` по урокам программы, взвешенная по числу оценок. Оценка лежит в `rating` (Android) или `value` (iOS), учитываются оба свойства. В скобках показано число оценок. Процента изменения нет: клик по значению открывает динамику. Сентимент отзывов пока не считается.

### 4.8 Sharing
Число `SharingVideoSent` по урокам программы (`lessonId`). Фактически шерятся только уроки Sex is a skill, поэтому Sharing **не входит** в Health score.

### 4.9 Completion Rate (`api/cohorts.js`)
Из вошедших в программу — доля дошедших до её последнего дня.
- **Вход:** первый в жизни `CurrentDay` с `program_id` программы.
- **Финиш:** `CurrentDay` с `day` = последний `program day` программы в Airtable. Если у программы несколько версий разной длины, засчитывается последний день любой версии (Sex is a skill: день 30 или 33; Overall Health: 10 или 15).
- **Окно конверсии:** длина программы + 50%, `ceil(дни × 1,5)`. 60 дней → 90, 70 → 105, 14 → 21.
- **Когорта** — выбранный период, сдвинутый назад на окно конверсии, чтобы у всех было полное окно. Поэтому у каждой программы свои даты когорты.
- Меньше 30 человек в когорте → «not enough data».
- Процента изменения нет.

### 4.10 Catalog Pull (`api/cohorts.js`)
Сколько **других** программ в среднем начинают те, кто выбрал цель этой программы в онбординге.
- Когорта: выбравшие цель (§3) в выбранном периоде, **сдвинутом на 14 дней назад**.
- «Начал программу» = ≥1 `DailyPlanItemOpen` её урока в течение **14 дней** после выбора цели.
- Значение = сумма по другим программам доли начавших (≈ среднее число начатых других программ).
- Программы, у которых меньше 30 пользователей за этот срок, как «другие» не учитываются. Когорта меньше 30 → «not enough data».

### 4.11 Monetization
Выручка от **физических товаров** за период.
- `payment_succeeded`, кроме `is_test_order = True`. Свойство `products` — массив позиций вида `{"name","price","product_id","qty"}`. Выручка = Σ `price × qty`.
- **Привязка к программе — по главной цели покупателя** (пользовательское свойство `gp:goals`, §3). Так решили «для начала». Альтернативы, которые обсуждали: «товар → программа» и «переход в магазин из урока».

### 4.12 Monetization per Active User
Monetization ÷ Active Users программы.

### 4.13 LTV
**Фиксированные значения от команды**, не из Amplitude: $ на пользователя по цели онбординга, английский онбординг. Last longer 90,12 · Keep it hard 90,49 · Sex is a skill 90,86 · Overall Health 89,65. Заданы в `LTV_USD` в `api/metrics.js` и обновляются вручную. От периода не зависят, процента изменения нет. Значения для других языков (IT, FR, DE, ES) есть в таблице команды, но не используются.

### 4.14 Health score (кольцо у названия программы)
**Предварительный**, считается в браузере (`HEALTH_COMPONENTS` в `index.html`). Взвешенное среднее, каждая составляющая переведена в шкалу 0–100:

| Составляющая | Вес | 100 баллов при |
|---|---|---|
| Return Rate | 40% | 30% |
| User Satisfaction | 33% | шкала 3,5 → 0, 5,0 → 100; только если оценок ≥ 30 |
| Active to New Ratio | 27% | 5× |

Если составляющей нет, её вес делится между остальными. Нужно минимум две составляющие. Sharing не входит. Completion Rate, Catalog Pull и Monetization пока **не включены**.

### 4.15 Не подключены
LTV · Web, Estimated Revenue: показываются как «—».

---

## 5. Допущения и упрощения

### 5.1 Одинаковые уроки в нескольких программах (главное упрощение)

**Проблема.** Многие уроки (одинаковый `headline` и/или `lesson_id`) входят сразу в несколько программ: «Morning Kegel Workout» есть в Last longer, Keep it hard, Kegel Challenge и last_longer_v2. Событие `DailyPlanItemOpen` содержит только `title`, а `LessonComplete` — только `lesson_id`. Программы в этих событиях нет, поэтому по такому уроку нельзя понять, в какой программе его открыли.

**Решение (вариант «б», выбран командой).** Урок, который встречается в двух и более мужских программах, **не засчитывается ни одной из них**. Проверка идёт отдельно по headline (для `DailyPlanItemOpen`) и по lesson_id (для `LessonOpen`/`LessonComplete`/оценок/шеринга). Женские программы в проверке не участвуют: урок, общий только с женской программой, остаётся за мужской. Реализовано в `selectPrograms` (`api/metrics.js`).

Варианты, которые обсуждали, но не выбрали:
- засчитывать общий урок **каждой** программе: завышает и даёт двойной счёт;
- засчитывать по **текущей программе** пользователя: в событиях её нет.

**Последствия, которые нужно держать в голове:**

| Программа | Уникальных headline / всего | Что теряется |
|---|---|---|
| Kegel Challenge (`kegel_only`) | **1 / 8** | Остался только «Last Point». Все кегель-тренировки общие с Last longer / Keep it hard. Active Users, Return Rate и Share of Engagement по урокам почти не отражают реальную активность. Отчасти это компенсируют кегель-тренировки в Share of Engagement (§4.4) и `CurrentDay` в Completion Rate |
| Keep it hard | **25 / 58** | Больше половины контента общая с Last longer (кегель, добавки, дыхание, Sensate Focus, мышление). Active Users, Return Rate, оценки и «урок своей программы» занижены |
| last_longer_v2 | 9 / 17 | Половина контента общая с Last longer / Keep it hard |
| maintenance_pe | 4 / 7 | Общие с Last longer и Kegel Challenge |
| squirt_man | 3 / 12 | 9 уроков общие с Sex is a skill |
| Last longer | 129 / 170 | Потеряно 41 headline (в основном общие с Keep it hard) |
| Sex is a skill | 93 / 108 | Потеряно 15 (общие с squirt_man, sex_skill, art_of_attraction, «Share Your Feedback») |
| Остальные | почти без потерь | |

Полный список общих headline — в Приложении А.

**Важно при изменениях в Airtable.** Новая программа, которая переиспользует уроки существующей, **молча убирает эти уроки из метрик старой программы**. Например, после появления `squirt_man` из Sex is a skill выпали 9 уроков о squirting. На графиках динамики это выглядит как падение, хотя поведение пользователей не менялось. После правок в Airtable проверяйте `/api/metrics?debug=mapping`: в нём для каждой программы есть `sharedDropped`, а в поле `shared` — список общих уроков.

Чтобы убрать это упрощение, нужно, чтобы приложение отправляло `program_id` в `DailyPlanItemOpen` / `LessonOpen` / `LessonComplete`, как уже сделано в `CurrentDay`.

### 5.2 Прочие допущения

1. **Только мужские программы.** Женские исключены по правилам из §2, включая `sex_skill_app`, которую указали явно.
2. **Только английский.** Цели онбординга — только английские ответы. Заголовки уроков на других языках не совпадают с английскими headline в Airtable, поэтому активность на испанском и других языках в Active Users и производные метрики не попадает.
3. **Кегель в Active Users не учитывается.** `KegelTrainingOpen` и `KegelTrainingStart` в Active Users и Return Rate не входят, только в Share of Engagement (§4.4).
4. **Привязка кегель-тренировок по суффиксу `workout_id`.** Это наше правило, а не данные. `workout_N` → Keep it hard и `workout_custom_retain` → maintenance_pe подтвердила команда.
5. **Один пользователь — во всех своих программах.** Active Users по программам в сумме больше общего числа пользователей. Так задумано: пользователь считается в каждой программе, где был активен.
6. **Completion Rate: финиш по `CurrentDay`, а не по `LessonComplete`.** Пробовали `LessonComplete` последнего урока, но id финальных уроков в событиях не совпадают с Airtable. Например, приходит общий `the_end_whats_next_last` вместо `the_end_whats_next_pe` / `_ed_last`, а `finish_pe_last` не приходит вообще. Потом пробовали `DailyPlanItemOpen` пункта последнего дня: у Overall Health такие пункты никто не открывал, видимо из-за несовпадения названий. Остановились на `CurrentDay`.
7. **Окна когорт выбраны договорённостью:** Completion — длина программы + 50%, Catalog Pull — 14 дней. Изначально оба были 60 дней, но для 60-дневных программ это почти 0%, а для Catalog Pull окно было слишком большим.
8. **Monetization привязывается по цели покупателя, а не по товару.** Покупатель с целью PE, купивший Formula 02 (ED), попадёт в Last longer.
9. **Monetization покрывает малую часть заказов.** У большинства заказов (~600 из ~680 за 30 дней) у покупателя нет `gp:goals`, видимо это веб-покупатели, не связанные с аккаунтом приложения. Такие заказы не попадают ни в одну программу, поэтому сумма по дашборду намного меньше выручки Shopify.
10. **`price × qty` может завышать выручку.** В данных есть позиции, где `price`, похоже, уже содержит сумму за всю позицию (Glide 54 при цене 18 и `qty = 1`). При `qty > 1` выручка будет завышена. Нужно уточнить у того, кто настраивал отправку из Shopify.
11. **У Monetization нет истории до конца августа 2026.** `payment_succeeded` приходит примерно с конца августа, поэтому за более ранние периоды выручка равна 0 и процент изменения не показывается.
12. **Минимальные выборки.** Когорты меньше 30 → «not enough data». В инсайтах Return Rate учитывается при когорте ≥ 100, оценка — при ≥ 30 оценок в неделю. В Health score оценка учитывается при ≥ 30 оценок.
13. **LTV — внешняя оценка**, не связанная с данными дашборда.

---

## 6. Закономерности за 12 недель (`api/insights.js`)

История строится по 12 полным календарным неделям (Пн–Вс), кэш 6 часов. Детекторы:
- **Аномалия**: значение последней недели вне нормы (|z| ≥ 2 относительно 8 предыдущих недель) или рекорд за 12 недель.
- **Тренд**: 4 и больше недель подряд в одну сторону; дрейф оценки.
- **Расхождение**: New Users и Active Users идут в разные стороны.
- **Корреляция**: Active Users повторяют New Users с лагом в неделю; связь притока и Return Rate; связь аудитории и оценки.
- **Сравнение**: все программы движутся вместе (внешняя причина); отрыв от медианы; несовпадение мест по оценке и по Return Rate.
- **Запуск**: программа появилась внутри окна и теряет аудиторию после пика.
- **Использование**: инсайты по Active to New Ratio.
- **Рост / Устойчивость**: позитивные сигналы. Рост считается только у программ, которые жили все 12 недель.

Отбор: 6 сильнейших, разнесённых по программам и типам. Гарантируется минимум один инсайт по Active to New Ratio и минимум два позитивных, при необходимости список расширяется до 7. С `ANTHROPIC_API_KEY` формулировки пишет Claude (только цифры из данных), без ключа — шаблоны.

## 7. Чат «AI analyst» (`api/chat.js`)

Claude с двумя инструментами: `get_program_metrics` (все метрики за период) и `get_metric_history` (динамика одной метрики). Они вызывают тот же код, что и таблица, поэтому цифры совпадают. Определения метрик записаны в системном промпте в `api/chat.js`: **при изменении метрики обновляйте и его**. Нужен `ANTHROPIC_API_KEY`.

---

## 8. Диагностика

| Запрос | Что показывает |
|---|---|
| `/api/metrics?debug=mapping` | Использованные таблицы, программы, `sharedDropped`, общие уроки, исключённые программы |
| `/api/metrics?debug=lookup&q=<headline или id>` | В каких программах встречается урок, до и после правил отбора |
| `/api/metrics?debug=rating&program=<id>&from=&to=` | Сырые оценки программы |
| `/api/metrics?debug=monetization&program=<id>&from=&to=` | Позиции заказов, из которых сложилась Monetization |
| `/api/metrics?history=<id>&metric=<key>&period=week&date=&points=` | Динамика метрики (то же, что окно графика) |
| `/api/cohorts?period=week&date=<дата>&debug=funnel&program=<id>` | Сырой ответ воронки Amplitude |
| `/api/cohorts?period=week&date=<дата>&debug=crossover&from=&to=&days=7` | Разовый анализ: доля выбравших цель, кто за N дней прошёл урок в другой программе |
| `/api/insights?debug=history` | История за 12 недель, на которой строятся инсайты |
| `/?demo` | Интерфейс на демо-данных |

## 9. Как вносить изменения

1. Работайте в своей ветке, затем pull request в `claude/program-dashboard`. После merge Vercel сам выкатит изменения.
2. В превью веток данные будут только если переменные окружения включены и для окружения Preview.
3. При добавлении или изменении метрики обновите: `METRICS` в `api/metrics.js` (или `api/cohorts.js`), столбец в `COLUMNS` в `index.html`, этот документ, `README.md` и системный промпт в `api/chat.js`.
4. После правок в Airtable проверьте `debug=mapping` (§5.1).

## 10. Открытые вопросы

- Сделать Health score финальным: добавить Completion Rate, Catalog Pull, монетизацию, сентимент.
- Monetization: уточнить смысл `price` в `products`; решить, как привязывать заказы без цели.
- Убрать упрощение с общими уроками: попросить разработку отправлять `program_id` в событиях уроков.
- Подключить другие языки (цели, LTV, заголовки).
- Скорость: заранее пересчитывать данные по расписанию, чтобы квартал не грузился 2 минуты.
- Задать `ANTHROPIC_API_KEY` для чата.
- Добавить отображаемые названия для новых программ (`squirt_man`, `massage_man`) в `DISPLAY_NAMES`.

---

## Приложение А. Общие уроки (headline), не засчитываемые ни одной программе

Выгрузка из `/api/metrics?debug=mapping` на ноябрь 2026 (55 headline; женские программы не показаны).

| Headline | Программы |
|---|---|
| Best Positions for Her | sex_skill, sex_skill_man |
| Resistance Kegel Training | last_longer, keep_it_hard, kegel_only |
| Custom Kegel (Morning) | last_longer, kegel_only |
| Custom Kegel (Evening) | last_longer, kegel_only |
| Morning Kegel Workout | last_longer, last_longer_v2, keep_it_hard, kegel_only |
| Evening Kegel Workout | last_longer, last_longer_v2, keep_it_hard, kegel_only |
| Your first Kegel Workout | last_longer, keep_it_hard |
| Finding Pelvic Floor | last_longer, keep_it_hard, kegel_only |
| Glutes & Pelvic Floor | last_longer, last_longer_v2, keep_it_hard |
| Magnesium | last_longer, keep_it_hard |
| Take Your Daily Supplements | last_longer, keep_it_hard |
| Supplements: intro | last_longer, keep_it_hard |
| Supplements: summary | last_longer, keep_it_hard |
| Order your Supplements | last_longer, keep_it_hard |
| Vitamin B3: not only for skin care | last_longer, keep_it_hard |
| Measuring Testosterone | last_longer, keep_it_hard |
| Why T is important? | last_longer, keep_it_hard |
| The Coach Protocol | last_longer, keep_it_hard |
| Daily Essentials: Summary | last_longer, keep_it_hard |
| Honest Dialogue | last_longer, keep_it_hard |
| Talking about sex | last_longer, keep_it_hard |
| Talking About Sex | last_longer, navigating_arguments_man |
| The Triple Column Exercise | last_longer, keep_it_hard |
| Negative Thinking | last_longer, keep_it_hard |
| Triggers | last_longer, keep_it_hard |
| Body Scanning Meditation | last_longer, keep_it_hard |
| Breath of Light | last_longer, keep_it_hard |
| 5 Senses Exercise | last_longer, keep_it_hard |
| Regular stretches | last_longer, keep_it_hard |
| Arousal | last_longer, keep_it_hard |
| Skills to Perform Better | last_longer, keep_it_hard |
| Sensate Focus Practice | last_longer, keep_it_hard |
| Sensate Focus | last_longer, last_longer_v2, keep_it_hard |
| Zones & Foreplay | last_longer, last_longer_v2, keep_it_hard |
| Arousal practice (beginner) | last_longer, last_longer_v2 |
| Common mistakes | last_longer_v2, keep_it_hard |
| Getting started | last_longer_v2, keep_it_hard |
| Breathing Exercise | last_longer, maintenance_pe |
| Jacobson Relaxation Exercise | last_longer, maintenance_pe |
| Intro | maintenance_pe, kegel_only |
| Introduction | last_longer, porn_addiction |
| Explore | last_longer, sex_skill_man |
| Invite Your Partner | last_longer, sex_skill_man |
| We'd Love Your Input | last_longer, sex_skill_man, sexting_man, navigating_arguments_man |
| Share Your Feedback | last_longer, keep_it_hard, art_of_attraction, sex_skill_man, sexting_man, navigating_arguments_man |
| Final Reflection | art_of_attraction, sex_skill_man |
| Squirting Setup | sex_skill_man, squirt_man |
| Her Pleasure A/B Mapping | sex_skill_man, squirt_man |
| Grounding After Release | sex_skill_man, squirt_man |
| Manual Squirting Techniques | sex_skill_man, squirt_man |
| Angle Control During Sex | sex_skill_man, squirt_man |
| Angle Training | sex_skill_man, squirt_man |
| Sex Toys For Squirting | sex_skill_man, squirt_man |
| Build And Trigger Session | sex_skill_man, squirt_man |
| The Squirting Pathway | sex_skill_man, squirt_man |

Аналогичное правило действует для `lesson_id` (уроки с одинаковым id в нескольких программах выпадают из оценок, шеринга и Share of Engagement). Текущий список по id можно посмотреть через `debug=lookup`.

## Приложение Б. История ключевых решений

| Что | Решение |
|---|---|
| Общие уроки | Вариант «б»: не засчитывать ни одной программе |
| Женские программы | Исключить; `sex_skill_app` — женская |
| Языки | Только английский |
| Периоды | До последнего полного дня; сравнение с периодом той же длины |
| Return Rate | Первое открытие (historical count = 1) → открытие на следующий день; день 1 = индекс 2 в ответе Amplitude |
| Share of Engagement | Сначала только LessonComplete; затем LessonOpen + LessonComplete + DailyPlanItemOpen + KegelTrainingStart; без предыдущего периода |
| Catalog Pull | Окно 60 → 14 дней |
| Completion Rate | Окно 60 дней → длина программы + 50%; финиш: LessonComplete → DailyPlanItemOpen последнего дня → CurrentDay (day = последний день) |
| Health score | Sharing исключён (шерится только Sex is a skill) |
| Monetization | Только физические товары; атрибуция по цели покупателя |
| LTV | Фиксированные значения команды, английский онбординг |
