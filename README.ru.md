# ompweb

<p align="center">
  <img src="public/icon.png" width="96" height="96" alt="ompweb logo" />
</p>

<p align="center">
  <strong>Web UI-приложение для кодинг-агента <a href="https://github.com/can1357/oh-my-pi">oh-my-pi (omp)</a>.</strong>
</p>

<p align="center">
  <a href="./README.md">English</a> | <a href="./README.zh-CN.md">简体中文</a> | <a href="./README.ja.md">日本語</a> | <a href="./README.ru.md">Русский</a>
</p>

ompweb предоставляет браузерное рабочее пространство для вашего локального omp-рантайма: просмотр сессий с навигацией по ветвям и форками, реалтайм-чат по RPC-протоколу omp, управление моделями / MCP / скиллами, переключение Git worktree и богатый предпросмотр файлов.

<details>
<summary>📸 Иногда скриншоты говорят лучше слов</summary>

| | |
| :---: | :---: |
| Основная рабочая область<br>![](screenshots/screenshot-main-workspace.png) | Композер новой сессии<br>![](screenshots/new-session-composer.png) |
| Развёрнутые детали обработки (вызовы инструментов)<br>![](screenshots/chat-expanded-details.png) | Панель задач композера<br>![](screenshots/composer-tasks-expanded.png) |
| Меню слэш-команд<br>![](screenshots/slash-command-popover.png) | Попап информации о сессии / контекста<br>![](screenshots/session-info-popover.png) |
| Палитра команд<br>![](screenshots/command-palette.png) | Модальное окно Git Graph<br>![](screenshots/gitgraph-commit-log.png) |
| Git Graph — дифф коммита<br>![](screenshots/gitgraph-commit-diff.png) | Вкладка просмотрщика файлов<br>![](screenshots/fileviewer-tab.png) |
| Список сессий (развёрнут)<br>![](screenshots/sidebar-sessions-full.png) | Просмотрщик архивных сессий<br>![](screenshots/archived-sessions.png) |
| Проводник (hover + mention)<br>![](screenshots/explorer-hover-mention.png) | Панель суб-агентов (задачи)<br>![](screenshots/rightpanel-taskmanager.png) |
| Git-панель (изменённые файлы)<br>![](screenshots/rightpanel-git.png) | Хаб Goal & Subagents (развёрнут)<br>![](screenshots/composer-goal-subagents.png) |
| Боковая панель чата<br>![](screenshots/rightpanel-sidechat.png) | Боковой чат (пустое состояние)<br>![](screenshots/rightpanel-sidechat-empty.png) |
| Панель файлов<br>![](screenshots/rightpanel-files.png) | Всплывающая подсказка миникарты чата<br>![](screenshots/minimap-tooltip.png) |
| Очередь восстановления при ошибке сервиса<br>![](screenshots/service-error-recovery.png) | Тема: Light (Warm Paper)<br>![](screenshots/screenshot-theme-light.png) |
| Диалог редактирования планировщика<br>![](screenshots/scheduler-edit-modal.png) | Палитра тем — статичная<br>![](screenshots/themepalette-static.png) |
| Палитра тем — текучая<br>![](screenshots/themepalette-flowing.png) | Палитра тем — анимация<br>![](screenshots/themepalette-motion.png) |
| Палитра тем — шрифт<br>![](screenshots/themepalette-font.png) | Настройки — интерфейс и поведение<br>![](screenshots/settings-interface-behavior.png) |
| Настройки — безопасность и разрешения<br>![](screenshots/settings-safety-approvals.png) | Настройки — параметры ИИ-моделей по умолчанию<br>![](screenshots/settings-ai-model-defaults.png) |
| Настройки — агент и интеллект<br>![](screenshots/settings-agent-intelligence.png) | Настройки — агенты<br>![](screenshots/settings-agents.png) |
| Настройки — расширения и инструменты<br>![](screenshots/settings-extensions-tools.png) | Настройки — нативные настройки OMP<br>![](screenshots/settings-omp-native.png) |
| Настройки — удалённый доступ<br>![](screenshots/settings-remote-access.png) | Настройки — центр навыков<br>![](screenshots/settings-skill-hub.png) |
| Настройки — система и обновления<br>![](screenshots/settings-system-updates.png) | Настройки — поиск<br>![](screenshots/settings-search.png) |
| Настройки — диагностика и восстановление<br>![](screenshots/settings-diagnostics.png) | Тема: omp Midnight<br>![](screenshots/screenshot-theme-omp-midnight.png) |
| Тема: Oatmeal Latte<br>![](screenshots/screenshot-theme-oatmeal-latte.png) | Тема: Monokai Pro<br>![](screenshots/screenshot-theme-monokai-pro.png) |
| Тема: Monokai Pro Spectrum<br>![](screenshots/screenshot-theme-monokai-pro-spectrum.png) | Тема: Omarchy Monokai<br>![](screenshots/screenshot-theme-omarchy-monokai.png) |
| Тема: Monochrome (Codex)<br>![](screenshots/screenshot-theme-monochrome-codex.png) | Тема: Monokai Pro Light Sun<br>![](screenshots/screenshot-theme-monokai-pro-light-sun.png) |
| Тема: Rosé Pine Dawn<br>![](screenshots/screenshot-theme-rose-pine-dawn.png) | Тема: Harbor<br>![](screenshots/screenshot-theme-harbor.png) |
| Тема: Catppuccin Mocha<br>![](screenshots/screenshot-theme-catppuccin-mocha.png) | Встроенный терминал (открыт)<br>![](screenshots/embedded-terminal.png) |
| Тема: Nord Arctic<br>![](screenshots/screenshot-theme-nord.png) | Тема: Kyoto Matcha<br>![](screenshots/screenshot-theme-matcha.png) |
| Тема: OLED Obsidian<br>![](screenshots/screenshot-theme-oled.png) | Тема: Warm Ember<br>![](screenshots/screenshot-theme-dark.png) |
| Тема: Antique Vellum<br>![](screenshots/screenshot-theme-sepia.png) | Тема: Dracula Velvet<br>![](screenshots/screenshot-theme-dracula.png) |
| Тема: Pine Forest<br>![](screenshots/screenshot-theme-pine.png) | Тема: Horizon Navy<br>![](screenshots/screenshot-theme-navy.png) |
| Тема: Monokai Classic<br>![](screenshots/screenshot-theme-monokai.png) | Тема: Monokai Pro Octagon<br>![](screenshots/screenshot-theme-monokai-pro-octagon.png) |
| Тема: Monokai Pro Machine<br>![](screenshots/screenshot-theme-monokai-pro-machine.png) | Тема: Monokai Pro Ristretto<br>![](screenshots/screenshot-theme-monokai-pro-ristretto.png) |
| Тема: Monokai Pro Light<br>![](screenshots/screenshot-theme-monokai-pro-light.png) | Тема: One Light<br>![](screenshots/screenshot-theme-one-light.png) |
| Тема: One Dark Pro<br>![](screenshots/screenshot-theme-one-dark-pro.png) | Тема: Catppuccin Latte<br>![](screenshots/screenshot-theme-catppuccin-latte.png) |
| Тема: Gruvbox Dark<br>![](screenshots/screenshot-theme-gruvbox-dark.png) | Тема: Tokyo Night<br>![](screenshots/screenshot-theme-tokyo-night.png) |
| Тема: Rosé Pine<br>![](screenshots/screenshot-theme-rose-pine.png) | Моб.: Light (Warm Paper)<br>![](screenshots/screenshot-theme-light-mobile.png) |
| Моб.: Nord Arctic<br>![](screenshots/screenshot-theme-nord-mobile.png) | Моб.: Oatmeal Latte<br>![](screenshots/screenshot-theme-oatmeal-mobile.png) |
| Моб.: Kyoto Matcha<br>![](screenshots/screenshot-theme-matcha-mobile.png) | Моб.: OLED Obsidian<br>![](screenshots/screenshot-theme-oled-mobile.png) |
| Моб.: Monochrome (Codex)<br>![](screenshots/screenshot-theme-codex-mobile.png) | Моб.: Warm Ember<br>![](screenshots/screenshot-theme-dark-mobile.png) |
| Моб.: Antique Vellum<br>![](screenshots/screenshot-theme-sepia-mobile.png) | Моб.: Dracula Velvet<br>![](screenshots/screenshot-theme-dracula-mobile.png) |
| Моб.: Pine Forest<br>![](screenshots/screenshot-theme-pine-mobile.png) | Моб.: Horizon Navy<br>![](screenshots/screenshot-theme-navy-mobile.png) |
| Моб.: Omarchy Monokai<br>![](screenshots/screenshot-theme-omarchy-monokai-mobile.png) | Моб.: Monokai Classic<br>![](screenshots/screenshot-theme-monokai-mobile.png) |
| Моб.: Monokai Pro<br>![](screenshots/screenshot-theme-monokai-pro-mobile.png) | Моб.: Monokai Pro Octagon<br>![](screenshots/screenshot-theme-monokai-pro-octagon-mobile.png) |
| Моб.: Monokai Pro Machine<br>![](screenshots/screenshot-theme-monokai-pro-machine-mobile.png) | Моб.: Monokai Pro Ristretto<br>![](screenshots/screenshot-theme-monokai-pro-ristretto-mobile.png) |
| Моб.: Monokai Pro Spectrum<br>![](screenshots/screenshot-theme-monokai-pro-spectrum-mobile.png) | Моб.: Monokai Pro Light<br>![](screenshots/screenshot-theme-monokai-pro-light-mobile.png) |
| Моб.: Monokai Pro Light Sun<br>![](screenshots/screenshot-theme-monokai-pro-light-sun-mobile.png) | Моб.: omp Midnight<br>![](screenshots/screenshot-theme-omp-mobile.png) |
| Моб.: One Light<br>![](screenshots/screenshot-theme-one-light-mobile.png) | Моб.: One Dark Pro<br>![](screenshots/screenshot-theme-one-dark-pro-mobile.png) |
| Моб.: Catppuccin Latte<br>![](screenshots/screenshot-theme-catppuccin-latte-mobile.png) | Моб.: Catppuccin Mocha<br>![](screenshots/screenshot-theme-catppuccin-mocha-mobile.png) |
| Моб.: Gruvbox Dark<br>![](screenshots/screenshot-theme-gruvbox-dark-mobile.png) | Моб.: Tokyo Night<br>![](screenshots/screenshot-theme-tokyo-night-mobile.png) |
| Моб.: Rosé Pine<br>![](screenshots/screenshot-theme-rose-pine-mobile.png) | Моб.: Rosé Pine Dawn<br>![](screenshots/screenshot-theme-rose-pine-dawn-mobile.png) |
| Моб.: Harbor<br>![](screenshots/screenshot-theme-harbor-mobile.png) |
</details>

