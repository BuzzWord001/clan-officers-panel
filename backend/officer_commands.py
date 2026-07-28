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
_HISTORY = {"история", "досье", "history", "dossier"}
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
    if existing:   # уже в списке → дополняем/обновляем титул, БЕЗ дублей и без стирания
        old_title = (existing.get("title") or "").strip()
        if title:
            # титул указан → дополняем запись (или меняем прежний). Ник и дату не трогаем.
            db.update_acceptance(existing["id"], game_nick=None, title=title,
                                 accepted_date=None, note=None, actor=actor)
            head = "✏ Дополнил запись титулом:" if not old_title else "✏ Обновил титул:"
            shown = title
        else:
            # повторный /принять без титула — существующий титул НЕ стираем, ничего не меняем
            head = "✔ Этот ник уже в списке принятых:"
            shown = old_title
        return (head + "\n"
                "• Ник: " + existing["game_nick"] + "\n"
                "• Титул: " + (shown or "не указан"))
    db.create_acceptance(game_nick=nick, title=title,
                         accepted_date=date.today().isoformat(),
                         note="", role_pending=True, by_officer=True, actor=actor)
    warn = _prev_clan_warning(nick)
    return ("✅ Готово! Внёс в список принятых в клан:\n"
            "• Ник: " + nick + "\n"
            "• Титул: " + (title or "не указан") + "\n" + warn + "\n"
            "Ошиблись при вводе? Напишите /отмена — запись удалится.\n"
            "/список — кто принят в клан за эту неделю.")


def _prev_clan_warning(nick: str) -> str:
    """Если человек уже был в клане (архив/кик) — строка-предупреждение с причиной."""
    try:
        info = db.prev_clan_info(nick)
    except Exception:
        info = None
    if not info:
        return ""
    reason = (info.get("reason") or "").strip()
    by = (info.get("by") or "").strip()
    tail = (" Причина: " + reason) if reason else " Причина не указана."
    tail += (" (кикнул: " + by + ")") if by else ""
    return "\n⚠️ ВНИМАНИЕ: этот человек УЖЕ был в клане." + tail + "\n"


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
    # У /удалить титула нет — ВЕСЬ текст это ник (иначе многословный ник обрезался бы до
    # первого слова). Пайп поддерживаем на случай, если писали как в /принять.
    nick = (rest or "").strip()
    if "|" in nick:
        nick = nick.split("|", 1)[0].strip()
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


def _history(rest: str, actor: dict) -> str:
    """/история Ник — полное досье игрока (компактно). Ник = весь текст (может быть с пробелом)."""
    nick = (rest or "").strip()
    if "|" in nick:
        nick = nick.split("|", 1)[0].strip()
    if not nick:
        return ("Укажи кого искать: /досье Ник\n"
                "Можно по чему угодно: ник, имя-фамилия, VK-домен, @tg, id.")
    try:
        d = db.member_dossier(nick)
    except Exception:
        log.exception("dossier failed")
        return "⚠ Не удалось собрать досье. Попробуй ещё раз или посмотри на сайте."
    if not d or not d.get("found"):
        return ("Не нашёл никого по запросу «" + nick + "».\n"
                "Пробуй: игровой ник, имя-фамилию из VK, VK-домен (akiro_okumuro),\n"
                "@tg-логин или числовой id.")
    return _fmt_dossier(d)


