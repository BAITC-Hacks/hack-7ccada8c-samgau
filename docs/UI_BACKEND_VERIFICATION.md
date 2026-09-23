# UI ↔ backend: интеграция и финальный прогон

Интеграционная ветка `codex/full-ui-backend-integration`, база — актуальный `main`
`4e551d8` (содержит PR #3, dashboard redesign, PR #4, backend, PR #5,
обмен 1С и 3D-склад, и отчёт участника 2).
Математический движок `backend/app/engine` и импортёр `backend/app/importers`
сохранены без изменений. Дизайн участника 3 сохранён; добавлены необходимые
поля поставки, подтверждение предупреждений, импорт и сохранённые заказы.

## Матрица UI / API / состояния

| Функциональность | Endpoint / модель | Реализация |
|---|---|---|
| Сессия API и трёх AI-функций | POST `/api/sessions`, `SessionResponse` | Один token в sessionStorage, конкурентные запросы используют один promise. 401 не заменяет сессию. Новая сессия — явное действие с предупреждением о потере доступа. |
| Наборы / область склада | GET `/api/datasets`, `DatasetList.items` | Предпочтение `demo-engine-v1`; канонические warehouse/supplier IDs, `as_of`, метка synthetic/real. Ошибка не переключает приложение на локальное демо. |
| Общий склад | POST `/api/runs`, `RunResponse` | Отдельные run `systeme_electric` и `iek`; локальная группа никогда не отправляется как server run_id. Summary суммируется один раз на run. |
| Таблица, поиск, фильтры | GET `/api/runs/{id}/recommendations` | Все страницы по 100, затем фильтрация и страницы UI. Ключ строки = supplier + SKU. Сбой одного поставщика делает общий расчёт неуспешным. |
| Неизвестные данные | `Recommendation` | Сохраняются null, unknown, ready/review/blocked, approval_blockers. Недопустимые строки нельзя выбрать. Неизвестные anomaly/category/coverage не выдумываются. |
| Единицы | `unit`, `stock_unit`, `stock_units_per_order_unit` | Таблица, паспорт, графики и чат различают склад/заказ; причины и источники факторов сохраняются. |
| История / траектория | GET `/api/runs/{id}/products/{sku}` | Реальные history и trajectory; null сохраняется, неполные месяцы отмечены. Baseline сценария берётся из исходного run и сопоставляется по ISO-дате. |
| Качество | GET `/api/datasets/{id}/quality` | Реальные source_count/mapped_skus/issues/warnings; 0 источников synthetic отображается как 0. |
| Партии / сценарии | GET `/api/datasets/{id}/shipments`; POST `/api/runs/{base}/scenario` | Пользователь выбирает shipment_id. Задержка относится к одной партии. Demand-only all вызывает отдельный сценарий каждого поставщика; повторные сценарии стартуют от base. Кнопка восстановления возвращает весь исходный набор. |
| Разбор сценария | POST `/api/scenarios/parse` | Реальный base run_id + selected_shipment_id; clarification/fallback не применяет параметры; успешный разбор ждёт отдельного сравнения. |
| Объяснение | POST `/api/runs/{id}/explain` | `status` отображается как generated/fallback без подмены расчётной справки ИИ-ответом. |
| Чат | POST `/api/assistant/messages` | Общая Bearer-сессия, run_ids, SKU, supplier и обе единицы. Сервер проверяет ownership и заменяет числа канонической рекомендацией; real-data запрет определяется также по серверным run. |
| Заказ | POST `/api/orders`; PATCH `/api/orders/{id}` | Create получает skus; ручная правка отправляется PATCH с version и причиной от 3 непробельных символов. ID/version сохраняются после операций; ошибочный PATCH не создаёт новый заказ при повторе. |
| Предупреждения / approve | POST `/api/orders/{id}/approve` | Отдельный checkbox после вывода предупреждений; acknowledge_warnings не включается автоматически. Блокеры не снимаются ручным количеством или подтверждением. |
| Версии / восстановление | GET `/api/orders`, GET `/api/orders/{id}` | 409 перечитывает snapshot и требует нового действия. 401/422/500 показываются. Сохранённые заказы открываются после reload; утверждённые значения отображаются из серверного snapshot. Локально сохраняются компактные ссылки, а не история/траектория каждого товара. |
| CSV | GET `/api/orders/{id}/export.csv` | Bearer fetch → Blob только после approve; ведущие нули SKU, единицы и утверждённое количество берутся с сервера. |
| Импорт | POST `/api/imports` → GET `/api/imports/{id}` | UI: шесть XLSX одного supplier, FormData, автоматически созданная Bearer-сессия без административного ключа, опрос queued/running, completed/failed/interrupted. Завершённый dataset выбирается в той же браузерной сессии. |
| Production | `compose.yaml`, `deploy/Dockerfile.web`, Caddy | Node 22 build → Caddy static React; same-origin `/api` → FastAPI; API без внешнего порта; постоянные SQLite/uploads и Caddy volumes. `deploy/web` не перекрывает сборку. |

