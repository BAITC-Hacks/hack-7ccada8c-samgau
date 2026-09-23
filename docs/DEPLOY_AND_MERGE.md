# Капитан: объединение и сервер

## Что передать команде сейчас

- Backend 2: contracts.py + INTEGRATION.md. Его файлы только engine/, importers/ и тесты.
- Frontend: API.md + openapi.json + api-client.ts. Его папка frontend/.
- Твоя ветка: codex/platform-ai. Другие: codex/data-engine и codex/ui.
- Точки соединения фиксированы: один FastAPI, один набор типов, один файл Compose.

## Перенос пакета в выданный Git-репозиторий

Эти команды выполняются на вашей машине внутри уже клонированного командного
репозитория. Архив не содержит `.git` и не является клоном GitHub.

```bash
git status
git switch -c codex/platform-ai
```

Если ветка уже существует, использовать `git switch codex/platform-ai`.
Скопировать содержимое пакета в корень репозитория. Сначала сравнить уже
существующие общие файлы; не перезаписывать чужие изменения без просмотра diff.
Архив не содержит исходные Excel, реальные ключи и данные.

```bash
git diff
git add backend docs scripts examples deploy .github .gitignore .gitattributes .dockerignore .env.example Dockerfile compose.yaml pytest.ini README.md run.py
git commit -m "Add QOR platform API, integration contract and order workflow"
git push -u origin codex/platform-ai
```

Участник 2 сначала получает твой контракт, затем добавляет свою часть.
После появления удалённых веток:

```bash
git fetch origin
git merge origin/codex/data-engine
git merge origin/codex/ui
```

Если репозиторий требует PR, делать слияние через PR. Реальную основную ветку
смотрите в репозитории — не предполагаем автоматически `main` или `master`.
В конфликтах общих типов сохраняйте согласованный контракт, а не выбирайте
всю чужую или свою версию файла одной командой.

После слияния:

```bash
python -m pip install -r backend/requirements-dev.lock -r backend/requirements-engine.txt
python -m pytest
python scripts/export_openapi.py
```

Затем настроить ENGINE_MODULE/IMPORTER_MODULE, проверить реальный импорт и запустить
HTTP smoke. Зафиксировать рабочий коммит перед демонстрацией.

## Подключение React

Участник 3 собирает production frontend своим закреплённым package-lock:

```bash
npm ci
npm run build
```

Копировать **содержимое** frontend/dist в deploy/web с заменой placeholder index.html.
В production base URL API пустой, запросы идут на `/api/...`.
Не размещать frontend dev server на публичном сервере.

## Сервер и HTTPS

Для публикации необходимы доступный Linux-сервер, Docker/Compose, домен,
указывающий на сервер, и доступные порты 80/443. Эти доступы в задаче не предоставлены.

В `.env` сервера:

```dotenv
APP_ENV=production
SITE_ADDRESS=qor.your-real-domain.kz
HTTP_PORT=80
HTTPS_PORT=443
CORS_ORIGINS=https://qor.your-real-domain.kz
```

Заменить домен настоящим. Дополнительно настроить admin-токен, модули и ИИ.

```bash
docker compose up --build -d
docker compose ps
docker compose logs --tail=100 api web
python scripts/smoke.py --url https://qor.your-real-domain.kz
python scripts/ai_smoke.py --url https://qor.your-real-domain.kz
```

Caddy получает сертификат при корректных DNS и сетевых условиях; для `:80`
работает локальный HTTP. Проверить с другого устройства фронтенд и скачивание CSV.
Нет внешнего порта API/SQLite. Не запускать несколько API-контейнеров или workers:
ограничитель фонового импорта рассчитан на один процесс.

## Финальная проверка капитана

1. `/api/health` открыт; engine/importer/AI настроены.
2. Импорт реальных файлов успешно завершён, quality report доступен.
3. Тесты алгоритма участника 2 покрывают все must-have, включая синтетические ID клиентов.
4. Реальный ИИ smoke выдаёт PASS; fallback не считается выполненным критерием ИИ.
5. Изменение сценария создаёт новый run, старый черновик остаётся связан со старым.
6. После перезапуска данные и сессия сохранены.
7. Браузеры двух проверяющих не видят чужие черновики.
8. CSV содержит утверждённое количество и верные единицы.
9. Живая ссылка, README, ограничения и вклад трёх участников добавлены в сдачу.

Демонстрационный smoke платформы работает даже без алгоритма. Для сдачи всего
кейса обязательно пройти пункты 2–4 с фактической интеграцией.
