"""Команды офицеров в чатах TG/VK — приём новичков в клан прямо из чата.

Формат (максимально коротко и понятно):
  /принять Ник Титул   — принять новичка. Ник — ПЕРВОЕ слово, всё после — титул
                         (имя игрока или ~мэйн~ для твина). Пример: /принять DarkLord ~Vasya~
  /удалить Ник         — убрать ошибочную запись
  /список              — последние принятые
  /помощь              — показать формат

Особенности:
- Ники в PW односложные → разделитель не нужен, пишем просто через пробел.
  Для редкого ника с пробелом можно явно: /принять Ник с пробелом | Титул
- Дата приёма ставится сама (сегодня).
- role_pending=True → человек попадает в админский список «кому выдать титулы в игре».
- Повторный /принять с тем же ником ОБНОВЛЯЕТ титул (не плодит дубли) — так же правится опечатка.
"""

import logging
from datetime import date

import db

log = logging.getLogger("officers.commands")

_ACCEPT = {"принять", "прием", "приём", "accept", "add"}
_CANCEL = {"отмена", "отменить", "отмени", "cancel", "undo"}
_REMOVE = {"удалить", "убрать", "delete", "del", "remove"}
_LIST = {"список", "list", "кто"}
# Только /help — чтобы не пересекаться с /помощь другого бота в этом чате.
_HELP = {"help"}


def _canon(s: str) -> str:
    return db._valor_canon(s or "")


def _split_nick_title(rest: str):
    """Ник + титул. Явный разделитель '|' (для ников с пробелом), иначе первое слово = ник."""
    rest = (rest or "").strip()
    if "|" in rest:
        a, b = rest.split("|", 1)
        return a.strip(), b.strip()
    parts = rest.split(None, 1)
    nick = parts[0].strip() if parts else ""
    title = parts[1].strip() if len(parts) > 1 else ""
    return nick, title


def _find_active(nick: str):
    """Самая свежая НЕ архивная запись реестра с этим ником (по canon), или None."""
    canon = _canon(nick)
    if not canon:
        return None
    rows = [r for r in db.list_acceptances()
            if not r.get("archived")
            and (r.get("nick_canon") or _canon(r.get("game_nick"))) == canon]
    rows.sort(key=lambda r: r.get("id", 0), reverse=True)
    return rows[0] if rows else None


def _actor_for_create(actor: dict) -> dict:
    """Подставить игровой ник офицера (из clan_members по TG/VK id) в подпись «Добавил»,
    чтобы админ видел КТО именно принял. Если ника нет — остаётся имя из чата."""
    a = dict(actor)
    gn = db.member_nick_by_platform_id(a.get("platform", ""), a.get("id", ""))
    base = (a.get("name") or "").strip()
    if gn:
        a["name"] = gn + (" (" + base + ")" if base and gn.lower() != base.lower() else "")
    return a


def _accept(rest: str, actor: dict) -> str:
    nick, title = _split_nick_title(rest)
    if not nick:
        return _help()
    actor = _actor_for_create(actor)
    existing = _find_active(nick)
    if existing:   # уже в списке → обновляем титул (правка опечатки, без дублей)
        db.update_acceptance(existing["id"], game_nick=None, title=title,
                             accepted_date=None, note=None, actor=actor)
        return ("✏ Обновил запись в списке принятых:\n"
                "• Ник: " + existing["game_nick"] + "\n"
                "• Титул: " + (title or "не указан"))
    db.create_acceptance(game_nick=nick, title=title,
                         accepted_date=date.today().isoformat(),
                         note="", role_pending=True, by_officer=True, actor=actor)
    return ("✅ Готово! Внёс в список принятых в клан:\n"
            "• Ник: " + nick + "\n"
            "• Титул: " + (title or "не указан") + "\n\n"
            "Ошиблись при вводе? Напишите /отмена — запись удалится.\n"
            "/список — кто принят в клан за эту неделю.")


