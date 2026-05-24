# Запуск clan-officers-panel — пошагово

## 1. Создать Telegram-бота

1. Открой [@BotFather](https://t.me/BotFather) → `/newbot` → имя `SanTDeviL Officers Bot` → username `santdevil_officers_bot` (или любой свободный).
2. Скопируй токен → положи в `backend/.env` как `TG_BOT_TOKEN`.
3. У того же BotFather: `/setdomain` → выбери своего бота → введи домен фронтенда (например `buzzword001.github.io`). Это нужно для Telegram Login Widget.
4. Добавь бота в офицерский TG-чат и **дай админ-права** (минимум: пин сообщений, отправка фото).
5. Узнай `chat_id` офицерского чата → положи в `.env` как `TG_OFFICER_CHAT_ID`. Если не знаешь — `clan-bridge-admin-bot/config.py` уже хранит этот id.

## 2. VK-сообщество (для постинга в чат) и VK ID (для логина)

### Постинг
1. Группа VK → Управление → Работа с API → Ключ доступа → создать с правами `messages` + `manage`. Скопировать → `VK_GROUP_TOKEN`.
2. Добавить сообщество как админа в офицерский VK-чат (Беседа → Настройки → Администраторы).
3. `peer_id` офицерского чата: `2000000000 + chat_id`. Положить в `VK_OFFICER_PEER_ID` (можно и просто `chat_id` — обработается).

### VK ID OAuth (для входа на сайт)
1. [vk.com/apps?act=manage](https://vk.com/apps?act=manage) → создать **Standalone-приложение**.
2. Authorized redirect URI → URL твоего фронта (например `https://buzzword001.github.io/clan-officers-panel/login.html`).
3. Скопировать `App ID` и `Защищённый ключ` (Secure key) → `VK_APP_ID` и `VK_APP_SECRET`.
4. Положить `VK_APP_ID` ещё и в `frontend/config.js` (нужен на клиенте).

## 3. Заполнить .env

```bash
cd backend
cp .env.example .env
# отредактировать .env, заполнить токены
```

## 4. Установить зависимости

```bash
pip install -r backend/requirements.txt
```

Selenium тянет Chromedriver автоматически. Сам Chrome должен быть установлен (у тебя есть).

## 5. Cloudflare Tunnel

```powershell
winget install Cloudflare.cloudflared
```

Запустить туннель:

```bash
start_tunnel.bat
```

В консоли появится строка вида `https://something-something.trycloudflare.com` — это твой публичный URL бэкенда. Скопируй и:

1. Вставь в `frontend/config.js` как `API_URL`.
2. Вставь в `backend/.env` как `PUBLIC_URL` (для логов и audit).

Этот URL у quick-tunnel **меняется при каждом перезапуске**. Если нужен постоянный — настроить именованный туннель с поддоменом (см. doc Cloudflare).

## 6. Запустить бэкенд

```bash
# Тихий запуск (без консоли, как остальные боты)
wscript backend/start_bot.vbs

# Или с консолью для отладки
backend/start_bot.bat
```

Проверка: `curl http://127.0.0.1:8765/health` → `{"ok": true}`.

## 7. Деплой фронта на GitHub Pages

```bash
cd ..
# Создать private репо
gh repo create BuzzWord001/clan-officers-panel --private --source . --remote origin --push

# В настройках репо: Pages → Source: GitHub Actions
# или Branch: gh-pages /(root) после workflow ниже
```

Workflow для авто-деплоя `frontend/` в Pages — в `.github/workflows/pages.yml`.

## 8. Первый запуск

1. Открой `https://buzzword001.github.io/clan-officers-panel/` (или `login.html`)
2. Войди через TG или VK → попадёшь в реестр
3. Добавь первую запись → через 5 минут бот опубликует закреп в TG и VK офицерские чаты

## Структура

```
clan-officers-panel/
├── backend/                  Python: FastAPI, БД, OAuth, шедулер, боты
│   ├── app.py                FastAPI приложение
│   ├── launcher.py           Защищённый запуск (lock-файл)
│   ├── config.py             .env → settings
│   ├── db.py                 SQLite (acceptances + audit + render_state)
│   ├── schemas.py            Pydantic
│   ├── whitelist.py          Список офицеров (читает clan-bridge-admin-bot JSON)
│   ├── session.py            HTTP-only cookies подписанные
│   ├── auth_tg.py            Telegram Login Widget verify
│   ├── auth_vk.py            VK ID OAuth code → token
│   ├── api_auth.py           /auth/*
│   ├── api_acceptances.py    /acceptances CRUD
│   ├── api_audit.py          /audit
│   ├── renderer.py           HTML → PNG через headless Chrome
│   ├── bot_tg.py             Telegram постинг и закреп
│   ├── bot_vk.py             VK постинг и закреп
│   ├── publisher.py          Оркестратор: render → tg → vk
│   ├── scheduler.py          APScheduler 5-мин дебаунс
│   ├── start_bot.vbs         Тихий запуск
│   └── start_bot.bat         Запуск с консолью
├── frontend/                 Статика для GitHub Pages
│   ├── index.html            Реестр + форма
│   ├── login.html            Вход (TG Login Widget + VK ID)
│   ├── audit.html            История изменений
│   ├── styles.css            Matrix-тема
│   ├── config.js             API_URL, TG_LOGIN_BOT, VK_APP_ID
│   ├── js/matrix.js          Падающий зелёный дождь
│   ├── js/api.js             fetch обёртка
│   ├── js/app.js             Главная страница
│   ├── js/login.js           Логин
│   ├── js/audit.js           История
│   └── assets/logo.png       Логотип
├── render/                   Шаблон и ассеты для PNG-рендера
│   ├── template.html
│   ├── assets/logo.png
│   └── output/manifest.png   (генерится)
├── data/                     SQLite БД (не в git)
└── start_tunnel.bat          Cloudflare Tunnel
```