## Повторяемый локальный прогон

Из корня checkout, Python 3.12:

```sh
uv venv .venv --python 3.12
uv pip install --python .venv/bin/python -r backend/requirements-dev.lock -r backend/requirements-engine.txt
.venv/bin/python -m pytest
.venv/bin/python scripts/export_openapi.py
npm --prefix frontend ci
npm --prefix frontend test
npm --prefix frontend run build
cd frontend && npx playwright install chromium && cd ..
```

Существующие `.venv` и `.env` не перезаписывать. По умолчанию `IMPORT_ACCESS=session`:
импорт доступен каждому посетителю в автоматически созданной сессии без административного ключа.
Без `.env` Compose работает с отключённым ИИ; импорт доступен.
Лимиты импорта: 6 попыток/мин на сессию и 20 на сервер. Команды проверки ниже
предназначены для режима `session`. При явном `IMPORT_ACCESS=admin` API дополнительно
требует `X-Admin-Token` из серверного `ADMIN_TOKEN`, а загрузка через UI недоступна.

```sh
HTTP_PORT=18080 HTTPS_PORT=18443 docker compose -p qor-integration-test up --build -d
.venv/bin/python scripts/smoke.py --url http://127.0.0.1:18080
.venv/bin/python scripts/e2e_smoke.py --url http://127.0.0.1:18080 --with-import
.venv/bin/python scripts/import_smoke.py --url http://127.0.0.1:18080 --state-file /tmp/qor-persistence.json
HTTP_PORT=18080 HTTPS_PORT=18443 docker compose -p qor-integration-test restart api
# Дождаться healthy: docker compose -p qor-integration-test ps
.venv/bin/python scripts/import_smoke.py --url http://127.0.0.1:18080 --state-file /tmp/qor-persistence.json --resume
```

State-file содержит Bearer token, создаётся с правами 0600 и должен быть новым
путём для каждого прогона; не прикладывать его к PR. Не использовать `down -v`.
E2E без `--with-import` пропускает только browser upload; весь прочий UI прогоняется.
В API smoke нет моков движка; E2E 401/500 намеренно подменяет только ответы ошибок.
Основной happy path, 409/422, CSV, import и две сессии работают с реальным FastAPI.

## Контрольные результаты и границы

- 00001: 156; задержка выбранной партии +30 дней: 204; восстановление: 156;
  ручной PATCH: 168; утверждённый CSV: 168. Повторное открытие сохраняет 168.
- 00007 (IEK): 2 бухты × 305 м/бухта; складские показатели и графики в метрах.
- 00008 (Systeme Electric): blocked/null; ручная правка и approve не обходят блокировку.
- Импорт: 12 **синтетических** XLSX, по шесть на поставщика; dedup и приватность.
- Persistence: сессия, импортированные наборы, run, утверждённый CSV и
  неутверждённый черновик с version/ручным количеством сохраняются после restart.
- Проверены desktop и мобильная ширина 390 px; переключение на локальное демо
  возможно только вручную. Демо-интерфейс остаётся отдельным синтетическим примером.

