# clan-officers-panel

Закрытая офицерская панель клана **SanTDeviL** для ведения реестра принятых в клан игроков.

Каждой записи автоматически высчитывается срок 7-дневного иммунитета (без обязанности доблести/событий). Реестр публикуется как закреплённое сообщение с авто-обновляемой картинкой в офицерских чатах **Telegram** и **VK**.

## Архитектура

```
┌──────────────────────┐         ┌────────────────────────┐
│  GitHub Pages        │ ──────► │  Cloudflare Tunnel     │
│  (frontend, static)  │  HTTPS  │  *.trycloudflare.com   │
│  Matrix UI + JS      │         └───────────┬────────────┘
└──────────────────────┘                     │
                                             ▼
                                ┌──────────────────────────┐
                                │  FastAPI (на ПК)         │
                                │  • OAuth TG + VK         │
                                │  • SQLite (acceptances)  │
                                │  • Audit log             │
                                │  • APScheduler (5 min)   │
                                │  • Renderer (Chrome→PNG) │
                                │  • TG bot (aiogram)      │
                                │  • VK bot (vk_api)       │
                                └────────────┬─────────────┘
                                             │
                            ┌────────────────┴────────────────┐
                            ▼                                 ▼
                     Officer TG chat                   Officer VK chat
                     (pinned message)                  (pinned message)
```

## Структура

- `backend/` — FastAPI app, БД, OAuth, шедулер, боты (живёт на ПК)
- `frontend/` — статика для GitHub Pages: HTML, JS, Matrix rain, форма
- `render/` — HTML-шаблон и Chrome-рендерер для генерации PNG
- `data/` — SQLite БД (локально, не в git)

## Авторизация

Whitelist офицеров берётся из соседнего проекта `clan-bridge-admin-bot`:
- `tg_users.json` — Telegram user_id → username
- `vk_users.json` — VK user_id → имя

Авторизация — Telegram Login Widget + VK ID OAuth. Кто не в списке — на сайт не зайдёт.

## Запуск

```bash
cd backend
pip install -r requirements.txt
python -m uvicorn app:app --host 0.0.0.0 --port 8765
```

## Сайт

GitHub Pages: `https://buzzword001.github.io/clan-officers-panel/`
