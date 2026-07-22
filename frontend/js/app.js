// Главная — таблица, форма добавления, inline-редактирование.
(async function () {
  const $ = (id) => document.getElementById(id);

  // ── Auth gate ──
  // Страница (офицерский реестр) скрыта классом html.booting, пока не выяснили
  // роль — чтобы ГОСТЬ НИКОГДА не увидел офицерскую страницу (её мелькание = та
  // самая «старая страница/окно» в жалобах). Гостя сразу уводим на Доблесть,
  // предварительно создав гостевую сессию, чтобы там не было лишней перезагрузки.
  const reveal = () => document.documentElement.classList.remove("booting");
  let me;
  try {
    me = await API.me();
  } catch (e) {
    // Нет сессии (или сеть недоступна) → становимся гостем и уходим на Доблесть.
    // Страница остаётся скрытой (booting) и тут же сменится — офицерский DOM не
    // покажется. Отдельного окна логина в основном потоке нет; офицер/админ
    // входят через дверцу «Офицерский вход» на Доблести.
    try { await API.loginGuest(); } catch (_) {}
    window.location.replace("clan-valor.html");
    return;
  }
  // Гость допущен только к таблице Доблести. На офицерских страницах данные
  // вернут 403 и страница будет битой — отправляем гостя на его раздел.
  if (me.role !== "officer" && me.role !== "admin") {
    window.location.replace("clan-valor.html");
    return;
  }
  reveal();   // подтверждён офицер/админ → показываем реестр
  function fmtRoleLabel(role) {
    if (role === "admin") return "АДМИНИСТРАТОР";
    if (role === "officer") return "ОФИЦЕР";
    return role.toUpperCase();
  }
  $("who").textContent = `${fmtRoleLabel(me.role)} • ${me.name}`;
  // CSS-гейт админ-группы вкладок: body[data-role=admin] показывает
  // .admin-only элементы. Без атрибута они скрыты (для офицеров).
  document.body.setAttribute("data-role", me.role);
  $("logout-btn").addEventListener("click", async () => {
    try { await API.logout(); } catch (_) {}
    // После выхода — обратно на Доблесть гостем (авто-гость там сработает).
    window.location.href = "clan-valor.html";
  });

  // ── Date input ──
  DateRu.bindDateInput($("f-date"));
  $("f-date").value = DateRu.today();

  // ── Скрин «Боевых Характеристик» (необязательно). Два способа приложить: ──
  //   1) файл с диска;
  //   2) ВСТАВКА из буфера (Ctrl+V) — работает с Ctrl+PrtScn и Win+Shift+S (вырезать область).
  // Любую картинку нормализуем в JPEG ≤1600px по большей стороне (меньше вес, влезает в лимит).
  let shotDataUrl = "";
  const SHOT_MAX = 1600;

  function setShotDataUrl(dataUrl, label) {
    shotDataUrl = dataUrl;
    if ($("f-shot-name")) $("f-shot-name").textContent = "✓ " + (label || "скрин прикреплён");
    if ($("f-shot-clear")) $("f-shot-clear").hidden = false;
    const pv = $("f-shot-preview");
    if (pv) { pv.hidden = false; pv.innerHTML = '<img alt="скрин боевых характеристик">'; pv.firstChild.src = dataUrl; }
  }
  function clearShot() {
    shotDataUrl = "";
    if ($("f-shot-input")) $("f-shot-input").value = "";
    if ($("f-shot-name")) $("f-shot-name").textContent = "";
    if ($("f-shot-clear")) $("f-shot-clear").hidden = true;
    const pv = $("f-shot-preview");
    if (pv) { pv.hidden = true; pv.innerHTML = ""; }
  }

  // Загрузить картинку из File/Blob/dataURL в <img>.
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const url = (typeof src === "string") ? src : URL.createObjectURL(src);
      const img = new Image();
      const done = (ok) => { if (typeof src !== "string") { try { URL.revokeObjectURL(url); } catch (_) {} } ok(); };
      img.onload = () => done(() => resolve(img));
      img.onerror = () => done(() => reject(new Error("img_load")));
      img.src = url;
    });
  }
  // Нормализовать в JPEG, ограничив бОльшую сторону SHOT_MAX.
  async function normalizeToDataUrl(src) {
    const img = await loadImage(src);
    let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    const scale = Math.min(1, SHOT_MAX / Math.max(w, h || 1));
    w = Math.max(1, Math.round(w * scale)); h = Math.max(1, Math.round(h * scale));
    const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
    cv.getContext("2d").drawImage(img, 0, 0, w, h);
    return cv.toDataURL("image/jpeg", 0.85);
  }
  async function attachShotFrom(src, label) {
    try { setShotDataUrl(await normalizeToDataUrl(src), label); return true; }
    catch (_) { setStatus("✗ Не удалось обработать изображение"); return false; }
  }

  // 1) Файл с диска
  if ($("f-shot-btn")) $("f-shot-btn").addEventListener("click", () => $("f-shot-input").click());
  if ($("f-shot-clear")) $("f-shot-clear").addEventListener("click", clearShot);
  if ($("f-shot-input")) $("f-shot-input").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (!/^image\//.test(file.type || "")) { setStatus("✗ Это не изображение"); return; }
    if (await attachShotFrom(file, file.name)) setStatus("✓ Скрин прикреплён (файл)");
  });

  // 2) Вставка из буфера (Ctrl+V) — image-элемент буфера. Текст не трогаем.
  document.addEventListener("paste", async (e) => {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.type && it.type.indexOf("image") === 0) {
        const blob = it.getAsFile();
        if (blob) {
          e.preventDefault();
          if (await attachShotFrom(blob, "вставлен из буфера")) {
            setStatus("✓ Скрин вставлен из буфера");
            const pv = $("f-shot-preview"); if (pv) pv.scrollIntoView({ behavior: "smooth", block: "nearest" });
          }
        }
        return;
      }
    }
  });

  // ── Ники из таблицы Доблести — для уведомления о дубле при регистрации ──
  const normNick = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, "");
  let valorNickSet = new Set();
  let clanNickList = [];          // отображаемые ники клана (для подсказок в поле «Титул»)
  try {
    const v = await API.valorCurrent();
    const members = (v && (v.members || v.rows || v.list)) || [];
    members.forEach((m) => { const n = m.nick || m.game_nick; if (n) { valorNickSet.add(normNick(n)); clanNickList.push(n); } });
  } catch (_) {}

  // Полный список ников клана: из Доблести + из самого реестра (allRows заполнится в reload).
  function clanNicksAll() {
    const map = new Map();        // normNick -> отображаемый ник (без дублей)
    clanNickList.forEach((n) => { if (n) map.set(normNick(n), n); });
    (allRows || []).forEach((r) => { if (r && r.game_nick) map.set(normNick(r.game_nick), r.game_nick); });
    return [...map.values()].sort((a, b) => a.localeCompare(b, "ru"));
  }

  // Автоподсказки ников для поля «Титул»: твин пишется как ~МэйнНик~. Пользователь
  // набирает часть ника мэйна → выбирает из клана → впишется «~ник~» (твин мэйна).
  function attachNickSuggest(input) {
    if (!input || input._nickSuggest) return;
    input._nickSuggest = true;
    const dd = document.createElement("div");
    dd.className = "nick-suggest";
    dd.style.cssText = "position:fixed;z-index:99999;display:none;max-height:250px;overflow-y:auto;" +
      "background:#1a1109;border:1px solid rgba(224,162,74,.42);border-radius:10px;" +
      "box-shadow:0 14px 40px rgba(0,0,0,.6);padding:4px";
    document.body.appendChild(dd);
    let items = [], active = -1;
    const place = () => {
      const r = input.getBoundingClientRect();
      dd.style.left = r.left + "px"; dd.style.top = (r.bottom + 3) + "px"; dd.style.width = r.width + "px";
    };
    const hide = () => { dd.style.display = "none"; active = -1; };
    const pick = (nick) => {
      input.value = "~" + nick + "~"; hide();
      input.dispatchEvent(new Event("input", { bubbles: true })); input.focus();
    };
    function render() {
      const raw = input.value.trim().replace(/~/g, "").toLowerCase();
      if (!raw) { hide(); return; }
      const all = clanNicksAll();
      items = all.filter((n) => n.toLowerCase().includes(raw)).slice(0, 10);
      if (!items.length) { hide(); return; }
      if (active >= items.length) active = items.length - 1;
      dd.innerHTML =
        '<div style="padding:5px 9px;font-size:11px;color:#a58c68;border-bottom:1px solid rgba(224,162,74,.15);margin-bottom:3px">' +
        'Выбери мэйна — впишется как <b style="color:#e0a86a">~ник~</b> (это твин)</div>' +
        items.map((n, i) =>
          '<div class="ns-item" data-i="' + i + '" style="padding:7px 10px;border-radius:7px;cursor:pointer;font-size:13.5px;' +
          'color:#f6ead2' + (i === active ? ';background:rgba(224,162,74,.20)' : '') + '">' +
          '<span style="color:#e0a86a">~</span>' + esc(n) + '<span style="color:#e0a86a">~</span></div>').join("");
      place(); dd.style.display = "block";
      [...dd.querySelectorAll(".ns-item")].forEach((el) => {
        el.addEventListener("mousedown", (e) => { e.preventDefault(); pick(items[+el.dataset.i]); });
        el.addEventListener("mouseenter", () => { active = +el.dataset.i; paint(); });
      });
    }
    function paint() {   // только подсветка активного (без пересчёта списка)
      [...dd.querySelectorAll(".ns-item")].forEach((el) => {
        el.style.background = (+el.dataset.i === active) ? "rgba(224,162,74,.20)" : "";
      });
    }
    input.addEventListener("input", () => { active = -1; render(); });
    input.addEventListener("focus", render);
    input.addEventListener("blur", () => setTimeout(() => {
      hide();
      // инлайн-редактор пересоздаёт поле — убираем осиротевший выпадающий список из body
      if (!document.body.contains(input)) dd.remove();
    }, 160));
    input.addEventListener("keydown", (e) => {
      if (dd.style.display === "none") return;
      // список открыт — гасим клавиши, чтобы не сработал Enter=сохранить / Esc=отмена инлайн-редактора
      if (e.key === "ArrowDown") { e.preventDefault(); e.stopImmediatePropagation(); active = Math.min(active + 1, items.length - 1); paint(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); e.stopImmediatePropagation(); active = Math.max(active - 1, 0); paint(); }
      else if (e.key === "Enter" && active >= 0) { e.preventDefault(); e.stopImmediatePropagation(); pick(items[active]); }
      else if (e.key === "Escape") { e.stopImmediatePropagation(); hide(); }
    });
    window.addEventListener("scroll", () => { if (dd.style.display !== "none") place(); }, true);
    window.addEventListener("resize", () => { if (dd.style.display !== "none") place(); });
  }
  attachNickSuggest($("f-title"));
  function checkNickDup() {
    const note = $("nick-dup-note");
    if (!note) return;
    const n = normNick($("f-nick").value);
    if (n && valorNickSet.has(n)) {
      note.hidden = false;
      note.textContent = "Этот ник уже есть в таблице Доблести — при регистрации запись объединится с ним. Зарегистрировать всё равно можно.";
    } else {
      note.hidden = true;
      note.textContent = "";
    }
  }
  $("f-nick").addEventListener("input", checkNickDup);

  // ── Проверка ника в архиве «Покинули клан» / кикнутых (с причиной) ──
  let _kickT = null, _kickSeq = 0;
  function checkNickKicked() {
    const note = $("nick-kicked-note");
    if (!note) return;
    const nick = $("f-nick").value.trim();
    clearTimeout(_kickT);
    if (!nick) { note.hidden = true; note.innerHTML = ""; return; }
    const seq = ++_kickSeq;
    _kickT = setTimeout(async () => {
      let res;
      try { res = await API.valorDepartedCheck(nick); } catch (_) { return; }
      if (seq !== _kickSeq) return;            // пришёл ответ на устаревший ввод
      const ms = (res && res.matches) || [];
      if (!ms.length) { note.hidden = true; note.innerHTML = ""; return; }
      note.innerHTML = ms.map((m) => {
        const who = esc(m.nick || nick);
        const week = m.last_week ? ` <span class="kn-week">(посл. неделя ${esc(m.last_week)})</span>` : "";
        if (m.kicked) {
          const reason = m.reason ? `Причина: <b>${esc(m.reason)}</b>` : "Причина не указана";
          const by = m.by ? ` · кикнул: ${esc(m.by)}` : "";
          return `⚠ <b>${who}</b> — в архиве <b>кикнутых</b>. ${reason}${by}.${week}`;
        }
        return `⚠ <b>${who}</b> — ранее <b>покинул клан</b> (в архиве «Покинули клан»).${week}`;
      }).join("<br>") +
      `<br><button type="button" class="return-archive-btn" title="Зарегистрировать в реестре, вернуть из архива Доблести, дать иммунитет на неделю и снять все предупреждения">` +
      `↩ Вернуть из архива <small>(+ иммунитет на неделю, снять все предупреждения)</small></button>`;
      note.hidden = false;
    }, 400);
  }
  $("f-nick").addEventListener("input", checkNickKicked);

  // Кнопка «Вернуть из архива» прямо в подсказке: регистрирует + возвращает из
  // архива + даёт недельный иммун новичка + убирает ВСЕ предупреждения.
  if ($("nick-kicked-note"))
    $("nick-kicked-note").addEventListener("click", async (ev) => {
      const btn = ev.target.closest(".return-archive-btn");
      if (!btn) return;
      const nick = $("f-nick").value.trim();
      const title = $("f-title").value.trim();
      const note = $("f-note").value.trim();
      const veteran = $("f-veteran") ? $("f-veteran").checked : false;
      const elite = $("f-elite") ? $("f-elite").checked : false;
      const iso = DateRu.parseRus($("f-date").value.trim());
      if (!nick) return;
      if (!iso) { setStatus("✗ Неверная дата — ожидаю ДД.ММ.ГГГГ"); return; }
      btn.disabled = true;
      setStatus("Возвращаю из архива…");
      try {
        const res = await API.valorReturnFromArchive({ game_nick: nick, title, note,
          accepted_date: iso, veteran, elite });
        $("f-nick").value = ""; $("f-title").value = ""; $("f-note").value = "";
        $("f-date").value = DateRu.today();
        if ($("f-veteran")) $("f-veteran").checked = false;
        if ($("f-elite")) $("f-elite").checked = false;
        if ($("nick-dup-note")) $("nick-dup-note").hidden = true;
        $("nick-kicked-note").hidden = true; $("nick-kicked-note").innerHTML = "";
        // В таблице доблести появится только если он есть на последнем скрине;
        // иначе просто вернулся в ростер (доблесть считается только по скрину).
        const onScreen = res && res.in_snapshot;
        setStatus(`✓ Возвращён из архива: ${nick} — иммунитет на неделю выдан, предупреждения сняты. ` +
          (onScreen
            ? "Есть на последнем скрине — уже в таблице доблести."
            : "В таблице доблести появится, когда попадёт на скрин (доблесть за неделю считается только по тем, кто на скрине)."));
        await reload();
      } catch (e) {
        setStatus(`✗ Ошибка: ${e.detail || e.message}`);
        btn.disabled = false;
      }
    });

  // ── Поиск по реестру ──
  if ($("reg-search")) $("reg-search").addEventListener("input", applyFilter);
  if ($("reg-offfilter")) $("reg-offfilter").addEventListener("change", applyFilter);

  // ── Add form ──
  $("add-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const nick = $("f-nick").value.trim();
    const title = $("f-title").value.trim();
    const rusDate = $("f-date").value.trim();
    const note = $("f-note").value.trim();
    const veteran = $("f-veteran") ? $("f-veteran").checked : false;
    const elite = $("f-elite") ? $("f-elite").checked : false;
    const combat_power = $("f-cp") ? Math.max(0, parseFloat($("f-cp").value) || 0) : 0;
    const survivability = $("f-sv") ? Math.max(0, parseFloat($("f-sv").value) || 0) : 0;

    const iso = DateRu.parseRus(rusDate);
    if (!nick) return;
    if (!iso) {
      setStatus("✗ Неверная дата — ожидаю ДД.ММ.ГГГГ");
      return;
    }

    setStatus("Добавляю…");
    try {
      await API.create({ game_nick: nick, title, accepted_date: iso, note, veteran, elite,
        combat_power, survivability, combat_shot: shotDataUrl || "" });
      $("f-nick").value = "";
      $("f-title").value = "";
      $("f-note").value = "";
      $("f-date").value = DateRu.today();
      if ($("f-cp")) $("f-cp").value = "";
      if ($("f-sv")) $("f-sv").value = "";
      clearShot();
      if ($("f-veteran")) $("f-veteran").checked = false;
      if ($("f-elite")) $("f-elite").checked = false;
      if ($("nick-dup-note")) $("nick-dup-note").hidden = true;
      if ($("nick-kicked-note")) { $("nick-kicked-note").hidden = true; $("nick-kicked-note").innerHTML = ""; }
      const cc = (combat_power || survivability) ? ` (БК ${combat_power} · Выж ${survivability})`
               : (shotDataUrl ? " (📎 скрин)" : "");
      setStatus(`✓ Принят: ${nick}${veteran ? " (★ Ветеран)" : ""}${elite ? " (⚔ Элита)" : ""}${cc}`);
      await reload();
      // Раскрываем список и показываем свежую запись (она вверху) — без прокрутки вручную.
      setRegListOpen(true, true);
      const panel = $("reg-panel");
      if (panel) panel.scrollIntoView({ behavior: "smooth", block: "start" });
      const firstRow = document.querySelector("#tbody tr");
      if (firstRow) { firstRow.classList.add("reg-row-flash"); setTimeout(() => firstRow.classList.remove("reg-row-flash"), 1600); }
    } catch (e) {
      setStatus(`✗ Ошибка: ${e.detail || e.message}`);
    }
  });

  // ── Глобальный тумблер «роль пока не выдана в игре» (виден только админу=Лиру).
  // Включён → КАЖДОМУ новому (и от Лира, и от офицеров) ставится флаг на сервере,
  // пока Лир не выключит. Снимается по человеку — кликом по бейджу / в редакторе.
  if (me.role === "admin" && $("f-role-pending")) {
    const rp = $("f-role-pending"), row = $("f-rolep-row");
    if (row) row.hidden = false;
    API.rolePendingGet().then((d) => { rp.checked = !!(d && d.enabled); }).catch(() => {});
    rp.addEventListener("change", async () => {
      try {
        const d = await API.rolePendingSet(rp.checked);
        rp.checked = !!(d && d.enabled);
        setStatus(rp.checked
          ? "✓ Флаг «титул не выдан в игре» включён — ставится всем новым (и от офицеров)"
          : "✓ Флаг «титул не выдан в игре» выключен");
      } catch (e) {
        rp.checked = !rp.checked;
        setStatus("✗ Ошибка: " + (e.detail || e.message));
      }
    });
  }

  // Кнопка «Копировать и очистить» списка «роль не выдана»: скопировать ники+титулы,
  // и ТОЛЬКО при успешном копировании — снять флаги со всех (список наберётся заново).
  if (me.role === "admin" && $("rolep-copy")) {
    $("rolep-copy").addEventListener("click", async () => {
      const ta = $("rolep-text");
      const text = ta ? ta.value.trim() : "";
      if (!text) return;
      let copied = false;
      try { await navigator.clipboard.writeText(text); copied = true; }
      catch (_) {
        try { ta.focus(); ta.select(); copied = document.execCommand("copy"); } catch (_) {}
      }
      if (!copied) { setStatus("✗ Не удалось скопировать — выдели текст и Ctrl+C"); return; }
      const n = text.split("\n").length;
      try {
        const d = await API.rolePendingClear();
        setStatus(`✓ Скопировано ${n} — флаги сняты (${d.cleared || 0}), список набирается заново`);
        await reload();
      } catch (e) {
        setStatus("✓ Скопировано, но не удалось снять флаги: " + (e.detail || e.message));
      }
    });
  }

  function setStatus(text) {
    $("form-status").textContent = text;
    if (text.startsWith("✓") || text.startsWith("✗")) {
      setTimeout(() => { $("form-status").textContent = ""; }, 4000);
    }
  }

  // ── Переход к нику из глобального поиска (?focus=canon): подсветить+прокрутить.
  //    Ищем строку и в основном реестре, и в архиве.
  function regCanon(s) { return (s || "").toString().toLowerCase().replace(/[\s\W_]+/gu, ""); }
  const REG_FOCUS = new URLSearchParams(location.search).get("focus") || "";
  let regFocusScrolled = false;
  function applyRegFocus() {
    if (!REG_FOCUS) return;
    const find = () => document.querySelector(
      '#tbody tr[data-canon="' + CSS.escape(REG_FOCUS) + '"], ' +
      '#arch-tbody tr[data-canon="' + CSS.escape(REG_FOCUS) + '"]');
    const tr = find();
    if (!tr) return;
    document.querySelectorAll(".reg-row-focus").forEach((x) => x.classList.remove("reg-row-focus"));
    tr.classList.add("reg-row-focus");
    if (regFocusScrolled) return;
    regFocusScrolled = true;
    const scroll = () => { const r = find(); if (r) r.scrollIntoView({ behavior: "smooth", block: "center" }); };
    requestAnimationFrame(scroll);
    setTimeout(() => {
      const r = find();
      if (r) {
        r.scrollIntoView({ behavior: "smooth", block: "center" });
        r.classList.add("reg-row-flash");
        setTimeout(() => r.classList.remove("reg-row-flash"), 1600);
      }
    }, 500);
  }

  // Открыть скрин боевых характеристик (тянем с авторизацией → object-URL).
  async function openShot(id) {
    try {
      const url = await API.accShotBlobUrl(id);
      const w = window.open(url, "_blank");
      // Через минуту отзываем URL (окно уже загрузило картинку).
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 60000);
      if (!w) setStatus("✗ Всплывающее окно заблокировано браузером");
    } catch (e) {
      setStatus(e.status === 404 ? "✗ Скрин не найден" : "✗ Не удалось открыть скрин");
    }
  }

  // Ячейка «Боевые хар-ки»: цифры (БК/Выж) и/или ссылка на скрин, иначе «—».
  function fmtMln(v) {
    const n = Number(v) || 0;
    if (!n) return "";
    // Красиво: 12 / 12.5 (без лишних нулей).
    return (Math.round(n * 10) / 10).toString();
  }
  function fillCombatCell(cell, r) {
    if (!cell) return;
    cell.innerHTML = "";
    cell.className = "combat reg-combat";
    const cp = fmtMln(r.combat_power), sv = fmtMln(r.survivability);
    let any = false;
    if (cp) {
      const s = document.createElement("span"); s.className = "rc-cp";
      s.textContent = "БК " + cp + " млн"; s.title = "Боевые качества (урон)";
      cell.appendChild(s); any = true;
    }
    if (sv) {
      if (any) cell.appendChild(document.createTextNode(" · "));
      const s = document.createElement("span"); s.className = "rc-sv";
      s.textContent = "Выж " + sv + " млн"; s.title = "Выживаемость";
      cell.appendChild(s); any = true;
    }
    if (r.has_shot) {
      if (any) cell.appendChild(document.createElement("br"));
      const a = document.createElement("a");
      a.className = "rc-shot"; a.textContent = "📎 скрин"; a.title = "Открыть скрин Боевых Характеристик";
      a.addEventListener("click", (e) => { e.preventDefault(); openShot(r.id); });
      cell.appendChild(a); any = true;
    }
    if (!any) {
      const s = document.createElement("span"); s.className = "rc-none"; s.textContent = "—";
      cell.appendChild(s);
    }
  }

  // ── Render table ──
  function renderTable(rows) {
    const tbody = $("tbody");
    tbody.innerHTML = "";

    if (!rows.length) {
      $("empty-state").hidden = false;
      return;
    }
    $("empty-state").hidden = true;

    rows.forEach((r, i) => {
      const tr = document.createElement("tr");
      tr.dataset.id = r.id;
      tr.dataset.canon = r.nick_canon || regCanon(r.game_nick);   // для перехода из поиска
      // Роль «Элита» (Топ по урону) — вся строка в роскошной золотой рамке.
      if (r.elite) tr.classList.add("row-elite");
      tr.innerHTML = `
        <td>${i + 1}</td>
        <td class="nick"></td>
        <td class="title"></td>
        <td class="combat"></td>
        <td class="date">${DateRu.fmtRus(r.accepted_date)}</td>
        <td class="${r.immune_active ? "immune-active" : "immune-expired"}">
          ${r.immune_active ? "до " : "истёк "}${DateRu.fmtRus(r.immune_until)}
        </td>
        <td class="note"></td>
        <td class="actor"></td>
        <td class="row-actions">
          <button class="btn-edit">Изменить</button>
          <button class="btn-arch" title="Ушёл/кикнут — в архив (даже если не попал в доблесть)">В архив</button>
          <button class="btn-del danger">Удалить</button>
        </td>
      `;
      // Ник + бейджи ролей (Элита/Ветеран) ВСЕГДА на отдельной строке ПОД ником
      // с небольшим отступом — единообразно для всех ников (не зависит от длины).
      // Через DOM (без innerHTML) — безопасно к нику.
      const nickCell = tr.querySelector(".nick");
      const nameEl = document.createElement("span");
      nameEl.className = "reg-nick-name";
      nameEl.textContent = r.game_nick;
      nickCell.appendChild(nameEl);
      if (r.elite || r.veteran || r.role_pending) {
        const box = document.createElement("div");
        box.className = "reg-roles";
        const addRole = (cls, txt, title, onClick) => {
          const b = document.createElement("span");
          b.className = "reg-role " + cls;
          b.textContent = txt;
          b.title = title;
          if (onClick) { b.style.cursor = "pointer"; b.addEventListener("click", onClick); }
          box.appendChild(b);
        };
        if (r.elite)   addRole("reg-role-elite", "⚔ Элита", "Роль Элита (Топ по урону)");
        if (r.veteran) addRole("reg-role-vet", "★ Ветеран", "Роль Ветеран");
        if (r.role_pending) addRole("reg-role-pending", "⏳ титул не выдан в игре",
          me.role === "admin" ? "Титул ещё не выдан в игре. Нажми, когда выдашь — снять флаг."
                              : "Титул ещё не выдан в игре",
          me.role === "admin" ? async () => {
            try { await API.update(r.id, { role_pending: false }); await reload(); }
            catch (e) { setStatus("✗ Ошибка: " + (e.detail || e.message)); }
          } : null);
        nickCell.appendChild(box);
      }
      // Предупреждение «уже был в клане» (архив/кик) + причина — ПОД ником.
      if (r.prev_departed) {
        const pd = r.prev_departed;
        const w = document.createElement("div");
        w.className = "reg-prev-warn";
        let txt = "⚠ Уже был в клане";
        const reason = (pd.reason || "").trim();
        if (reason) txt += " · причина: " + reason;
        else if (pd.kicked) txt += " · был кикнут (причина не указана)";
        if ((pd.by || "").trim()) txt += " · " + pd.by.trim();
        w.textContent = txt;
        w.title = "Этот человек уже состоял в клане и попал в архив/был кикнут — проверь, стоит ли принимать снова";
        nickCell.appendChild(w);
      }
      tr.querySelector(".title").textContent = r.title || "—";
      fillCombatCell(tr.querySelector(".combat"), r);
      const actorCell = tr.querySelector(".actor");
      actorCell.textContent = r.created_by_name;
      if (r.by_officer) {   // пометка «принят офицером» — видна только админу (CSS-гейт)
        const b = document.createElement("span");
        b.className = "reg-off-badge";
        b.textContent = "👮 офицер";
        b.title = "Принят офицером (не тобой) — возможно, стоит перепроверить данные";
        actorCell.appendChild(b);
      }

      // Примечание — тот же «свиток», что и в таблице Доблести (общий модуль,
      // общие данные). Клик открывает историю; правки синхронны с Доблестью.
      const noteCell = tr.querySelector(".note");
      const isAdmin = me.role === "admin";
      function paintNote() {
        noteCell.innerHTML = window.NoteScroll
          ? NoteScroll.renderCell({
              canon: r.nick_canon, nick: r.game_nick,
              note: r.note || "", count: r.note_count || 0, isOfficer: true })
          : (r.note ? esc(r.note) : "—");
      }
      paintNote();
      noteCell.addEventListener("click", (e) => {
        const b = e.target.closest(".cn-open, .cn-add");
        if (!b || !r.nick_canon || !window.NoteScroll) return;
        NoteScroll.open({
          canon: r.nick_canon, nick: r.game_nick, isAdmin,
          onChange: (data) => {
            r.note = (data && data.current) || "";
            r.note_count = (data && data.count) || 0;
            if (editingId !== r.id) paintNote();
          },
        });
      });

      tr.querySelector(".btn-del").addEventListener("click", () => onDelete(r));
      tr.querySelector(".btn-edit").addEventListener("click", () => onEdit(tr, r));
      tr.querySelector(".btn-arch").addEventListener("click", () => onArchive(r));
      tbody.appendChild(tr);
    });
    applyRegFocus();
  }

  async function onArchive(r) {
    const reason = prompt(
      `Отправить "${r.game_nick}" в архив реестра (ушёл/кикнут из клана)?\n` +
      `Можно указать причину (необязательно):`, "");
    if (reason === null) return;   // отмена
    try {
      await API.accArchive(r.id, reason.trim());
      await reload();
      await loadArchive();
    } catch (e) {
      alert(`Не удалось архивировать: ${e.detail || e.message}`);
    }
  }

  // ── Архив реестра (ушли из клана) ──
  function renderArchive(rows) {
    const tb = $("arch-tbody");
    tb.innerHTML = "";
    $("arch-count").textContent = rows.length ? `(${rows.length})` : "";
    $("arch-empty").hidden = rows.length > 0;
    rows.forEach((r, i) => {
      const tr = document.createElement("tr");
      tr.dataset.canon = r.nick_canon || regCanon(r.game_nick);   // для перехода из поиска
      tr.innerHTML = `
        <td>${i + 1}</td>
        <td class="nick"></td><td class="title"></td>
        <td>${DateRu.fmtRus(r.accepted_date)}</td>
        <td>${r.archived_at ? DateRu.fmtRus(r.archived_at.slice(0, 10)) : "—"}</td>
        <td class="reason"></td>
        <td class="row-actions"><button class="btn-restore">Вернуть</button></td>`;
      tr.querySelector(".nick").textContent = r.game_nick;
      tr.querySelector(".title").textContent = r.title || "—";
      tr.querySelector(".reason").textContent = r.archived_reason || "—";
      tr.querySelector(".btn-restore").addEventListener("click", async () => {
        try { await API.accUnarchive(r.id); await reload(); await loadArchive(); }
        catch (e) { alert(`Не удалось вернуть: ${e.detail || e.message}`); }
      });
      tb.appendChild(tr);
    });
    applyRegFocus();
  }

  async function loadArchive() {
    try { renderArchive(await API.accArchivedList()); } catch (_) {}
  }

  (function initArchiveToggle() {
    const t = $("arch-toggle");
    if (!t) return;
    t.addEventListener("click", () => {
      const w = $("arch-wrap");
      const open = w.style.display !== "none";
      w.style.display = open ? "none" : "block";
      $("arch-arrow").textContent = open ? "▶" : "▼";
    });
  })();

  let allRows = [];
  function applyFilter() {
    const box = $("reg-search");
    const q = (box ? box.value : "").trim().toLowerCase();
    const offOnly = $("reg-offfilter") && $("reg-offfilter").checked;
    let rows = allRows;
    if (offOnly) rows = rows.filter((r) => r.by_officer);   // только принятые офицерами
    if (q) {
      rows = rows.filter((r) =>
        [r.game_nick, r.title, r.note, r.created_by_name,
         DateRu.fmtRus(r.accepted_date),
         // Роли — чтобы искать по «ветеран» / «элита» (топ по урону).
         r.veteran ? "ветеран veteran" : "",
         r.elite ? "элита elite топ по урону" : ""]
          .join(" ").toLowerCase().includes(q));
    }
    renderTable(rows);
    const c = $("reg-search-count");
    if (c) c.textContent = q ? `найдено ${rows.length} из ${allRows.length}` : "";
    // Счётчик «принятых офицерами» рядом с фильтром (только админ видит сам фильтр).
    const oc = $("reg-offfilter-count");
    if (oc) { const n = allRows.filter((r) => r.by_officer).length; oc.textContent = n ? `— ${n}` : ""; }
  }

  async function reload() {
    try {
      allRows = await API.list();
      // Новые — СВЕРХУ: только что принятый виден сразу, без прокрутки вниз.
      // Сортируем по дате приёма, при равенстве — по id (позже внесён = выше).
      allRows.sort((a, b) =>
        String(b.accepted_date).localeCompare(String(a.accepted_date)) || (b.id - a.id));
      applyFilter();
      renderRolePendingPanel();
      updateRegCount();
    } catch (e) {
      setStatus(`✗ Не удалось загрузить: ${e.message}`);
    }
  }

  // Счётчик в свёрнутом заголовке списка.
  function updateRegCount() {
    const c = $("reg-count");
    if (c) c.textContent = allRows.length ? `(${allRows.length})` : "";
  }

  // ── Сворачиваемый список принятых (как вкладка) ──
  const REG_OPEN_KEY = "reg_list_open";
  function setRegListOpen(open, save) {
    const w = $("reg-wrap"), arrow = $("reg-arrow"), hint = document.querySelector(".reg-head-hint");
    if (!w) return;
    w.style.display = open ? "block" : "none";
    if (arrow) arrow.textContent = open ? "▼" : "▶";
    if (hint) hint.textContent = open ? "нажми, чтобы свернуть" : "нажми, чтобы раскрыть";
    if (save) { try { localStorage.setItem(REG_OPEN_KEY, open ? "1" : "0"); } catch (_) {} }
  }
  function isRegListOpen() { return $("reg-wrap") && $("reg-wrap").style.display !== "none"; }
  (function initRegToggle() {
    const t = $("reg-toggle");
    if (!t) return;
    let open = false;
    try { open = localStorage.getItem(REG_OPEN_KEY) === "1"; } catch (_) {}
    setRegListOpen(open, false);
    t.addEventListener("click", () => setRegListOpen(!isRegListOpen(), true));
  })();

  // Панель «Роль пока не выдана в игре» (только админ=Лир): ники+титулы в столбик
  // для копирования в чат. Список строится из записей реестра с флагом role_pending.
  function renderRolePendingPanel() {
    const panel = $("rolep-panel");
    if (!panel) return;
    if (me.role !== "admin") { panel.hidden = true; return; }
    const list = (allRows || []).filter((r) => r.role_pending && !r.archived);
    const ta = $("rolep-text"), cnt = $("rolep-count");
    if (!list.length) { panel.hidden = true; if (ta) ta.value = ""; return; }
    panel.hidden = false;
    const lines = list.map((r) => {
      const t = (r.title || "").trim();
      return t ? `${r.game_nick} — ${t}` : r.game_nick;
    });
    if (ta) ta.value = lines.join("\n");
    if (cnt) cnt.textContent = `${list.length} чел.`;
  }

  async function onDelete(r) {
    if (!confirm(`Удалить запись "${r.game_nick}" (принят ${DateRu.fmtRus(r.accepted_date)})?`)) return;
    try {
      await API.remove(r.id);
      await reload();
    } catch (e) {
      alert(`Не удалось удалить: ${e.detail || e.message}`);
    }
  }

  // ID записи которая сейчас редактируется. Пока не null — auto-refresh
  // таблицы паузится, чтобы перерисовка не убила inline-редактор пользователя.
  let editingId = null;

  function onEdit(tr, r) {
    editingId = r.id;

    const nickCell  = tr.querySelector(".nick");
    const titleCell = tr.querySelector(".title");
    const combatCell = tr.querySelector(".combat");
    const dateCell  = tr.querySelector(".date");
    const noteCell  = tr.querySelector(".note");
    const actions   = tr.querySelector(".row-actions");

    nickCell.innerHTML  = `<input type="text" value="${esc(r.game_nick)}" style="width:100%">`;
    titleCell.innerHTML = `<input type="text" value="${esc(r.title || "")}" placeholder="титул / ~мэйн~" style="width:100%">`;
    attachNickSuggest(titleCell.querySelector("input"));   // подсказки ников клана для титула-твина

    // Боевые характеристики: 2 цифры + управление скрином (заменить/убрать/открыть).
    // editShot: undefined = не менять; "" = удалить; dataURL = заменить.
    let editShot;
    const cpVal = (Number(r.combat_power) || 0) || "";
    const svVal = (Number(r.survivability) || 0) || "";
    combatCell.innerHTML =
      `<input type="number" class="ed-cp combat-num" style="width:78px" min="0" step="0.1" placeholder="БК млн" value="${cpVal}">`
      + `<input type="number" class="ed-sv combat-num" style="width:78px;margin-left:4px" min="0" step="0.1" placeholder="Выж млн" value="${svVal}">`
      + `<div class="ed-shot-ctl" style="margin-top:5px;font-size:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">`
      + (r.has_shot
          ? `<a href="#" class="ed-shot-open rc-shot">📎 открыть</a><a href="#" class="ed-shot-del" style="color:#ff9a8a">✕ убрать скрин</a>`
          : "")
      + `<label class="ed-shot-replace" style="color:#8fc36a;cursor:pointer">📎 ${r.has_shot ? "заменить" : "прикрепить"}<input type="file" accept="image/png,image/jpeg,image/webp" hidden></label>`
      + `<span class="ed-shot-state" style="color:#8fc36a"></span></div>`;
    const shotState = combatCell.querySelector(".ed-shot-state");
    const openLink = combatCell.querySelector(".ed-shot-open");
    if (openLink) openLink.addEventListener("click", (e) => { e.preventDefault(); openShot(r.id); });
    const delLink = combatCell.querySelector(".ed-shot-del");
    if (delLink) delLink.addEventListener("click", (e) => {
      e.preventDefault(); editShot = ""; if (shotState) shotState.textContent = "скрин будет удалён";
    });
    const replInput = combatCell.querySelector(".ed-shot-replace input");
    if (replInput) replInput.addEventListener("change", async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      if (!/^image\//.test(f.type || "")) { if (shotState) shotState.textContent = "не изображение"; return; }
      try { editShot = await normalizeToDataUrl(f); if (shotState) shotState.textContent = "✓ новый скрин"; }
      catch (_) { if (shotState) shotState.textContent = "ошибка чтения"; }
    });

    dateCell.innerHTML  = `<input type="text" value="${DateRu.fmtRus(r.accepted_date)}" placeholder="ДД.ММ.ГГГГ" style="width:100%">`;
    noteCell.innerHTML  = `<input type="text" value="${esc(r.note || "")}" style="width:100%">`;
    actions.innerHTML =
      `<label class="ed-vet-lbl" title="Роль Ветеран в Доблести">`
      + `<input type="checkbox" class="ed-vet" ${r.veteran ? "checked" : ""}> ★Вет</label>`
      + `<label class="ed-elite-lbl" title="Роль Элита (Топ по урону) в Доблести">`
      + `<input type="checkbox" class="ed-elite" ${r.elite ? "checked" : ""}> ⚔Элита</label>`
      + `<label class="ed-rolep-lbl" title="Титул пока НЕ выдан в игре (снять, когда выдашь)">`
      + `<input type="checkbox" class="ed-rolep" ${r.role_pending ? "checked" : ""}> ⏳не выдан</label>`
      + `<button class="save">Сохранить</button><button class="cancel">Отмена</button>`;

    DateRu.bindDateInput(dateCell.querySelector("input"));

    // Фокус на первое поле — удобно сразу набирать.
    setTimeout(() => {
      try {
        const i = nickCell.querySelector("input");
        i.focus();
        i.select();
      } catch (_) {}
    }, 0);

    async function finish() {
      editingId = null;
      await reload();
    }

    // Enter в любом поле = сохранить, Esc = отмена.
    [nickCell, titleCell, dateCell, noteCell].forEach(cell => {
      cell.querySelector("input").addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") { ev.preventDefault(); doSave(); }
        else if (ev.key === "Escape") { ev.preventDefault(); finish(); }
      });
    });

    async function doSave() {
      const rusDate = dateCell.querySelector("input").value.trim();
      const iso = DateRu.parseRus(rusDate);
      if (!iso) {
        alert("Неверная дата — ожидаю ДД.ММ.ГГГГ");
        return;
      }
      const vetBox = actions.querySelector(".ed-vet");
      const eliteBox = actions.querySelector(".ed-elite");
      const rolepBox = actions.querySelector(".ed-rolep");
      const cpBox = combatCell.querySelector(".ed-cp");
      const svBox = combatCell.querySelector(".ed-sv");
      const payload = {
        game_nick:     nickCell.querySelector("input").value.trim(),
        title:         titleCell.querySelector("input").value.trim(),
        accepted_date: iso,
        note:          noteCell.querySelector("input").value.trim(),
        veteran:       vetBox ? vetBox.checked : undefined,
        elite:         eliteBox ? eliteBox.checked : undefined,
        role_pending:  rolepBox ? rolepBox.checked : undefined,
        combat_power:  cpBox ? Math.max(0, parseFloat(cpBox.value) || 0) : undefined,
        survivability: svBox ? Math.max(0, parseFloat(svBox.value) || 0) : undefined,
      };
      if (editShot !== undefined) payload.combat_shot = editShot;   // ""=удалить, dataURL=заменить
      try {
        await API.update(r.id, payload);
        await finish();
      } catch (e) {
        alert(`Не удалось сохранить: ${e.detail || e.message}`);
      }
    }

    actions.querySelector(".cancel").addEventListener("click", finish);
    actions.querySelector(".save").addEventListener("click", doSave);
  }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  await reload();
  await loadArchive();
  // Auto-refresh раз в 30 сек, но НЕ выбивает пользователя из редактирования.
  setInterval(() => { if (editingId === null) reload(); }, 30000);
})();