Реальный внешний AI в этом прогоне выключен. В доступной локальной копии
`samgau-integrated/.env` провайдер disabled; эффективного ключа/модели нет.
Упоминание ключа в новом BACKEND_LOGIC_REVIEW относится к окружению автора обзора. Для завершения нужны ключ провайдера,
модель и разрешённый HTTPS endpoint. Заполнить серверный `.env` по `.env.example`,
перезапустить API и выполнить:

```sh
.venv/bin/python scripts/ai_smoke.py --url https://YOUR_DOMAIN
```

Этот smoke теперь проверяет **explain + parse + chat**, требует `generated`,
не считает fallback успешным вызовом модели. Контракт generated/timeout/fallback
проверяется backend-тестами с MockTransport, это не проверка реального провайдера.
`ALLOW_REAL_AI=false` оставить до явного разрешения передачи данных компании.

Реальные Excel не предоставлены. Участнику 2 нужны 12 исходных книг и сопоставления
листов/колонок, складских единиц, периода и покрытия. Штатный профиль
`qor-explicit-xlsx-v1` требует `_QOR_IMPORT`; прохождение синтетических книг
не доказывает поддержку произвольного реального формата.

Публичный HTTPS требует сервер, домен/DNS, открытые 80/443 и SSH/deploy-доступ.
Настроить `SITE_ADDRESS`, `HTTP_PORT=80`, `HTTPS_PORT=443`, `CORS_ORIGINS`,
секреты только в серверном `.env`, выполнить `docker compose up --build -d`,
затем те же smoke/E2E по домену. Локальный HTTP не является проверенным публичным HTTPS.

Отдельно от интеграции остаются нагрузка на больших реальных выгрузках и
бизнес-валидация прогноза на реальных данных. Сборка предупреждает о размере
основного JS chunk; это не блокирует текущий рабочий процесс.

Explain принимает kk, но текущий проверяемый шаблон возвращается на русском
с явным language=ru; чат допускает русский/казахский ответ провайдера.
Для выбранного live-провайдера также необходимо проверить совместимый лимит
генерации и укладывание в существующий timeout; это отмечено в обзоре участника 2.

## Исходный прогон 23.09.2026 (до слияния PR #5)

- Backend pytest: **101 passed** (Python 3.12.14).
- Frontend Vitest: **15 passed**; TypeScript + Vite production build успешен.
- Docker Compose: оба образа собраны; API healthy, React доступен через Caddy.
- HTTP engine smoke: **PASS**, включая 00008/422 и session isolation.
- Chromium E2E: **7 passed**, включая импорт через форму, явное acknowledge,
  сохранение после reload, 409/422 и отсутствие demo fallback при 401/500.
- HTTP import smoke: **12 синтетических XLSX**, dedup, isolation — PASS.
- Restart/resume: **PASS**, включая version и 180 в неутверждённом черновике,
  сохранённый утверждённый CSV с 168 и исходные импортированные run.
- OpenAPI экспортирован, `git diff --check` без замечаний. Код движка и импортёра
  не отличается от актуального main; новые документы участника 2 объединены.

Локальный тестовый стенд оставлен запущенным: `http://127.0.0.1:18080`.

## Согласование с PR #5 и PR #6

В ветку включён main `4e551d8` после PR #5. Сохранены профиль
`hackalem-2026-v1`, экран «Обмен с 1С», поле `data_mode` в заказе/CSV
и интерактивный 3D-склад. Склад использует составной ключ поставщик + SKU
и канонические blocked/unknown; предупреждения переводятся только при отображении.
Код математического движка и импортёров совпадает с main.
README оставлен в версии main: оформление и актуализация инструкции находятся
в PR #6, чтобы два PR не конфликтовали между собой.

Повторный прогон после разрешения конфликтов: **108 backend-тестов**, **15 frontend-тестов**,
TypeScript/Vite build и сборка Compose успешны. API healthy; HTTP smoke проходит
156 → 204 → 168 → CSV и изоляцию сессий. **9 Chromium E2E** проходят,
включая прежние семь сценариев, blocked в 3D-складе и обмен 1С/шаблон/ссылку помощника.
Профиль исходных файлов дополнительно проверен backend-тестом полного пути
upload → run → acknowledgement → approve → CSV с `data_mode=real`.
