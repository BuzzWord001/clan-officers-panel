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
import re
from datetime import date

import db

log = logging.getLogger("officers.commands")

# Последнее ИЗМЕНЯЮЩЕЕ действие каждого офицера (для универсальной /отмена).
# Ключ = 'platform:id'. In-memory (живёт, пока работает сервер) — «отмени последнюю».
_LAST_ACTION: dict = {}


def _akey(actor: dict) -> str:
    return (actor.get("platform") or "") + ":" + str(actor.get("id") or "")


def _remember(actor: dict, kind: str, data: dict) -> None:
    _LAST_ACTION[_akey(actor)] = {"kind": kind, "data": data}

_ACCEPT = {"принять", "прием", "приём", "accept", "add"}
_CANCEL = {"отмена", "отменить", "отмени", "cancel", "undo"}
_REMOVE = {"удалить", "убрать", "delete", "del", "remove"}
_LIST = {"список", "list", "кто"}
_HISTORY = {"история", "досье", "history", "dossier"}
_SETPW = {"пароль", "password", "парольклана", "парользх", "парольсайта"}
# Только /help — чтобы не пересекаться с /помощь другого бота в этом чате.
_HELP = {"help"}
_BLACKLIST = {"чс", "cs", "blacklist", "бан", "ban", "чёрныйсписок", "черныйсписок"}
_AFK = {"афк", "afk", "неактив"}


def _setpw(rest: str, actor: dict) -> str:
    """/пароль <новый> — сменить ОБЩИЙ пароль клана (для входа игроков на сайт).
    Он же публикуется в списке гильдии (кнопка G, строка «Пароль:»)."""
    pw = (rest or "").strip()
    if not pw:
        return ("Укажи новый общий пароль клана: /пароль 5623\n"
                "Это пароль из списка гильдии (кнопка G) — игроки входят им на сайт.")
    if len(pw) > 64:
        return "Слишком длинный пароль (макс 64 символа)."
    try:
        db.queue_set_shared_password(pw)
    except Exception:
        log.exception("set shared pw failed")
        return "⚠ Не удалось сменить пароль. Попробуй ещё раз."
    return ("✅ Общий пароль клана изменён на: " + pw + "\n"
            "Обнови его в списке гильдии (кнопка G, строка «Пароль:»). Игроки входят на "
            "santdevil.com своим ником + этим паролём.")


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


def _blacklist_warning(nick: str) -> str:
    """Если ник в ЧС — строка-предупреждение с причиной, кем и когда внесён (для /принять)."""
    try:
        bl = db.blacklist_has(nick)
    except Exception:
        bl = None
    if not bl:
        return ""
    parts = ["⚠️ ВНИМАНИЕ: «" + (bl.get("nick") or nick) + "» в ЧЁРНОМ СПИСКЕ клана!"]
    reason = (bl.get("reason") or "").strip()
    parts.append("• Причина: " + (reason if reason else "не указана"))
    meta = []
    if (bl.get("added_by") or "").strip():
        meta.append("внёс: " + bl["added_by"].strip())
    if (bl.get("added_at") or "").strip():
        meta.append(_ru_date((bl["added_at"] or "")[:10]))
    if meta:
        parts.append("• " + " · ".join(meta))
    parts.append("Проверь, точно ли принимаем. Убрать из ЧС: /чс -" + (bl.get("nick") or nick))
    return "\n".join(parts) + "\n" + _HR + "\n"


