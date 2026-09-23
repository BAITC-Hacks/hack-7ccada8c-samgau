# Контракт QOR UI ↔ backend, версия 1

> Это исходный контракт UI, а не текущий контракт backend 0.2.0. Cookie-сессия, один run на всех поставщиков и формы запросов ниже не реализованы сервером в таком виде. Для подключения использовать [план капитану](../docs/CAPTAIN_UI_INTEGRATION.md) и [фактический контракт сервера](../docs/FRONTEND_HANDOFF.md). Не реализовывать оба документа как независимые API.

Владелец UI: участник 3. Это ожидаемый контракт фронтенда, а не утверждение о наличии этих методов на сервере. В `src/types.ts` приведены полные TypeScript-формы. Имена полей — snake_case. JSON, числовые quantities, даты ISO, отсутствующие значения — `null`. Для MVP supplier_id — `iek` / `systeme`; фильтр `all` означает оба.

Базовый URL `/api`. Запросы содержат `credentials: include`; сервер устанавливает изолированную сессию. Мутации должны проверять сессию/полномочия и CSRF/origin. Браузерная проверка количества не заменяет серверную.

## Минимальный порядок подключения

1. `GET /datasets`, `POST /runs`, `GET /runs/{id}/recommendations` — рабочая таблица.
2. Детали и quality — графики и паспорт.
3. `/scenario` — серверный пересчёт и сравнение.
4. `/orders` + `/approve` + CSV — подтверждение.
5. `/scenarios/parse` и `/explain` — настоящий ИИ.

## Наборы и расчёты

`GET /datasets` → массив (не объект-обёртка):

```json
[{"id":"demo-september","name":"Демонстрационный набор","mode":"synthetic","as_of":"2026-09-22","warehouse":"Алматы"}]
```

`POST /runs` ← `{ "dataset_id": "…", "supplier_id": null, "as_of": "2026-09-22" }`.

UI при первичной загрузке рассчитывает весь набор. `null` у supplier_id означает все поставщики. Дата берётся из выбранного набора. Ответ:

```json
{"run_id":"run-1","summary":{"order_skus":8,"risk_skus":2,"anomaly_count":3,"review_skus":1,"total_skus":12}}
```

`GET /runs/run-1/recommendations?page=1&page_size=100`:

```json
{
  "total": 1,
  "summary": {"order_skus":1,"risk_skus":0,"anomaly_count":1,"review_skus":0,"total_skus":1},
  "items": [{
    "sku":"030200428_", "supplier_id":"systeme", "supplier_article":"ATN000343",
    "name":"Розетка AtlasDesign, 16А, алюминий", "category":"Розетки и выключатели", "unit":"шт",
    "available_stock":80, "eligible_incoming":50, "forecast_qty":210, "safety_stock":70,
    "raw_need":150, "recommended_qty":156, "risk_status":"warning", "stockout_date":"2026-10-06",
    "data_status":"estimated", "anomaly_count":1, "coverage_days":8,
    "factors":[{"label":"Горизонт расчёта","value":"21 день"},{"label":"Кратность","value":"12 шт"}],
    "warnings":["Разовая крупная покупка выделена отдельно."]
  }]
}
```

`risk_status`: `critical | warning | healthy`. `data_status`: `observed | estimated | missing`. UI не вычисляет их заново. `summary` — по всему run, а не по одной странице. Массивы factors/warnings обязательны, допустимы пустые.

SKU в пределах одного run должен быть уникален. Если один код 1С неоднозначен между источниками, backend нормализует идентификатор либо возвращает ошибку импорта; не отдавайте дубли идентификатора в таблицу. Неизвестный остаток блокирует включение в заказ. Значения `unit`, `recommended_qty` и серверный CSV должны использовать одну согласованную единицу; коэффициент бухта/метр отображается в factors/warnings.

## Графики

`GET /runs/{run_id}/products/{sku}` (SKU URL-encoded):

```json
{
  "sku":"030200428_",
  "history":[{"month":"Авг","actual":200,"regular":200,"restored":300}],
  "projection":[{"date":"22.09","baseline":80,"scenario":80,"with_order":80,"incoming":0}],
  "method":"Горизонт 28 дней. Поступления учитываются по ожидаемым датам."
}
```

