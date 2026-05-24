# Автозапуск после перезагрузки ПК

Сейчас и backend, и Cloudflare-tunnel запускаются вручную. После reboot ПК они НЕ стартуют сами — сайт окажется недоступен.

Решение — положить ярлык на `tools/start_all.vbs` в папку автозагрузки Windows.

## Один раз настроить (3 минуты)

1. Win+R → `shell:startup` → Enter (откроется папка автозагрузки текущего пользователя)
2. Перетащить туда ярлык на файл:
   ```
   C:\Users\BuzzWord\clan-officers-panel\tools\start_all.vbs
   ```
   (правая кнопка → «Создать ярлык», переместить ярлык в открытую папку)

С этого момента при каждом логине Windows автоматически:
- стартует backend (с while-loop на exit-code 42 для restore)
- стартует cloudflared
- `sync_tunnel.py` ловит новый URL туннеля
- если URL поменялся — переписывает `frontend/config.js`, делает коммит и push в GitHub
- GitHub Pages подтягивает обновлённый конфиг через ~30 секунд

Сайт `https://buzzword001.github.io/clan-officers-panel/` работает после reboot уже через минуту.

## Проверить что работает

После reboot:
- В диспетчере задач должны быть процессы `python.exe` и `cloudflared.exe`
- `curl http://127.0.0.1:8765/health` → `{"ok":true}`
- Открыть сайт — логин должен пройти

## Логи

- backend пишет в stdout (не в файл — если нужно, можно перенаправить в `backend/bot.log`)
- sync_tunnel.py печатает в stdout: «tunnel URL: …», «pushed: …»

## Что если сломается

- Backend не стартует → проверить `backend/.bot.lock` и `.bot_pid` (если процесс убит грязно, может остаться); удалить вручную
- Tunnel не пробрасывается → запустить `bin\cloudflared.exe tunnel --url http://127.0.0.1:8765` вручную
- Авто-push не работает → проверить `gh auth status` (нужен токен с `workflow` scope, как делалось раньше)