def _accept(rest: str, actor: dict) -> str:
    nick, title = _split_nick_title(rest)
    if not nick:
        return _help()
    actor = _actor_for_create(actor)
    bl_warn = _blacklist_warning(nick)         # предупреждение, если человек в ЧС
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
        return (bl_warn + head + "\n"
                "• Ник: " + existing["game_nick"] + "\n"
                "• Титул: " + (shown or "не указан"))
    res = db.create_acceptance(game_nick=nick, title=title,
                               accepted_date=date.today().isoformat(),
                               note="", role_pending=True, by_officer=True, actor=actor)
    _remember(actor, "accept", {"acc_id": (res or {}).get("id"), "nick": nick, "title": title})
    try:                                              # принятый — сразу в ростер клана (вход открыт)
        import api_queue
        api_queue.rebuild_clan_roster()
    except Exception:
        pass
    warn = _prev_clan_warning(nick)
    return (bl_warn + "✅ Готово! Внёс в список принятых в клан:\n"
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
    """УНИВЕРСАЛЬНАЯ отмена: откатывает ПОСЛЕДНЮЮ изменяющую команду этого офицера
    (/принять, /чс, /афк). Ключ по автору — /отмена разных офицеров не мешают друг другу.
    Если последнего действия в памяти нет (напр. после рестарта) — фолбэк на отмену
    последнего приёма из реестра."""
    la = _LAST_ACTION.get(_akey(actor))
    if la:
        kind, d = la["kind"], la["data"]
        try:
            if kind == "accept":
                if d.get("acc_id"):
                    db.delete_acceptance(d["acc_id"], actor=actor)
                _LAST_ACTION.pop(_akey(actor), None)
                return "↩ Отменён приём: " + d.get("nick", "") + (
                    " — " + d["title"] if d.get("title") else "")
            if kind == "blacklist_add":
                db.blacklist_remove(d["nick"])
                _LAST_ACTION.pop(_akey(actor), None)
                return "↩ Отменено: «" + d["nick"] + "» убран из чёрного списка."
            if kind == "blacklist_remove":
                db.blacklist_add(d["nick"], d.get("reason", ""), actor)
                _LAST_ACTION.pop(_akey(actor), None)
                return "↩ Отменено: «" + d["nick"] + "» возвращён в чёрный список."
            if kind == "afk_set":
                _restore_afk(d["canon"], d.get("prev"), actor)
                _LAST_ACTION.pop(_akey(actor), None)
                return "↩ Отменён АФК: " + d.get("nick", "") + _afk_prev_hint(d.get("prev"))
            if kind == "afk_clear":
                _restore_afk(d["canon"], d.get("prev"), actor)
                _LAST_ACTION.pop(_akey(actor), None)
                return "↩ Отменено снятие АФК: " + d.get("nick", "") + " — статус возвращён."
        except Exception:
            log.exception("undo failed: %s", kind)
            return "⚠ Не получилось отменить. Сделай вручную на сайте."
    # фолбэк — последний приём (как раньше)
    plat = actor.get("platform") or ""
    pid = str(actor.get("id") or "")
    mine = [r for r in db.list_acceptances()
            if not r.get("archived")
            and r.get("created_by_platform") == plat
            and str(r.get("created_by_id")) == pid]
    if not mine:
        return "Нечего отменять."
    mine.sort(key=lambda r: r.get("id", 0), reverse=True)
    row = mine[0]
    db.delete_acceptance(row["id"], actor=actor)
    t = (row.get("title") or "").strip()
    return "↩ Отменён приём: " + row["game_nick"] + (" — " + t if t else "")


def _restore_afk(canon: str, prev: dict | None, actor: dict) -> None:
    """Вернуть АФК-состояние канона к prev (или снять, если prev пуст)."""
    if prev:
        db.valor_set_afk_by_canon(
            canon, afk_until=prev.get("afk_until", ""), afk_since=prev.get("afk_since", ""),
            note=prev.get("note", ""), actor=_actor_for_create(actor), extend=False)
    else:
        db.valor_clear_afk_by_canon(canon, _actor_for_create(actor))


def _afk_prev_hint(prev: dict | None) -> str:
    if not prev:
        return " — АФК снят."
    u = prev.get("afk_until", "")
    return " — возвращён прежний АФК" + (" (до " + _ru_date(u) + ")" if u else "") + "."


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


# ──────────────────────────── /чс — чёрный список ────────────────────────────
def _blacklist(rest: str, actor: dict) -> str:
    """/чс Ник Причина — внести в чёрный список клана (виден офицерам/админу на сайте).
    /чс -Ник — убрать из ЧС. /чс — показать текущий список."""
    rest = (rest or "").strip()
    if not rest:
        rows = db.blacklist_list()
        if not rows:
            return ("🚫 ЧЁРНЫЙ СПИСОК КЛАНА\n" + _HR +
                    "\nСписок пуст — никто не внесён.\n\n"
                    "Добавить: /чс Ник причина")
        lines = ["🚫 ЧЁРНЫЙ СПИСОК КЛАНА · " + str(len(rows)) + " чел.", _HR]
        for i, r in enumerate(rows[:50], 1):
            lines.append("")
            lines.append(str(i) + ". ⛔ " + (r["nick"] or r["canon"]))
            lines.append("   📝 " + (r["reason"].strip() if (r.get("reason") or "").strip()
                                      else "причина не указана"))
            meta = []
            if (r.get("added_by") or "").strip():
                meta.append("внёс: " + r["added_by"].strip())
            if (r.get("added_at") or "").strip():
                meta.append(_ru_date((r["added_at"] or "")[:10]))
            if meta:
                lines.append("   👤 " + " · 📅 ".join(meta) if len(meta) == 2
                             else "   👤 " + meta[0])
        if len(rows) > 50:
            lines.append("\n…и ещё " + str(len(rows) - 50) + ". Полный список — на сайте.")
        lines.append("\n" + _HR)
        lines.append("Добавить: /чс Ник причина")
        lines.append("Убрать:  /чс -Ник")
        return "\n".join(lines)
    nick, title = _split_nick_title(rest)
    if nick.startswith("-"):                       # /чс -Ник — убрать
        target = nick[1:].strip() or title.strip()
        prev = db.blacklist_has(target)            # запомнить для отмены
        n = db.blacklist_remove(target)
        if n and prev:
            _remember(actor, "blacklist_remove",
                      {"nick": prev.get("nick") or target, "reason": prev.get("reason", "")})
        return ("✅ Убран из ЧС: " + target) if n else ("Не найден в ЧС: " + target)
    reason = title.strip()
    res = db.blacklist_add(nick, reason, _actor_for_create(actor))
    if res.get("ok") and not res.get("updated"):
        _remember(actor, "blacklist_add", {"nick": res.get("nick") or nick})
    if not res.get("ok"):
        return "⚠ Не понял ник. Формат: /чс Ник причина"
    verb = "Обновлён в ЧС" if res.get("updated") else "Внесён в ЧС"
    out = "🚫 " + verb + ": " + (res.get("nick") or nick)
    if reason:
        out += "\n• Причина: " + reason
    out += "\nВиден офицерам и админу на сайте santdevil.com. Убрать: /чс -" + (res.get("nick") or nick)
    return out


# ─────────────────────────────── /афк ────────────────────────────────
_MONTHS = {
    "январ": 1, "феврал": 2, "март": 3, "апрел": 4, "ма": 5, "май": 5, "мая": 5,
    "июн": 6, "июл": 7, "август": 8, "авгус": 8, "сентябр": 9, "октябр": 10,
    "ноябр": 11, "декабр": 12,
}


def _month_num(word: str):
    w = (word or "").lower().strip(".,")
    if w in ("мая", "май", "мае"):
        return 5
    for stem, num in _MONTHS.items():
        if w.startswith(stem):
            return num
    return None


def _mk_date(d: int, m: int, y: int | None):
    """Собрать дату; если год не задан — текущий, а если получилась в прошлом → +1 год
    (напр. «до 25.06», когда июнь уже прошёл → следующий год)."""
    today = date.today()
    if y is None:
        y = today.year
        try:
            cand = date(y, m, d)
        except ValueError:
            return None
        if cand < today:
            y += 1
    if y < 100:                                    # двузначный год 26 → 2026
        y += 2000
    try:
        return date(y, m, d)
    except ValueError:
        return None


def _try_date_at(toks: list, i: int):
    """Пытается прочитать дату начиная с toks[i]. Возвращает (date, consumed_tokens) или (None,0).
    Форматы: ДД.ММ.ГГГГ, ДД.ММ.ГГ, ДД.ММ, ДД <месяц-словом> [ГГГГ]."""
    tok = toks[i].strip(".,")
    # ДД.ММ.ГГГГ / ДД.ММ.ГГ / ДД.ММ
    m = re.match(r"^(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?$", tok)
    if m:
        d, mo = int(m.group(1)), int(m.group(2))
        y = int(m.group(3)) if m.group(3) else None
        dt = _mk_date(d, mo, y)
        if dt:
            return dt, 1
    # ДД <месяц словом> [ГГГГ]
    m2 = re.match(r"^(\d{1,2})$", tok)
    if m2 and i + 1 < len(toks):
        mo = _month_num(toks[i + 1])
        if mo:
            d = int(m2.group(1))
            y = None
            consumed = 2
            if i + 2 < len(toks) and re.match(r"^\d{2,4}$", toks[i + 2].strip(".,")):
                y = int(toks[i + 2].strip(".,"))
                consumed = 3
            dt = _mk_date(d, mo, y)
            if dt:
                return dt, consumed
    return None, 0


def _parse_afk_dates(tail: str):
    """Разобрать хвост '/афк' → (since, until, reason). Формы: '25.06.2026', 'до 25.06.2026',
    '25.06', 'до 25 января', 'с 25.05.2026 по 27.05.2026', '25.05.2026-27.05.2026'.
    since/until — 'YYYY-MM-DD' или '' (until пусто = бессрочно). reason — текст после дат."""
    tail = (tail or "").strip()
    # дефис/тире между двумя датами → отдельный токен-маркер диапазона: 25.05.2026-27.05.2026
    tail = re.sub(r"(\d)\s*[-–—]\s*(\d)", r"\1 — \2", tail)
    toks = tail.split()
    dates = []                                      # [(hint, iso)]: hint 'since'|'until'|None
    pending = None
    i = 0
    while i < len(toks):
        low = toks[i].lower().strip(".,")
        if low in ("до", "по"):
            pending = "until"; i += 1; continue
        if low in ("с", "со", "from"):
            pending = "since"; i += 1; continue
        if low in ("—", "–", "-"):                  # маркер диапазона: пред. дата → since
            pending = "range"; i += 1; continue
        dt, consumed = _try_date_at(toks, i)
        if dt:
            iso = dt.isoformat()
            if pending == "range" and dates:
                dates[-1] = ("since", dates[-1][1])  # предыдущую сделать началом
                dates.append(("until", iso))
            else:
                dates.append((pending, iso))
            pending = None
            i += consumed
            continue
        break                                       # не дата и не маркер → дальше причина
    reason = " ".join(toks[i:]).strip()
    # разложить по ролям
    since = next((iso for h, iso in dates if h == "since"), "")
    until = next((iso for h, iso in dates if h == "until"), "")
    none_d = [iso for h, iso in dates if h is None]
    if not since and not until:
        if len(none_d) >= 2:
            since, until = none_d[0], none_d[1]     # две даты без маркеров = диапазон
        elif none_d:
            until = none_d[0]                       # одна дата = «до»
    elif since and not until and none_d:
        until = none_d[-1]
    elif until and not since and len(none_d) >= 1 and dates and dates[0][0] is None:
        since = none_d[0]
    return since, until, reason, bool(dates)


def _afk(rest: str, actor: dict) -> str:
    rest = (rest or "").strip()
    if not rest:
        return ("💤 /афк Ник ДАТА [причина]\n"
                "Форматы даты: 25.06.2026 · до 25.06.2026 · 25.06 · до 25 января ·\n"
                "с 25.05.2026 по 27.05.2026 · 25.05.2026-27.05.2026\n"
                "Причина — текст после даты. Снять: /афк -Ник")
    nick, tail = _split_nick_title(rest)
    if nick.startswith("-"):                        # снять АФК
        target = nick[1:].strip() or tail.strip()
        cn = _canon(target)
        if not cn:
            return "⚠ Не понял ник."
        prev = db.valor_afk_get_by_canon(cn)        # запомнить для отмены
        db.valor_clear_afk_by_canon(cn, _actor_for_create(actor))
        _remember(actor, "afk_clear", {"canon": cn, "nick": target, "prev": prev})
        return "✅ АФК снят: " + target
    cn = _canon(nick)
    if not cn:
        return "⚠ Не понял ник. Формат: /афк Ник ДАТА причина"
    since, until, reason, got = _parse_afk_dates(tail)
    prev = db.valor_afk_get_by_canon(cn)            # состояние ДО (для отмены)
    res = db.valor_set_afk_by_canon(
        cn, afk_until=until, afk_since=since,
        note=(reason if reason else None), actor=_actor_for_create(actor))
    if res.get("ok"):
        _remember(actor, "afk_set", {"canon": cn, "nick": res.get("nick") or nick, "prev": prev})
    if not res.get("ok"):
        return "⚠ Не получилось поставить АФК."
    disp = res.get("nick") or nick
    # показываем ФИНАЛЬНЫЕ даты (после логики продления — until мог не сократиться)
    f_until = res.get("afk_until") or ""
    f_since = res.get("afk_since") or ""
    out = "💤 АФК: " + disp
    if f_since and f_until:
        out += "\n• Период: с " + _ru_date(f_since) + " по " + _ru_date(f_until)
    elif f_until:
        out += ("\n• До: " + _ru_date(f_until) +
                (" (продлён)" if res.get("extended") else ""))
    else:
        out += "\n• Срок: бессрочно"
    if reason:
        out += "\n• Причина: " + reason
    if not got and not f_until:
        out += "\n⚠ Дату не распознал — поставил бессрочно. Форматы см. /help"
    out += "\nВидно на santdevil.com. Снять: /афк -" + disp
    return out


def _ru_date(iso: str) -> str:
    """'2026-06-25' → '25.06.2026' для ответа в чат."""
    try:
        y, m, d = iso.split("-")
        return d + "." + m + "." + y
    except Exception:
        return iso


def _help() -> str:
    return (
        "📋 ПРИЁМ НОВИЧКОВ В КЛАН\n" + _HR + "\n"
        "➕ /принять Ник Титул\n"
        "     принять новичка в список\n"
        "     напр: /принять DarkLord ~Vasya~\n\n"
        "↩ /отмена\n"
        "     отменить ПОСЛЕДНЮЮ команду (приём / чс / афк)\n\n"
        "📆 /список\n"
        "     кого приняли на этой неделе\n\n"
        "📜 /досье Ник   (или /история Ник — то же самое)\n"
        "     полное досье: игра+доблесть, твины, соцсети,\n"
        "     и отдельно IP/устройства/входы на сайт\n"
        "     ищет по ЛЮБЫМ данным: ник, имя-фамилия,\n"
        "     VK-домен, @tg, id — напр. /досье Артём Лапин\n\n"
        "💤 /афк Ник ДАТА [причина]\n"
        "     дать/продлить АФК игроку на сайте. Даты:\n"
        "     25.06.2026 · до 25.06.2026 · 25.06 · до 25 января ·\n"
        "     с 25.05.2026 по 27.05.2026 · 25.05.2026-27.05.2026\n"
        "     текст после даты = причина. Снять: /афк -Ник\n"
        "     напр: /афк Vasya до 25.05.2027 болеет\n\n"
        "🚫 /чс Ник [причина]\n"
        "     внести в чёрный список клана (видят офицеры\n"
        "     и админ на сайте). Убрать: /чс -Ник. Список: /чс\n\n"
        "🔑 /пароль 5623\n"
        "     сменить общий пароль клана (для входа игроков\n"
        "     на сайт). Обнови его в списке гильдии (кнопка G)\n" + _HR + "\n"
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
             or cmd in _HELP or cmd in _HISTORY or cmd in _SETPW
             or cmd in _BLACKLIST or cmd in _AFK)
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
        elif cmd in _SETPW:
            reply = _setpw(rest, actor)
        elif cmd in _BLACKLIST:
            reply = _blacklist(rest, actor)
        elif cmd in _AFK:
            reply = _afk(rest, actor)
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
