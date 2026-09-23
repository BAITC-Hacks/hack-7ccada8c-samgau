# API v1.0 — для frontend

Источник схем: `/api/openapi.json` и `docs/openapi.json`.
Входы, ответы импорта/расчёта/заказов и формат ошибок типизированы Pydantic; модели общих данных — contracts.py.
Даты ISO 8601, числа JSON, неизвестное значение null.

## Основной набор

`demo-engine-v1`: supplier_ids `iek`, `systeme_electric`, дата `2026-09-22`,
склад `synthetic-almaty`. Движок `qor-mvp-1.0`; один run на одного поставщика.
Не отправляйте `all` или `null`. Все фактические ID и дату берите из datasets.
Полный порядок интеграции — [FRONTEND_HANDOFF.md](FRONTEND_HANDOFF.md).

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
| POST | /api/imports | Multipart files[], supplier, mapping_version, as_of, warehouse_id; Bearer автоматически созданной сессии; по умолчанию без ключа администратора; до 6 попыток/мин на сессию и 20 на сервер |
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

По умолчанию `IMPORT_ACCESS=session`: импорт доступен посетителю в своей сессии.
При явном `IMPORT_ACCESS=admin` дополнительно нужен `X-Admin-Token`, совпадающий
с серверным `ADMIN_TOKEN`; интерфейс ключ не запрашивает, загрузка через UI в этом режиме недоступна.

Импорт возвращает 202, вычисления выполняются синхронно и возвращают 201.
Прогресс импорта в платформе дискретный 0/100; точного построчного прогресса нет.
Встроенный профиль `qor-explicit-xlsx-v1` принимает шесть XLSX одного поставщика
с явным маппингом `_QOR_IMPORT`. Произвольные реальные выгрузки и CSV этим
профилем не поддерживаются.
Пример multipart: repeated form key `files`, не JSON-строка `files[]`.

## Сценарий

```json
{"shipment_id":"ID_ИЗ_GET_SHIPMENTS","delay_days":30,"demand_change_pct":0}
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
{"run_id":"ID","supplier_id":"systeme_electric","skus":["00001"]}
```

Изменить:

```json
{"version":1,"changes":[{"sku":"00001","approved_qty":168,"reason":"Дополнительный запас"}]}
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

401 — нет/истекла сессия; 403 — нет/неверен admin-токен при `IMPORT_ACCESS=admin`; 404 — объект не найден/чужой;
409 — конфликт; 413 — лимит размера; 422 — неверные данные; 429 — лимит запросов;
502 — расчётный модуль нарушил контракт; 503 — интеграция ещё не подключена.
Ошибки инфраструктуры до приложения, например Caddy 413, могут иметь не-JSON тело.

## Рекомендации UI

Количество берите с сервера. Не суммируйте метры и штуки. history/trajectory
в списке пустые; полные серии получайте из карточки. CSV скачивайте через fetch
с Authorization (обычная ссылка этот заголовок не передаёт).
Образец клиента: `examples/api-client.ts`.