def _cancel(actor: dict) -> str:
    """Отменить ПОСЛЕДНИЙ приём, который добавил именно этот офицер (по автору).
    Так /отмена от разных офицеров (TG/VK) не мешают друг другу."""
    plat = actor.get("platform") or ""
    pid = str(actor.get("id") or "")
    mine = [r for r in db.list_acceptances()
            if not r.get("archived")
            and r.get("created_by_platform") == plat
            and str(r.get("created_by_id")) == pid]
    if not mine:
        return "Нечего отменять — вы ещё никого не принимали."
    mine.sort(key=lambda r: r.get("id", 0), reverse=True)
    row = mine[0]
    db.delete_acceptance(row["id"], actor=actor)
    t = (row.get("title") or "").strip()
    return "↩ Отменён приём: " + row["game_nick"] + (" — " + t if t else "")


def _remove(rest: str, actor: dict) -> str:
    nick, _ = _split_nick_title(rest)
    if not nick:
        return "Укажи ник: /удалить Ник"
    row = _find_active(nick)
    if not row:
        return "Не нашёл в списке: " + nick
    db.delete_acceptance(row["id"], actor=actor)
    return "🗑 Убран из списка: " + row["game_nick"]


def _list() -> str:
    """Принятые за ТЕКУЩУЮ ISO-неделю (пн–вс, как недельный сброс доблести)."""
    cur_week = db._iso_week_of(date.today().isoformat())
    rows = [r for r in db.list_acceptances()
            if not r.get("archived")
            and db._iso_week_of(r.get("accepted_date", "")) == cur_week]
    rows.sort(key=lambda r: (r.get("accepted_date", ""), r.get("id", 0)), reverse=True)
    if not rows:
        return "📆 За эту неделю пока никого не приняли."
    lines = []
    for r in rows:
        t = (r.get("title") or "").strip()
        lines.append("• " + r["game_nick"] + (" — " + t if t else ""))
    return "📆 Приняты на этой неделе (" + str(len(rows)) + "):\n" + "\n".join(lines)


_HR = "━━━━━━━━━━━━━━━━━━"


def _help() -> str:
    return (
        "📋 ПРИЁМ НОВИЧКОВ В КЛАН\n" + _HR + "\n"
        "➕ /принять Ник Титул\n"
        "     принять новичка в список\n"
        "     напр: /принять DarkLord ~Vasya~\n\n"
        "↩ /отмена\n"
        "     отменить последний приём (если ошиблись)\n\n"
        "📆 /список\n"
        "     кого приняли на этой неделе\n" + _HR + "\n"
        "ℹ️ Ник — одно слово, дальше титул (имя или ~мэйн~).\n"
        "Дата ставится сама. Повторный /принять тем же ником — меняет титул.\n"
        "🌐 Всё видно на сайте: santdevil.com → «Приём в клан»"
    )


def handle(text: str, actor: dict) -> str | None:
    """Обработать одну команду из чата. actor={platform,id,name,ip,user_agent}.
    Возвращает текст ответа или None (это не наша команда — игнор, без спама)."""
    t = (text or "").strip()
    if not t.startswith("/"):
        return None
    head, _, rest = t.partition(" ")
    cmd = head[1:].split("@", 1)[0].lower()   # убрать ведущий / и суффикс @botname (в группах TG)
    rest = rest.strip()
    known = cmd in _ACCEPT or cmd in _CANCEL or cmd in _REMOVE or cmd in _LIST or cmd in _HELP
    reply = None
    try:
        if cmd in _ACCEPT:
            reply = _accept(rest, actor)
        elif cmd in _CANCEL:
            reply = _cancel(actor)
        elif cmd in _REMOVE:
            reply = _remove(rest, actor)
        elif cmd in _LIST:
            reply = _list()
        elif cmd in _HELP:
            reply = _help()
    except Exception:
        log.exception("officer command failed: %s", t)
        reply = "⚠ Не получилось выполнить. Попробуй ещё раз или сделай на сайте."
    # Подробный лог команды для админа (кто/что/когда/полный текст/ответ).
    if known:
        try:
            gn = db.member_nick_by_platform_id(actor.get("platform", ""), actor.get("id", ""))
            base = (actor.get("name") or "").strip()
            who = (gn + (" (" + base + ")" if base and gn.lower() != base.lower() else "")) if gn else base
            db.log_chat_command(
                platform=actor.get("platform", ""), user_id=actor.get("id", ""),
                user_name=who, command=cmd, text=t,
                ok=not str(reply or "").startswith("⚠"), reply=str(reply or ""))
        except Exception:
            log.exception("chat command log failed")
    return reply
