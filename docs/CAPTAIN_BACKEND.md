> Интеграция 23.09.2026: [реализованные контракты, проверки и точный остаток](UI_BACKEND_VERIFICATION.md). Ниже сохранён исходный handoff.

# Бэкенд QOR AI: запуск и проверка

API 0.2.0, контракт данных 1.0. FastAPI соединяет движок участника 2,
импортер XLSX, SQLite, сессии, сценарии, заказы и CSV. Набор `demo-engine-v1`
регистрируется автоматически, рассчитывается алгоритмом `qor-mvp-1.0`.

## Запуск

Python 3.12, команды из корня проекта:

```bash
python3.12 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements-dev.lock -r backend/requirements-engine.txt
cp .env.example .env
.venv/bin/python run.py
```

Если .env уже существует, сохранить его. Windows: `py -3.12 -m venv .venv`,
затем `.venv\Scripts\python.exe`; копирование — `copy .env.example .env`.
API: <http://127.0.0.1:8000/api/docs>. Ключ ИИ для запуска не требуется.

По умолчанию, включая пустые значения старого .env:

```dotenv
ENGINE_MODULE=app.engine.service
IMPORTER_MODULE=app.importers.service
```

Ошибочный модуль обнаруживается при старте. Основной набор — demo-engine-v1,
поставщики systeme_electric и iek. Старый demo-platform-v1 остаётся фикстурой API.

## Docker и проверки

```bash
docker compose up --build -d
.venv/bin/python -m pytest
.venv/bin/python scripts/export_openapi.py
.venv/bin/python scripts/smoke.py --url http://localhost:8080
.venv/bin/python scripts/smoke.py --url http://localhost:8080 --fixture
```

API через Caddy: <http://localhost:8080/api/docs>. Корневая страница — заглушка
бэкенда, подключение интерфейса выполняется отдельно. SQLite и загрузки —
в volume qor_data. Один API worker. `docker compose down` сохраняет данные;
не использовать down -v для обычного перезапуска.

Основной smoke проверяет движок, два поставщика, 156 → 204 → правка 168 →
утверждение → CSV, единицы кабеля, конфликт версии и изоляцию сессий.

По умолчанию `IMPORT_ACCESS=session`: импорт доступен каждому посетителю без административного ключа.
Скрипт сам создаёт Bearer-сессию; импортированные данные закрыты другим сессиям.
Лимит: 6 попыток импорта в минуту на сессию и 20 на сервер, до 64 МиБ за запрос.
При явном `IMPORT_ACCESS=admin` API требует дополнительный `X-Admin-Token`
из серверного `ADMIN_TOKEN`. Скрипты импорта ниже предназначены для режима `session`.

```bash
mkdir -p data
.venv/bin/python scripts/import_smoke.py --url http://localhost:8080 --state-file data/import-smoke-state.json
docker compose restart api
# Дождаться healthy в docker compose ps:
.venv/bin/python scripts/import_smoke.py --url http://localhost:8080 --state-file data/import-smoke-state.json --resume
```

В Windows создать папку командой `mkdir data`. State-file содержит токен
тестовой сессии: хранить в data/ и удалить после проверки. Для нового прогона
использовать новое имя: существующий файл не перезаписывается.
Скрипт создаёт 12 синтетических XLSX, проверяет импорт обоих поставщиков,
дедупликацию, расчёт, приватность; resume — сохранность данных после перезапуска.

## Данные и ограничения

Профиль qor-explicit-xlsx-v1 принимает шесть XLSX одного поставщика с явным
маппингом на скрытом листе _QOR_IMPORT. ZIP предварительно распаковать;
максимум 12 файлов и 64 MiB. CSV встроенным профилем не поддерживается.
Реальные выгрузки требуют проверки схем, единиц и покрытия участником 2;
исходные коммерческие файлы в текущей задаче не предоставлены.
Импортированные наборы приватны и имеют mode=real, включая тестовые загрузки.
Пересчёт работает по сохранённому DatasetPayload без исходных временных файлов.

DATABASE_PATH — файл SQLite; иначе QOR_DATA_DIR/qor.sqlite3. Загрузки —
QOR_DATA_DIR/uploads. В Docker всё находится в /data. Сессия действует 7 суток;
аккаунтов/восстановления потерянного токена нет. Политику удаления коммерческих
данных определяет владелец сервера.

## ИИ

Движок считает количества, ИИ разбирает сценарий и выбирает подтверждённые факторы.
Настройки: AI_PROVIDER=openai + OPENAI_API_KEY/OPENAI_MODEL либо
AI_PROVIDER=nvidia + NVIDIA_API_KEY/NVIDIA_MODEL/NVIDIA_BASE_URL.
Непустые AI_API_KEY/AI_MODEL/AI_BASE_URL имеют приоритет. NVIDIA требует своего
HTTPS endpoint. AI_RESPONSE_FORMAT=json_schema либо json_object по поддержке модели.

После настройки и перезапуска: `python scripts/ai_smoke.py --url http://localhost:8080`.
Тест требует generated; fallback не считается подключением ИИ. Проверка использует
синтетический набор. 23.09.2026 живой вызов OpenAI gpt-6-luna проверен: сценарий,
факторы, чат по расчётам, навигация и продолжение на казахском. Настройка для сервера:
[ASSISTANT.md](ASSISTANT.md). Ключ хранится отдельно в серверном .env и в Git не переносится.
ALLOW_REAL_AI=false запрещает внешнюю обработку реальных наборов. Текст объяснения
на русском; полная локализация kk не реализована.

## Передача интерфейсу

[FRONTEND_HANDOFF.md](FRONTEND_HANDOFF.md) — порядок соединения и точные поля.
[API.md](API.md) — маршруты; [openapi.json](openapi.json) — машинная схема;
[../examples/api-client.ts](../examples/api-client.ts) — клиент с Bearer и CSV.
Публикация сервера/HTTPS: [DEPLOY_AND_MERGE.md](DEPLOY_AND_MERGE.md).
