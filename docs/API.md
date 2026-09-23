# API v1.0 — для frontend

Источник схем: `/api/openapi.json` и `docs/openapi.json`.
Основные входы и ответы типизированы Pydantic; модели общих данных — contracts.py.
Даты ISO 8601, числа JSON, неизвестное значение null.

## Сессия

`POST /api/sessions` без тела → token, session_id, expires_at.
Все рабочие запросы: `Authorization: Bearer TOKEN`. Cookie не используются.
Сохраняйте токен в sessionStorage и переиспользуйте его; не создавайте новую
сессию при каждом рендере. При 401 покажите, что сессия закончилась.
Не пересоздавайте сессию молча при работе с несохранённым заказом.

## Основные маршруты

| Метод | Путь | Назначение |
|---|---|---|
| GET | /api/health | Состояние, версия, наличие конфигурации модулей/ИИ |
| GET | /api/datasets | items: id, name, mode, as_of, warehouse_id, supplier_ids, version, engine_backend |
| GET | /api/datasets/{id}/quality | Отчёт импортера по качеству |
| GET | /api/datasets/{id}/shipments | Партии для выбора сценария |
| POST | /api/imports | Multipart files[], supplier, mapping_version, as_of, warehouse_id; плюс X-Admin-Token |
| GET | /api/imports/{id} | queued/running/completed/failed/interrupted; dataset_id при завершении |
| POST | /api/runs | dataset_id, supplier_id, as_of, L/R/страховые дни, опционально scenario |
| GET | /api/runs/{id} | Метаданные, параметры, summary, версия алгоритма |
| GET | /api/runs/{id}/recommendations | page, page_size<=100, q, needs_review |
| GET | /api/runs/{id}/products/{sku} | Полная Recommendation с history/trajectory/factors |
| POST | /api/runs/{id}/scenario | Новые параметры Scenario → новый run_id, summary и comparison |
| POST | /api/scenarios/parse | run_id, text, selected_shipment_id → параметры для подтверждения |
| POST | /api/runs/{id}/explain | sku, language=ru/kk → status generated/fallback, text, factor_ids |
| POST | /api/orders | run_id, supplier_id, skus → draft_id/version/lines |
| GET | /api/orders | Черновики и утверждённые заказы текущей сессии |
| GET | /api/orders/{id} | Снимок, версия, аудит |
| PATCH | /api/orders/{id} | version, changes: sku/approved_qty/reason |
| POST | /api/orders/{id}/approve | version, acknowledge_warnings |
| GET | /api/orders/{id}/export.csv | Только утверждённый снимок |

Импорт возвращает 202, вычисления выполняются синхронно и возвращают 201.
Прогресс импорта в платформе дискретный 0/100; точного построчного прогресса нет.
Пример multipart: repeated form key `files`, не JSON-строка `files[]`.

## Сценарий

```json
{"shipment_id":"demo-shipment-1","delay_days":20,"demand_change_pct":0}
```

Задержка 0–365 дней, спрос от −90% до +300%. Без партии задержка запрещена.
Значения заменяют предыдущий сценарий относительно исходного dataset.
На frontend храните исходный и новый run_id отдельно; черновик старого расчёта
не становится утверждением нового результата.

ИИ сначала возвращает `requires_confirmation=true`. Покажите значения человеку,
затем вызовите `/scenario`. `needs_clarification=true` означает, что применять нечего.
`status=fallback` явно подписывайте как работу без ИИ. HTML из ответов не исполняйте.

## Черновик

Создать:

```json
{"run_id":"ID","supplier_id":"IEK","skus":["0001_"]}
```

Изменить:

```json
{"version":1,"changes":[{"sku":"0001_","approved_qty":168,"reason":"Дополнительный запас"}]}
```

Утвердить:

```json
{"version":2,"acknowledge_warnings":true}
```

Сначала покажите warnings и получите действие пользователя, затем true.
После 409 перечитайте черновик; не перезаписывайте его слепо.
blocked нельзя снять подтверждением предупреждения.

## Ошибка

```json
{"error":{"code":"version_conflict","message":"Черновик изменён. Обновите его и повторите действие.","fields":[]}}
```

401 — нет/истекла сессия; 403 — нет admin-токена; 404 — объект не найден/чужой;
409 — конфликт; 413 — лимит размера; 422 — неверные данные; 429 — лимит запросов;
502 — расчётный модуль нарушил контракт; 503 — интеграция ещё не подключена.
Ошибки инфраструктуры до приложения, например Caddy 413, могут иметь не-JSON тело.

## Рекомендации UI

Количество берите с сервера. Не суммируйте метры и штуки. history/trajectory
в списке пустые; полные серии получайте из карточки. CSV скачивайте через fetch
с Authorization (обычная ссылка этот заголовок не передаёт).
Образец клиента: `examples/api-client.ts`.