def _fmt_dossier(d: dict) -> str:
    L = ["📜 ДОСЬЕ · " + (d.get("nick") or "?")]
    mb = d.get("matched_by")
    if mb and mb not in ("игровой ник", "clan_members"):
        L.append("   🔎 найден по: " + mb)
    L.append(_HR)
    L.append("🎮 ИГРА · ДОБЛЕСТЬ")
    if d.get("true_name"):
        L.append("👤 Имя: " + d["true_name"])
    L.append("🎖 " + (d.get("rank") or "Рядовой") + " · титул: " + (d.get("title") or "—"))
    line = "⚔ " + (d.get("class") or "—")
    if d.get("level"):
        line += " · ур." + str(d["level"])
    if d.get("valor") is not None:
        line += " · доблесть " + str(d["valor"])
    if d.get("last_week"):
        line += " (" + d["last_week"] + ")"
    L.append(line)
    if not d.get("in_clan"):
        L.append("🚪 СЕЙЧАС НЕ В КЛАНЕ (нет в последнем сборе доблести)")
    acc = d.get("acceptance")
    if d.get("first_join"):
        L.append("📅 Впервые в клане: " + d["first_join"]
                 + (" · принял: " + acc["created_by_name"] if (acc and acc.get("created_by_name")) else ""))
    if acc:
        tags = [t for t, k in (("Ветеран", "veteran"), ("Элита", "elite")) if acc.get(k)]
        if tags:
            L.append("🏅 " + ", ".join(tags))
    if len(d.get("classes", [])) > 1:
        L.append("↻ Классы: " + ", ".join(d["classes"]))
    if len(d.get("ranks", [])) > 1:
        L.append("↻ Звания: " + " → ".join(d["ranks"]))
    if len(d.get("titles", [])) > 1:
        L.append("↻ Титулы: " + ", ".join(d["titles"][:6]))
    notes = d.get("notes") or []
    if notes:
        L.append("📝 Свиток (" + str(len(notes)) + "):")
        for n in notes[-6:]:
            who = (" — " + n["author"]) if n.get("author") else ""
            dt = (", " + n["date"]) if n.get("date") else ""
            L.append("  • " + str(n.get("text") or "")[:90] + who + dt)
    imm = d.get("immunities") or []
    if imm:
        L.append("🛡 Иммунитеты (" + str(len(imm)) + "):")
        for m in imm[:5]:
            L.append("  • " + (m.get("week") or "") + ": " + str(m.get("reason") or "")[:70])
    afkn = d.get("afk_notes") or []
    for a in afkn[:3]:
        until = (" до " + a["until"]) if a.get("until") else ""
        L.append("💤 АФК" + until + ": " + str(a.get("note") or "")[:80])
    tw = d.get("twins") or []
    if tw:
        L.append(_HR)
        L.append("👥 Твины (" + str(len(tw)) + "):")
        for t in tw:
            extra = []
            if t.get("class"):
                extra.append(t["class"])
            if t.get("level"):
                extra.append("ур." + str(t["level"]))
            if t.get("valor") is not None:
                extra.append("добл." + str(t["valor"]))
            status = "✅ в клане" if t.get("in_clan") else "🚪 не в клане"
            L.append("  • " + t["nick"] + (" — " + ", ".join(extra) if extra else "") + " · " + status)
    soc = d.get("socials")
    if soc:
        sp = []
        vk = (soc.get("vk_display") or "")
        if soc.get("vk_screen_name"):
            vk = (vk + " (@" + soc["vk_screen_name"] + ")").strip()
        elif soc.get("vk_id"):
            vk = (vk + " (id" + str(soc["vk_id"]) + ")").strip()
        if vk.strip():
            sp.append("VK: " + vk)
        tgs = (soc.get("tg_display") or "")
        if soc.get("tg_username"):
            tgs = (tgs + " (@" + soc["tg_username"] + ")").strip()
        if tgs.strip():
            sp.append("TG: " + tgs)
        av = []
        if soc.get("vk_avatar"): av.append("VK-фото")
        if soc.get("tg_avatar"): av.append("TG-фото")
        L.append(_HR)
        L.append("👤 ЛИЧНОСТЬ · КОНТАКТЫ")
        if sp:
            L.append("🔗 " + " · ".join(sp))
        if av:
            L.append("🖼 Аватар: " + ", ".join(av))
        if soc.get("last_seen_at") or soc.get("last_active_day"):
            L.append("🕒 Последняя активность: "
                     + (soc.get("last_active_day") or (soc.get("last_seen_at") or "")[:10]))
    spouses = d.get("spouses") or []
    if spouses:
        if not soc:
            L.append(_HR)
            L.append("👤 ЛИЧНОСТЬ · КОНТАКТЫ")
        for s in spouses:
            role = s.get("role") or ""
            tag = (" (" + role + ")") if role in ("муж", "жена") else ""
            L.append("💍 Супруг(а): " + s["nick"] + tag)
    ca = d.get("chat_activity") or []
    if ca:
        for c in ca:
            plat = "VK" if c["platform"] == "vk" else "TG"
            L.append("💬 Чат " + plat + ": сообщений " + str(c.get("msgs") or 0)
                     + " · последнее " + (c.get("last") or "")[:10]
                     + " · с " + (c.get("first") or "")[:10])
    hist = d.get("history") or []
    if hist:
        L.append(_HR)
        L.append("📈 Доблесть по неделям:")
        for h in hist:
            dt = h.get("dates") or (h.get("week") or "")
            met = h.get("met")
            mark = "✅" if met else ("❌" if met is not None else "•")
            afk = " 💤АФК" if h.get("afk") else ""
            v = h.get("valor")
            L.append("  " + dt + ": " + (str(v) if v is not None else "?")
                     + "/" + str(h.get("norm") or "?") + " " + mark + afk)
    aw = d.get("active_warnings") or []
    mw = d.get("manual_warnings") or []
    wc = d.get("warning_count") or 0
    if aw or mw or wc:
        L.append(_HR)
        L.append("⚠ Предупреждения: серия подряд " + str(wc)
                 + " · невыполнено нормы " + str(len(aw)) + " нед."
                 + (" · ручных " + str(len(mw)) if mw else ""))
        if aw:
            L.append("  недели без нормы: "
                     + "; ".join((w.get("dates") or w.get("week") or "") for w in aw[:12]))
        for w in mw[:5]:
            txt = w.get("text") or w.get("reason") or w.get("kind") or "предупреждение"
            L.append("  ручное: " + str(txt)[:70])
    dep = d.get("departed")
    if dep:
        L.append(_HR)
        verb = "🚪 Кикали из клана" if dep.get("kicked") else "🚪 Уходил сам"
        by = dep.get("by") or ""
        when = (dep.get("when") or "")[:10]
        L.append(verb + ": " + (dep.get("reason") or "причина не указана")
                 + (" (" + by + ")" if by else "") + (" · " + when if when else ""))

    # ── ОЧЕРЕДЬ ЗА РЕСУРСАМИ ──
    q = d.get("queue") or []
    jet = d.get("jetons") or 0
    if q or jet:
        L.append(_HR)
        L.append("📦 ОЧЕРЕДЬ ЗА РЕСУРСАМИ")
        for e in q[:8]:
            pos = e.get("pos")
            posn = ("#" + str(int(pos)) if isinstance(pos, (int, float)) else "")
            L.append("  • " + (e.get("queue") or "") + ": " + str(e.get("resource") or "")
                     + (" · место " + posn if posn else ""))
        if jet:
            L.append("  🎟 Жетон ТОП-3: " + str(jet))

    # ── ТЕХНИЧЕСКОЕ: IP / устройства / входы — визуально ОТДЕЛЬНО от игры ──
    site = d.get("site")
    clicks = d.get("link_clicks") or []
    L.append("")
    L.append("═════════ 🌐 IP · УСТРОЙСТВА ═════════")
    if clicks:
        L.append("🔗 Брал ссылку на чат с сайта (" + str(len(clicks)) + "):")
        for c in clicks[:5]:
            m = (" → вступил: " + c["match_name"]) if c.get("matched") and c.get("match_name") else ""
            L.append("  • " + (c.get("at") or "")[:16] + " " + (c.get("platform") or "")
                     + " " + (c.get("ip") or "") + m)
    if not site or not (site.get("ips") or site.get("logins")):
        if not clicks:
            L.append("нет данных: на сайт под этим ником не заходил")
        return "\n".join(L)
    ips = site.get("ips") or []
    if ips:
        L.append("🖥 IP (" + str(len(ips)) + " шт · визитов " + str(site.get("visits_total") or 0) + "):")
        for i in ips[:6]:
            loc = " · ".join(x for x in (i.get("country"), i.get("city"),
                                         (i.get("isp") or "")[:22]) if x)
            L.append("  • " + (i.get("ip") or "?") + (" — " + loc if loc else "")
                     + "  [×" + str(i.get("count") or 0)
                     + (", " + (i.get("last") or "")[:10] if i.get("last") else "") + "]")
    devs = site.get("devices") or []
    if devs:
        L.append("📱 Устройства / отпечатки (" + str(len(devs)) + "):")
        for dv in devs[:5]:
            head = " · ".join(x for x in (dv.get("platform"), dv.get("screen"),
                                          dv.get("utc"), dv.get("tz")) if x)
            L.append("  • " + (head or "?"))
            det = []
            if dv.get("lang"): det.append("язык " + dv["lang"])
            if dv.get("dev_mem"): det.append("память " + str(dv["dev_mem"]) + "ГБ")
            if dv.get("hw_cores"): det.append("ядер " + str(dv["hw_cores"]))
            det.append("сенсор ✅" if dv.get("touch") else "сенсор ✖")
            if det:
                L.append("     " + " · ".join(det))
            ua = (dv.get("ua") or "")
            if ua:
                L.append("     UA: " + ua[:80])
    aa = site.get("admin_attempts") or []
    if aa:
        L.append("🔐 Попытки АДМИН-входа: " + str(len(aa)))
        for a in aa[:3]:
            st = "✅" if a.get("ok") else ("❌ " + (a.get("reason") or ""))
            L.append("  • " + (a.get("ts") or "")[:16] + " " + st + " " + (a.get("ip") or ""))
    lg = site.get("logins") or []
    if lg:
        L.append("🔑 Входы на сайт:")
        for a in lg[:5]:
            st = "✅" if a.get("ok") else "❌"
            L.append("  • " + (a.get("ts") or "")[:16] + " " + (a.get("role") or "")
                     + " " + st + " " + (a.get("ip") or ""))
    return "\n".join(L)


def _help() -> str:
    return (
        "📋 ПРИЁМ НОВИЧКОВ В КЛАН\n" + _HR + "\n"
        "➕ /принять Ник Титул\n"
        "     принять новичка в список\n"
        "     напр: /принять DarkLord ~Vasya~\n\n"
        "↩ /отмена\n"
        "     отменить последний приём (если ошиблись)\n\n"
        "📆 /список\n"
        "     кого приняли на этой неделе\n\n"
        "📜 /досье Ник   (или /история Ник — то же самое)\n"
        "     полное досье: игра+доблесть, твины, соцсети,\n"
        "     и отдельно IP/устройства/входы на сайт\n"
        "     ищет по ЛЮБЫМ данным: ник, имя-фамилия,\n"
        "     VK-домен, @tg, id — напр. /досье Артём Лапин\n" + _HR + "\n"
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
    known = (cmd in _ACCEPT or cmd in _CANCEL or cmd in _REMOVE or cmd in _LIST
             or cmd in _HELP or cmd in _HISTORY)
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
        elif cmd in _HISTORY:
            reply = _history(rest, actor)
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
