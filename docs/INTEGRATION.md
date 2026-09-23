> Обновление API 0.2.0: оба сервиса уже реализованы участником 2 и включены
> по умолчанию. `demo-engine-v1` регистрируется при запуске автоматически.
> Ниже сохранены требования к контракту для дальнейших изменений модулей.
> Текущий запуск: `CAPTAIN_BACKEND.md`; передача UI: `FRONTEND_HANDOFF.md`.

# Передать второму backend-разработчику

## Одна схема объединения

Ты делаешь данные и алгоритм. Капитан уже реализовал HTTP, базу, сессии,
сценарии, черновики, утверждение, ИИ и CSV. Создавать второй FastAPI не нужно.

Добавь в общий проект:

```text
backend/app/engine/__init__.py
backend/app/engine/service.py
backend/app/importers/__init__.py
backend/app/importers/service.py
backend/tests/test_engine.py
backend/requirements-engine.txt
```

Папки `engine` и `importers` намеренно не заполнены чужой реализацией.
Контракт уже в `app.contracts`; не копируй его в свои модели с другими именами.

## Функция 1 — импорт

```python
# backend/app/importers/service.py
from app.contracts import DatasetPayload, ImportRequest

def import_dataset(request: ImportRequest) -> DatasetPayload:
    # Здесь твои адаптеры, очистка, нормализация и quality report.
    # request.files: path, original_name, sha256; path уже локальный.
    # Верни DatasetPayload. Не возвращай DataFrame или numpy scalar.
    ...
```

Обязательный результат:

```json
{
  "name": "IEK — Алматы",
  "mode": "real",
  "as_of": "2026-09-22",
  "warehouse_id": "almaty",
  "supplier_ids": ["IEK"],
  "version": "iek-mapping-v1-data-v1",
  "quality": {
    "warnings": ["Нет ID клиента"],
    "sources": ["sales", "monthly_sales", "stocks", "incoming", "seasonality", "moq"]
  },
  "shipments": [
    {"id": "iek-po-7583-line-1", "sku": "00123_", "supplier_id": "IEK", "quantity": 50, "eta": "2026-10-10"}
  ],
  "data": {"products": [], "sales": [], "monthly_metrics": []}
}
```

`data` — твоя JSON-структура для расчёта. Ты владеешь её внутренней схемой;
капитан хранит и передаёт её без изменений. Преобразуй datetime в ISO,
NaN в null, numpy-типы в Python. Не клади туда пути к временным файлам:
после перезапуска расчёт должен работать по сохранённым данным.

Для каждого импорта один supplier и одна область склада. `as_of`, `warehouse_id`,
`supplier_ids` должны совпасть с запросом. `mode=real` для загруженных файлов:
публичный клиент не может объявить реальные коммерческие данные синтетическими.
Адаптер проверяет обязательные типы источников/соответствие поставщику и не скрывает
неизвестные данные. Обработка формул XLSX/архивных лимитов внутри XLSX — задача импортера.

ID партий уникальны во всём dataset, включая строки разных товаров одной накладной.
Детальная история и месячные итоги не суммируются. Поле `shipments` использует
складские единицы и нужно также для проверки сценария на уровне API.

## Функция 2 — расчёт

```python
# backend/app/engine/service.py
from app.contracts import CalculationParameters, DatasetPayload, EngineResult

def calculate(dataset: DatasetPayload, params: CalculationParameters) -> EngineResult:
    # Чистая функция. Не изменяй dataset и не обращайся к сети/SQLite/FastAPI.
    # Используй params.scenario, верни EngineResult.
    ...
```

`params`: supplier_id, as_of, lead_time_days, review_days, safety_days,
scenario.shipment_id, scenario.delay_days, scenario.demand_change_pct.

- Параметры L/R/страховых дней — явные значения этого расчёта. Не игнорируй их.
- Если политика категории их уточняет, отрази эффективные параметры в factors.
- Переданный прогноз прироста хранится в dataset.data и учитывается твоим модулем.
- Сценарное изменение спроса — дополнительный множитель `1 + pct / 100`.
- Новый сценарий полностью заменяет старый относительно исходного dataset.
  Задержки не накапливаются при повторной отправке одной формы.
- Сдвигается только выбранная строка поставки; применять ко всей накладной
  можно после согласованного расширения контракта.
- Только выбранный supplier и warehouse. SKU должен быть уникален в этой области.
- Результат включает `algorithm_version` и список Recommendation.

## Строка рекомендации — ключевые правила

Полный тип: `backend/app/contracts.py`, класс `Recommendation`.

| Поле | Смысл |
|---|---|
| sku | Строковый код 1С, ведущие нули сохраняются |
| unit | Единица заказа: штука/бухта и т.д. |
| stock_unit | Единица складского учёта |
| stock_units_per_order_unit | Сколько складских единиц в единице заказа; null если неизвестно |
| available_stock, eligible_incoming, forecast_qty, safety_stock, raw_need | Все в складских единицах |
| recommended_qty, moq, order_step | Все в единицах заказа |
| data_status | ready / review / blocked |
| approval_blockers | Причины, запрещающие утверждение даже после ручной правки количества |
| factors | Уникальные коды факторов, числа/единицы, observed/estimated/assumed/missing и source |
| explanation | Готовое расчётное объяснение без ИИ; должно совпадать с числами |
| history | JSON-точки истории для frontend; согласуйте ключи с участником 3 |
| trajectory | Предпочтительно date, without_order, with_order; запасы могут быть отрицательными |

Для кабеля: `unit="бухта"`, `stock_unit="м"`, factor=305,
`raw_need=400`, `recommended_qty=2`. Капитан экспортирует 2 бухты и 610 м.
Если неизвестен остаток/коэффициент/расчёт — null и blocked. Не подставляй ноль.
Если есть неточность без блокера — review и явное warnings.

## После слияния

1. Добавить закреплённые зависимости в `backend/requirements-engine.txt`.
2. Выставить `.env`: `ENGINE_MODULE=app.engine.service`, `IMPORTER_MODULE=app.importers.service`.
3. Перезапустить сервер. Импортировать набор через POST /api/imports с Bearer автоматически созданной сессии. По умолчанию `IMPORT_ACCESS=session`, административный ключ не нужен; при явном `IMPORT_ACCESS=admin` добавить `X-Admin-Token` из серверного `ADMIN_TOKEN`. Лимиты: 6 попыток/мин на сессию и 20 на сервер.
4. Дождаться completed, взять dataset_id, вызвать POST /api/runs.
5. Проверить сценарий, объяснение, черновик, approve, CSV.
6. Выполнить `python -m pytest`, затем `python scripts/smoke.py` при запущенном API.

`backend/tests/test_platform.py::test_import_plugin_dedup_scope_and_run` показывает
реальный вызов обоих контрактов API через подключаемый модуль.
В тесте используется подставной importer — это проверка соединения, не Excel-алгоритма.

## Что обязательно покрыть твоими тестами

12 реальных форматов/источников; знаки/пропуски; сезонность; устойчивый рост;
проектные заказы и синтетические клиентские ID; stockout; входящие по датам;
категории; MOQ и кратность; метры/бухты; отсутствие двойного учёта.
Текущие платформенные тесты эти расчёты не заменяют.

Контракт меняем только вместе. API не должен незаметно перестать работать
из-за переименования `recommended_qty` в `quantity` или изменения единиц.
