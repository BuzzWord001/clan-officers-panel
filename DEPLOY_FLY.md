# Деплой clan-officers-panel на Fly.io

После переезда сайт работает независимо от твоего ПК. Frontend остаётся
на GitHub Pages, backend живёт на Fly.io VM (always-on, free tier).

## Однократная установка

1. **flyctl уже стоит:** `C:\Users\BuzzWord\.fly\bin\flyctl.exe`
2. **PATH:** добавь в постоянный PATH или используй абсолютный путь в командах.
   Для git-bash: `export PATH="$HOME/.fly/bin:$PATH"`

## Шаг 1 — логин в Fly

```bash
flyctl auth login
```

Откроется браузер. Зарегистрируйся (если первый раз) или войди.
Привязки карты Fly **не требует** для free tier (Hobby plan).

## Шаг 2 — создать приложение

```bash
cd C:/Users/BuzzWord/clan-officers-panel
flyctl apps create clan-officers-panel
flyctl volumes create officers_data --region ams --size 3 --yes
```

Region `ams` (Amsterdam) — самый близкий к РФ из free regions.
Volume 3GB — на годы данных хватит.

## Шаг 3 — секреты

Возьми токены из `backend/.env` (он НЕ коммитится в git) и залей в Fly:

```bash
flyctl secrets set \
  TG_BOT_TOKEN="..." \
  TG_OFFICER_CHAT_ID="-1003999223250" \
  VK_GROUP_TOKEN="..." \
  VK_OFFICER_PEER_ID="2000000002" \
  SESSION_SECRET="$(python -c 'import secrets; print(secrets.token_hex(32))')" \
  DEFAULT_ADMIN_USERNAME="buzzword001" \
  DEFAULT_ADMIN_PASSWORD="..." \
  DEFAULT_OFFICER_PASSWORD="santdevil2026" \
  CAPTION_OFFICER_PASSWORD="santdevil2026"
```

`SESSION_SECRET` — обязательно новый (32 байта). Если оставить старый —
сессии офицеров с твоего локального ПК продолжат работать после переезда.

## Шаг 4 — деплой

```bash
flyctl deploy --no-cache
```

Сборка ~5 минут (Chromium большой). Logs:

```bash
flyctl logs
```

Здоровый старт:
```
[launcher] Lock acquired pid=1
DB initialised: /data/officers.db
Frontend: https://buzzword001.github.io
Scheduler started, debounce=5 min
INFO:     Uvicorn running on http://0.0.0.0:8765
```

Проверь:
```bash
curl https://clan-officers-panel.fly.dev/health
# {"ok":true}
```

## Шаг 5 — миграция БД с локального ПК

Только если у тебя на локальном бэкенде уже есть записи (acceptances, audit).
**Перед миграцией останови локальный backend** (иначе SQLite WAL может оказаться
рассогласованным):

```bash
# Останови local backend (закрой окно cmd с launcher.py или kill PID)
```

Затем залей файл:

```bash
cd C:/Users/BuzzWord/clan-officers-panel

# Удалить пустую БД, созданную на старте Fly
flyctl ssh console --command "rm -f /data/officers.db /data/officers.db-shm /data/officers.db-wal"

# Залить локальную БД на volume
flyctl ssh sftp shell <<EOF
put data/officers.db /data/officers.db
EOF

# Снапшоты (опционально)
flyctl ssh sftp shell <<EOF
put data/snapshots/officers_20260525.db /data/snapshots/officers_20260525.db
EOF

# Перезапуск, чтобы новый launcher открыл свежую БД
flyctl apps restart clan-officers-panel
```

Проверь что записи на месте:
```bash
curl https://clan-officers-panel.fly.dev/acceptances | head -c 500
```

## Шаг 6 — переключить frontend на Fly URL

Открой `frontend/config.js` и поменяй API_URL:

```js
window.OFFICERS_CONFIG = {
  API_URL: "https://clan-officers-panel.fly.dev",
};
```

Закоммитить и запушить — GitHub Pages подхватит за 30 сек:

```bash
git add frontend/config.js
git commit -m "switch API to Fly.io"
git push origin main
```

## Шаг 7 — выключить локальные процессы

Cloudflared и sync_tunnel.py больше не нужны:

1. Убрать ярлык из `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\`:
   `SanTDeviL Officer Panel.lnk` (просто удали файл).
2. Закрыть запущенные процессы (или просто перезагрузить ПК — больше не стартанут):
   ```bash
   # PowerShell
   Get-Process | ? { $_.Path -like '*clan-officers-panel*' -or $_.ProcessName -eq 'cloudflared' } | Stop-Process
   ```
3. Локальный backend можно держать выключенным; данные **отныне на Fly**.

## Будущие обновления

```bash
git push origin main           # фронт — GitHub Actions сам деплоит на Pages
flyctl deploy                  # бэкенд — пересобирает Docker и катит на Fly
flyctl logs                    # смотреть рантайм
flyctl ssh console             # SSH внутрь машины
```

## Диагностика

| Симптом | Команда |
|--------|---------|
| 502 на сайте | `flyctl logs` — смотреть запуск |
| Cookie не сохраняется | проверь что `frontend/config.js` указывает на `https://...` (не `http`), браузер требует HTTPS для SameSite=None |
| TG/VK закреп не обновляется | `flyctl ssh console --command "tail /data/logs/backend.log"` — если есть |
| БД пустая после рестарта | volume не примонтирован — `flyctl volumes list` |
| Rollback | `flyctl releases` → `flyctl releases rollback <id>` |

## Стоимость

Free tier Fly Hobby plan:
- 3 shared-cpu-1x машины с 256MB — мы используем одну 512MB (~$1.94/мес выше free)
- 3 GB persistent volume — у нас 3GB volume = в лимите
- 160 GB egress — нам нужно ~1-2 GB/мес

**Итог:** ~$2/мес, если делать 256MB вместо 512MB — **$0**, но Chromium может OOM.
512MB безопаснее. Можно урезать до 256MB, если рендер не используется
часто или после оптимизации Selenium на Playwright.
