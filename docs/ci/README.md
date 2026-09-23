# Шаблон GitHub Actions

`backend.yml` проверяет API на Linux, Windows и macOS, затем собирает Docker
Compose и запускает HTTP smoke. Шаблон сохранён здесь, потому что текущая
авторизация GitHub CLI не имеет права `workflow` на публикацию файлов
`.github/workflows/`. Автоматические проверки пока не активированы.

Участник с подходящим доступом может перенести файл в
`.github/workflows/backend.yml` и закоммитить его. Локальные проверки
объединённого проекта уже выполнены; результаты — в `../VERIFICATION.md`.