В history ожидаются месяцы в хронологическом порядке. `regular` — очищенный спрос, `restored` — оценка с восстановлением stockout. В текущем графике история показывает actual/regular; restored должен быть раскрыт в факторах расчёта. `projection.baseline` — исходный запас без нового заказа; `scenario` — сценарный запас без нового заказа; `with_order` — сценарный запас с рекомендованным заказом. Исходный run может иметь baseline = scenario. Отрицательная траектория означает модельный неудовлетворённый спрос, не физический отрицательный склад.

## Сценарии

`POST /runs/{base_run_id}/scenario`:

```json
{"delay_days":7,"demand_change_pct":20,"supplier_id":"iek"}
```

Параметры заменяют предыдущий сценарий, не накапливаются. UI всегда передаёт исходный base_run_id. `delay_days` 0–30, `demand_change_pct` −50…100, `supplier_id` также может быть `all`. При ручной настройке задержка относится ко всем входящим партиям выбранного поставщика; если backend требует конкретную партию, контракт нужно согласовать до подключения. Ответ — новый Run с новым run_id; исходный run неизменяем.

`POST /scenarios/parse` ← `{ "text": "Поставка задержится на неделю", "supplier_id": "iek" }`:

```json
{"parameters":{"delay_days":7,"demand_change_pct":0,"supplier_id":"iek"},"needs_clarification":false}
```

При неоднозначном запросе `needs_clarification: true, message: "Уточните поставщика"`. Параметры только заполняют форму; применение требует нажатия пользователем. В ответе может быть shipment_id, который UI сохранит и передаст в scenario.

`POST /runs/{id}/explain` ← `{ "sku":"…", "language":"ru" }`:

```json
{"text":"Потребность на 21 день…","factor_ids":["forecast","incoming"],"provider":"openai","mode":"generated"}
```

Без доступного ИИ backend может вернуть `mode: fallback`. UI явно указывает отсутствие генерации, не выдаёт шаблон за ответ модели.

## Качество

`GET /datasets/{id}/quality`:

```json
{"source_count":6,"mapped_skus":12,"issues":[{"id":"stock","title":"Нет актуального остатка","detail":"Одна позиция требует проверки.","severity":"warning","count":1}]}
```

`severity` — `warning | info`. Количество источников и товаров — фактическое, не константа.

## Заказ

`POST /orders`:

```json
{"run_id":"run-1","supplier_id":"systeme","lines":[{"sku":"030200428_","quantity":168,"reason":"Дополнительный запас"}]}
```

Ответ: `{ "draft_id":"draft-1", "version":1, "status":"draft" }`.

`POST /orders/draft-1/approve` ← `{ "version":1 }` → `{ "draft_id":"draft-1", "version":2, "status":"approved" }`.

UI вызывает создание и утверждение последовательно после одного явного действия «Утвердить черновик». В случае сбоя новая попытка может создать ещё один черновик: backend должен обеспечить идемпотентность по сессии/run/поставщику/содержимому либо согласовать idempotency key. Автоматической отправки поставщику нет.

На сервере проверять принадлежность run и draft сессии, неотрицательные конечные числа, единицы, MOQ/кратность, актуальный остаток, обязательную причину отклонения. Конфликт версии — 409; недопустимая строка — 422 с понятным сообщением. Утверждённый снимок неизменяем.

`GET /orders/draft-1/export.csv` → тело CSV UTF-8. Доступен только для утверждённого заказа текущей сессии. Обязательны защита от CSV formula injection, сохранение кодов, причина ручного изменения и понятная единица. UI не преобразует CSV API-режима.

## Ошибки и сроки

Ошибка: HTTP 4xx/5xx с `{ "message": "Понятная причина" }` либо строковый `detail`. Не возвращать HTTP 200 с error-объектом. Неверный Content-Type и HTML вместо API считаются ошибкой.

Текущий UI ожидает синхронный готовый Run в пределах 20 секунд. Если расчёт реализован как job/202, нужно добавить согласованный polling-метод в адаптер; нельзя возвращать 202 без готового run_id в существующий контракт.

Для frontend-сессии API нужен same-origin reverse proxy. При отдельном origin дополнительно нужны корректные CORS, cookies и TLS. Демо не подтверждает безопасность серверной авторизации.
