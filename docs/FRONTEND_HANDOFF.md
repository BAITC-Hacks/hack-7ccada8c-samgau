# Подключение интерфейса к бэкенду QOR AI

Конкретный план соединения с готовым дизайном и ИИ-чатом участника 3: [CAPTAIN_UI_INTEGRATION.md](CAPTAIN_UI_INTEGRATION.md). Этот файл описывает каноническое API; инструкция капитану перечисляет необходимые изменения существующего клиента.

API 0.2.0, контракт данных 1.0. Источник истины — [openapi.json](openapi.json)
и `/api/openapi.json`. Клиент с Bearer/CSV — [../examples/api-client.ts](../examples/api-client.ts).
Код интерфейса в этой доработке не изменялся.

## Подключение

1. Запустить бэкенд по [руководству](CAPTAIN_BACKEND.md).
2. `POST /api/sessions` без тела → `{token, token_type, session_id, expires_at}`.
3. Сохранить token в sessionStorage; все рабочие запросы передают
   `Authorization: Bearer TOKEN`. Cookie не используются.
4. `GET /api/datasets` возвращает **`{items: [...]}`**, не массив.
5. Выбрать `demo-engine-v1`, `engine_backend=plugin`, `mode=synthetic`.
6. Использовать дату и поставщиков из dataset. Для каждого поставщика нужен
   отдельный расчёт. `all` и `null` не принимаются.

`POST /api/runs`:

```json
{"dataset_id":"demo-engine-v1","supplier_id":"systeme_electric","as_of":"2026-09-22","lead_time_days":14,"review_days":7,"safety_days":7}
```

Ожидаемая версия алгоритма — `qor-mvp-1.0`. Второй поставщик — `iek`.
`demo-platform-v1` — прежняя фикстура, оставленная для совместимости.
Экран «все поставщики» хранит supplier_id → run_id и объединяет отображение,
не пересчитывая количества в браузере.

## Поля

| Объект | Контракт сервера |
|---|---|
| datasets/orders/shipments | `{items: [...]}` |
| Склад и поставщики | `warehouse_id`, `supplier_ids`; ID без переименования |
| Сводка | `summary.products`, `to_order`, `critical`, `needs_review` |
| Риски | `ok`, `warning`, `critical`, `unknown` |
| Качество рекомендации | `ready`, `review`, `blocked` |
| Неизвестное число | `null`, не 0 |
| Факторы | `id`, `label`, `value`, `unit`, `status`, `source` |
| История | `history`: `month`, `actual`, `regular`, `restored`, `stockout_days`, `complete`, `source` |
| Прогноз остатков | `trajectory`: `date`, `without_order`, `with_order`, `incoming`, `demand` |
| Объяснение | `text`, `status=generated/fallback`, `factor_ids`, `provider`, `message` |
| Ошибка | `error.code`, `error.message`, `error.fields` |

В списке рекомендаций history/trajectory пустые. Для графиков получить
`GET /api/runs/{run_id}/products/{sku}`: полную Recommendation, а не
`{projection, method}`. Учитывать null и отрицательные остатки.
Количество заказа, MOQ и кратность — в единицах заказа; остатки/прогноз/raw_need —
в складских. Кабель `00007`: **2 бухты**, **305 м/бухта**. Не суммировать
разные единицы. Технические MOQ=0/step=1 при неизвестных правилах не являются
подтверждёнными данными: смотреть factors, warnings и approval_blockers.

## Сценарии и ИИ

Партии: `GET /api/datasets/{id}/shipments`; отфильтровать supplier_id/sku.
ID брать из ответа: он непрозрачный и может содержать `/`.
`POST /api/runs/{run_id}/scenario`:

```json
{"shipment_id":"ID_ИЗ_ОТВЕТА","delay_days":30,"demand_change_pct":0}
```

Не передавать supplier_id в теле: он определён run. Ответ — новый run_id и
comparison. Сценарий заменяет предыдущие параметры относительно исходного
набора. Новый сценарий не изменяет уже созданный заказ.

`POST /api/scenarios/parse`:

```json
{"run_id":"RUN_ID","text":"Задержи выбранную поставку на 7 дней","selected_shipment_id":"ID_ИЗ_ОТВЕТА"}
```

Ответ: `scenario`, `needs_clarification`, `question`, `requires_confirmation`,
`status`. Показать параметры человеку, затем отдельно вызвать `/scenario`.
При fallback доступны ручные поля. Объяснение:
`POST /api/runs/{run_id}/explain` с `{"sku":"00001","language":"ru"}`.

## Заказ

1. `POST /api/orders`: `{"run_id":"RUN_ID","supplier_id":"systeme_electric","skus":["00001"]}`.
2. `PATCH /api/orders/{draft_id}`: `{"version":1,"changes":[{"sku":"00001","approved_qty":168,"reason":"Дополнительный запас"}]}`.
3. Показать предупреждения и получить действие пользователя.
4. `POST /api/orders/{draft_id}/approve`: `{"version":2,"acknowledge_warnings":true}`.
5. Скачать `GET /api/orders/{draft_id}/export.csv` через fetch с Bearer и Blob URL.

Версию брать из последнего ответа, не фиксировать 1/2 в коде. После 409 перечитать
заказ. Утверждённый заказ неизменяем. blocked/approval_blockers не снимаются
подтверждением предупреждений. При 401 сообщить об истечении сессии; не создавать
новую молча поверх несохранённого черновика. Восстановления аккаунта в MVP нет.

## Импорт

Отдельный администраторский процесс. `ADMIN_TOKEN` не включать в сборку/VITE_*.
`POST /api/imports`: Bearer + X-Admin-Token. Multipart-поля: **supplier**,
mapping_version, as_of, warehouse_id, повторяющееся поле files. Не supplier_id.
При FormData не задавать Content-Type вручную — браузер добавляет boundary.
Встроенный профиль `qor-explicit-xlsx-v1`: шесть XLSX с `_QOR_IMPORT` на одного
поставщика. CSV и произвольные реальные выгрузки им не поддерживаются.
Ответ 202 → import_id; опрашивать `/api/imports/{id}` до completed/failed/interrupted.
При completed использовать dataset_id. Прогресс дискретный 0/100.

## Приёмка UI

Данные → расчёт qor-mvp-1.0 → карточка → сценарий → правка → утверждение → CSV.
Контроль: SKU 00001, 156 → задержка 30 дней даёт 204; исходный заказ после
правки экспортирует 168. 00007 — 2 бухты; 00008 — блокировка неизвестных данных.
Проверить 401/409/422, null, пустой список и сохранение сессии при обновлении.