## 🐳 Запуск в Docker

Проект в первую очередь адаптирован для работы в Docker (Linux): `docker-compose.yaml` в корне репозитория собирает образ, примонтирует репозиторий и мапит порты лаунчера. Запуск одной командой:

```bash
docker compose up -d --build
```

затем откройте [http://127.0.0.1:6767](http://127.0.0.1:6767) (пароль — в разделе **Переменные окружения** ниже).
Примечание: по умолчанию compose-файл пробрасывает `c:/users/dev/.omp` в `/root/.omp` внутри контейнера — перед запуском контейнера обновите путь `source:` на каталог `.omp` вашего пользователя (`~/.omp` на Linux, либо `c:/users/{user}/.omp` на Windows), чтобы контейнер использовал ваши существующие учётные данные, сессии и настройки.

Мобильная web-версия — полнофункциональный PWA: добавьте его на домашний экран телефона, и он будет вести себя как нативное приложение.
Сборка и запуск как самостоятельного Windows / Linux / macOS приложения поддерживаются не менее полно.
Форк проекта и его развитие поощряются.

## ⚙️ Порты

Лаунчер пробует порты `SIBLING_PORTS = [30177, 30178, 30179]` (зашиты в `bin/omp-web.js`); `docker-compose.yaml` мапит все три в контейнер. Используйте эти порты, когда агент запускает dev-сервер внутри контейнера, а вам нужно открыть/отладить его в браузере на хосте.

## 🔑 Пароль по умолчанию

Compose-файл по умолчанию задаёт `OMP_WEB_PASSWORD=asdf1234` — введите его на экране входа, либо замените на свой.

## 🔄 Пересборка и перезапуск (репозиторий примонтирован)

Когда репозиторий примонтирован в контейнер (дефолт compose), скрипт `ompweb-rebuild-restart.sh` регистрируется в **Script schedulers** настроек как планировщик *ручного запуска* — удобный способ пересобрать и передеплоить ompweb после того, как ваш агент изменил исходный код. После этого достаточно просто обновить страницу, чтобы подхватить новый билд. Когда новый билд задеплоен и OmpWeb запущен, вы получите уведомление в UI с кнопкой **Refresh page**. Обратите внимание: одновременно работающий dev-сервер ompweb иногда может сделать билд основного инстанса устаревшим.

## 🤖 Agents MCP

Встроенный мультимодельный **Agent MCP** сервер отключён по умолчанию. Включите его (Settings → Extensions & Tools → MCP), если планируете запускать и координировать различных агентов из OMP-агента.

## 🙏 Благодарности и улучшения

Проект включает улучшения, изначально внесённые форками `kahme247` и `37chengshan`, элегантно слитые в кодовую базу с сохранением только полезных функций; большинство исправлений предоставил Splinterjke. Основные улучшения:

- Основные баги с просмотром файлов, странное поведение скроллбара и тому подобное — в основном решено, но часть осталась специально для вас, хе-хе
- Настраиваемые параметры и приоритет сжатия контекста (Context Compaction)
- Большое количество новых тем и палитр (семейство Monokai, Omarchy Monokai, Catppuccin, Rosé Pine, Harbor, omp Midnight, Oatmeal Latte и многие другие) с исправленными surface-токенами и темизированным выделением текста
- Модальное окно Git Graph — визуализация истории репозитория с просмотром diff файлов по коммитам
- Улучшенная RPC / IPC связь, включая восстановление сессий и продолжение ходов после перезапуска сервера
- Исправления пересборки и перезапуска OmpWeb: уведомление о обновлении с явной кнопкой refresh, исключение loopback `/api/ui/refresh`, автоматическая регистрация ручного планировщика
- Улучшения миникарты чата / скроллбара: рельс на всю высоту, градиентный акцентный луч, ограничение ползунка высотой рельса, более крупные hover-подсказки
- Градиентный луч по периметру рамки чат-ввода (по часовой стрелке)
- Единообразные, обобщённые настройки размера шрифта
- Разворачиваемые и масштабируемые секции в левой панели, масштабируемые панели сайдбара / воркбенча
- Функциональность планировщика скриптов (интервал, ежедневно, еженедельно, cron, вручную) с отдельной панелью настроек
- Улучшенные страницы Skill Hub и Agents в настройках — Skill Hub и Agents показывают инстансы не только активного рабочего пространства, а каждого
- Более удачный композер новой сессии (выбор рабочего пространства, плюс-меню вложений, контекстное кольцо)
- Разворачиваемые блоки thinking и detail, инлайн-раскрытие полных вводов инструментов
- Трёхзонный верхний бар с хлебными крошками workspace / session по центру, popover «Session Info», хаб sub-agents в композере
- Удаление лишнего, наведение порядка в layout / отступах и производительности

## 🛠️ Переменные окружения

| Переменная | Описание | Значение по умолчанию / пример |
| :--- | :--- | :--- |
| `PORT` / `-p` / `--port` | Порт сервера | `6767` |
| `OMP_WEB_HOSTNAME` / `-H` / `--hostname` | Хост привязки | `127.0.0.1` |
| `OMP_WEB_PASSWORD` / `--password` | Пароль web-входа (дефолт compose: `asdf1234`) | *(не задан / отключено)* |
| `OMP_WEB_ALLOWED_HOSTS` | Разрешённые не-луупбэк хосты (через запятую) | *(пусто — только луупбэк)* |
| `OMP_WEB_NO_OPEN` | Не открывать браузер автоматически | `0` (`1` — пропустить) |
| `OMP_WEB_OMP_BIN` | Абсолютный путь к бинарнику `omp` | Ищется в `PATH` |
| `OMP_WEB_STT_ENDPOINT` | URL OpenAI-совместимого STT-эндпоинта | _нет (отключено)_ |
| `OMP_WEB_STT_KEY` | API-ключ для STT-эндпоинта | _нет_ |
| `OMP_WEB_STT_MODEL` | Имя модели для STT-эндпоинта | _нет_ |
| `PI_CODING_AGENT_DIR` | Домашний каталог OMP-агента | `~/.omp/agent` |
| `HTTP_PROXY` / `HTTPS_PROXY` | Прокси для серверных запросов | *(системный дефолт)* |

## 📄 Лицензия

Проект распространяется под [лицензией MIT](./LICENSE).
