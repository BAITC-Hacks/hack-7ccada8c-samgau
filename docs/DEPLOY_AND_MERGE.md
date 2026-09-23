# Публикация бэкенда и подключение интерфейса

Код уже находится в командном репозитории; повторно копировать архив капитана
поверх проекта не требуется. Перед изменениями получать свежую main, работать
в отдельной ветке и проверять diff. Алгоритм и импорт принадлежат участнику 2,
интерфейс — участнику 3. Не заменять их файлы копией старого пакета.

## Проверка версии перед публикацией

```bash
python -m pip install -r backend/requirements-dev.lock -r backend/requirements-engine.txt
python -m pytest
python scripts/export_openapi.py
git diff --check
```

`python` здесь — Python 3.12 из виртуального окружения. Docker использует
те же закреплённые runtime-зависимости. Шаблон CI находится в `docs/ci/`;
он не активирован из-за отсутствия права workflow у использованной авторизации.

## Сервер

Нужны Docker Engine/Compose, доступный сервер, домен с DNS на этот сервер,
порты 80/443. В серверном `.env`:

```dotenv
APP_ENV=production
SITE_ADDRESS=qor.example.kz
HTTP_PORT=80
HTTPS_PORT=443
CORS_ORIGINS=https://qor.example.kz
ENGINE_MODULE=app.engine.service
IMPORTER_MODULE=app.importers.service
```

Заменить домен настоящим и при необходимости
настроить выбранного ИИ-провайдера. Ключи хранятся только на сервере.
По умолчанию `IMPORT_ACCESS=session`: каждый посетитель загружает файлы без ключа
в свою сессию. Лимиты — 6 попыток/мин на сессию и 20 на сервер. Для закрытого
импорта явно задать `IMPORT_ACCESS=admin` и `ADMIN_TOKEN`: API-клиент должен
передавать `X-Admin-Token`, загрузка через UI в этом режиме недоступна.
Compose сохраняет SQLite/загрузки в /data, один worker. При обновлении не
удалять volumes; предварительно сделать резервную копию базы и данных.

```bash
docker compose up --build -d
docker compose ps
python scripts/smoke.py --url https://qor.example.kz
python scripts/ai_smoke.py --url https://qor.example.kz
```

Обычный smoke работает без ИИ; ai_smoke требует настроенного провайдера и
ответа generated. Проверить HTTPS и основной сценарий с другого устройства.
Домен, сервер и живой вызов провайдера этой доработкой не публиковались.

## Когда frontend будет готов

Передать [FRONTEND_HANDOFF.md](FRONTEND_HANDOFF.md), [openapi.json](openapi.json)
и [api-client.ts](../examples/api-client.ts). Сначала согласовать Bearer,
форматы ответов, выбор поставщика, сценарий и заказ. Прогнать браузерный сценарий
на API, затем собирать UI в режиме api с относительным /api.

Корневой Compose раздаёт содержимое deploy/web через Caddy и проксирует /api
в api:8000. При интеграции выбрать один процесс сборки frontend и доставки
его dist в deploy/web. Отдельный frontend/compose.yaml сейчас является
самостоятельной демонстрацией: не запускать два web на одном порту.

До сдачи: публичная HTTPS-ссылка, фактическое подключение UI к серверному
движку, контроль экспорта 168, проверка ИИ, README с ограничениями и вкладом
участников, данные доступа на платформе организатора.
