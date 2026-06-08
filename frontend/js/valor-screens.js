// Скрины сбора ↔ распознанные данные: папки по неделям + сравнение скринов с
// тем, как база распознала строки, с правкой (админ) и копированием.
(async function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  let me, IS_ADMIN = false;
  try { me = await API.me(); } catch (_) { location.href = "login.html"; return; }
  if (!me || me.role === "guest") { location.href = "clan-valor.html"; return; }
  IS_ADMIN = me.role === "admin";
  $("who").textContent = (me.username || me.name || "") +
    (IS_ADMIN ? " · админ" : " · офицер");
  document.body.setAttribute("data-role", me.role || "");
  $("logout-btn").addEventListener("click", async () => {
    try { await API.logout(); } catch (_) {}
    location.href = "login.html";
  });

  // ── Лайтбокс ──
  const lb = $("vs-lightbox"), lbImg = $("vs-lightbox-img");
  lb.addEventListener("click", () => { lb.hidden = true; lbImg.src = ""; });
  const openLightbox = (url) => { lbImg.src = url; lb.hidden = false; };

  // ── Тост (копирование) ──
  let toastT = null;
  function toast(msg) {
    const el = $("cmp-toast"); el.textContent = msg; el.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => { el.hidden = true; }, 1400);
  }
  function copy(text) {
    navigator.clipboard?.writeText(text).then(
      () => toast("Скопировано: " + text), () => toast("Не удалось скопировать"));
  }

  let DATA = null, openWeek = null;
  // Переход с таблицы Доблести (двойной клик): подсветить нужный ник.
  const FOCUS_CANON = new URLSearchParams(location.search).get("focus") || "";

  // ── Загрузка недели для сравнения ──
  async function loadWeek(week, cardEl) {
    document.querySelectorAll(".vs-folder").forEach(e => e.classList.remove("vs-folder-on"));
    if (cardEl) cardEl.classList.add("vs-folder-on");
    openWeek = week;
    $("cmp").hidden = false;
    $("cmp-meta").textContent = "Загрузка " + week + "…";
    $("cmp-shots").innerHTML = ""; $("cmp-rows").innerHTML = "";
    try {
      DATA = await API.valorCompare(week);
    } catch (e) {
      $("cmp-meta").textContent = "Ошибка: " + (e.detail || e.message); return;
    }
    const sn = DATA.snapshot || {};
    $("cmp-meta").innerHTML = `<b>${esc(week)}</b> · норма ${sn.valor_norm ?? "?"} · ` +
      `${DATA.members.length} строк · ${DATA.screenshots.length} кадров`;
    renderShots();
    renderRows();
  }

  // ── Левая колонка: скрины ──
  function renderShots() {
    const box = $("cmp-shots");
    box.innerHTML = DATA.screenshots.map(s =>
      `<figure class="cmp-shot" data-idx="${s.idx}">
         <img loading="lazy" src="${esc(s.url)}" alt="кадр ${s.idx}" data-full="${esc(s.url)}">
         <figcaption>кадр #${s.idx}</figcaption>
       </figure>`).join("");
    box.querySelectorAll(".cmp-shot img").forEach(img =>
      img.addEventListener("click", () => openLightbox(img.dataset.full)));
  }

  // ── Правая колонка: распознанные строки ──
  function badges(m) {
    const b = [];
    if (m.in_registry)
      b.push(`<span class="cmp-badge bdg-reg" title="ник совпал с реестром приёма (надёжно)">реестр</span>`);
    else if (m.flag_new_nick)
      b.push(`<span class="cmp-badge bdg-ai" title="впервые появился в сборе, распознан ИИ — проверь по скрину и при желании занеси в реестр">ИИ-ник</span>`);
    else
      b.push(`<span class="cmp-badge bdg-seen" title="постоянный участник: есть в таблице Доблести со стабильным ником, просто не занесён в реестр приёма — это нормально">в Доблести</span>`);
    if (m.is_afk) b.push(`<span class="cmp-badge bdg-afk">АФК</span>`);
    return b.join(" ");
  }

  // Конкретные поля, в распознавании которых система сомневается.
  // field → {label: коротко, tip: подробно}. Берём из имеющихся сигналов.
  function suspectFields(m) {
    const f = {};
    if (m.flag_new_nick)
      f.nick = { label: "написание ника", tip: "ник распознан ИИ и не найден в реестре — сверь написание со скрином" };
    if (m.valor == null)
      f.valor = { label: "доблесть", tip: "доблесть не распознана со скрина — впиши вручную" };
    if (m.level == null)
      f.level = { label: "уровень", tip: "уровень не распознан со скрина" };
    if (m.flag_ocr_suspect)
      f.class_ = { label: "класс", tip: "класс распознан с автоправкой (напр. Mar→Маг) — проверь" };
    return f;
  }
  function isSuspect(m) { return Object.keys(suspectFields(m)).length > 0; }

  const cell = (v) => `<td class="cmp-c" title="клик — копировать">${esc(v == null || v === "" ? "—" : v)}</td>`;
  const cellW = (v, warn, tip) =>
    `<td class="cmp-c${warn ? " cmp-cell-warn" : ""}" title="${warn ? esc(tip) : "клик — копировать"}">${esc(v == null || v === "" ? "—" : v)}</td>`;

  function rowsHtml(list) {
    return list.map((m) => {
      const sf = suspectFields(m);
      const keys = Object.keys(sf);
      const warn = keys.length > 0;
      const tipAll = keys.map(k => sf[k].tip).join("; ");
      const susBadge = warn
        ? ` <span class="cmp-badge bdg-sus" title="${esc("Проверь по скрину: " + tipAll)}">⚠ проверить</span>`
        : "";
      // «✓ верно» — снять отметку сомнения у строки, где значение ЕСТЬ, просто
      // нужно подтверждение человека (ник распознан ИИ / автоправка класса).
      // Для пустых значений (доблесть/уровень) кнопки нет — их надо вписать.
      const confirmable = !!(m.flag_new_nick || m.flag_ocr_suspect);
      const okBtn = (warn && confirmable && IS_ADMIN)
        ? ` <button class="cmp-ok" data-id="${m.id}" title="Я проверил — распознано верно, снять отметку сомнения">✓ верно</button>`
        : "";
      const reasonsLine = warn
        ? `<div class="cmp-reasons" title="${esc(tipAll)}">⚠ проверь: ${esc(keys.map(k => sf[k].label).join(", "))}${okBtn}</div>`
        : "";
      const valorWarn = !!sf.valor;
      return `<tr class="cmp-row${warn ? " cmp-row-warn" : ""}" data-i="${m._i}" data-canon="${esc(m.nick_canon)}" data-frame="${m.frame == null ? "" : m.frame}">
        <td class="cmp-num">${m._i + 1}</td>
        <td class="cmp-nick"><span class="cmp-nick-t${sf.nick ? " cmp-cell-warn" : ""}" title="${sf.nick ? esc(sf.nick.tip) : "клик — показать кадр слева · двойной клик — к нику в Доблести"}">${esc(m.nick)}</span><br>${badges(m)}${susBadge}${reasonsLine}</td>
        ${cell(m.true_name)}${cell(m.rank)}${cell(m.title)}${cellW(m.level, !!sf.level, sf.level && sf.level.tip)}
        ${cellW(m.class, !!sf.class_, sf.class_ && sf.class_.tip)}<td class="cmp-c cmp-valor${valorWarn ? " cmp-cell-warn" : ""}" title="${valorWarn ? esc(sf.valor.tip) : "клик — копировать"}">${m.valor == null ? "—" : m.valor}</td>
        <td class="cmp-act">${IS_ADMIN
          ? `<button class="cmp-ed" data-id="${m.id}" title="править">✎</button>` +
            ` <button class="cmp-del" data-id="${m.id}" data-nick="${esc(m.nick)}" title="удалить фантом OCR / дубль">🗑</button>`
          : ""}</td>
      </tr>`;
    }).join("");
  }

  function renderRows() {
    DATA.members.forEach((m, i) => { m._i = i; });
    const box = $("cmp-rows");
    box.innerHTML =
      `<table class="cmp-table"><thead><tr>
        <th>#</th><th>Ник / распознавание</th><th>Имя</th><th>Должн.</th>
        <th>Титул</th><th>Ур</th><th>Класс</th><th>Добл</th><th></th>
      </tr></thead><tbody>${rowsHtml(DATA.members)}</tbody></table>`;
    bindRows();
  }

  function applyFilter() {
    const q = ($("cmp-filter").value || "").trim().toLowerCase();
    const onlySus = $("cmp-suspect").checked;
    const list = DATA.members.filter(m => {
      if (onlySus && !isSuspect(m)) return false;
      if (!q) return true;
      return [m.nick, m.true_name, m.class, m.title, m.rank]
        .some(v => (v || "").toLowerCase().includes(q));
    });
    $("cmp-rows").querySelector("tbody").innerHTML = rowsHtml(list);
    bindRows();
  }

  function selectRow(tr) {
    const tbody = $("cmp-rows").querySelector("tbody");
    if (!tbody || !tr) return;
    const fr = tr.dataset.frame;
    scrollToFrame(+tr.dataset.i, (fr === "" || fr == null) ? null : +fr);
    tbody.querySelectorAll(".cmp-row-on").forEach(x => x.classList.remove("cmp-row-on"));
    tr.classList.add("cmp-row-on");
  }

  function bindRows() {
    const tbody = $("cmp-rows").querySelector("tbody");
    if (!tbody) return;
    // копирование значений (только ячейки данных, не ник)
    tbody.querySelectorAll(".cmp-c").forEach(c =>
      c.addEventListener("click", () => copy(c.textContent.trim())));
    tbody.querySelectorAll(".cmp-row").forEach(tr => {
      // Ник: одиночный клик — показать кадр слева.
      const nickEl = tr.querySelector(".cmp-nick-t");
      if (nickEl) nickEl.addEventListener("click", () => selectRow(tr));
      // Клик по строке (не по нику/значению/кнопке) → тоже показать кадр.
      tr.addEventListener("click", (e) => {
        if (e.target.closest(".cmp-ed") || e.target.closest(".cmp-del") ||
            e.target.closest(".cmp-ok") || e.target.closest(".cmp-c") ||
            e.target.closest(".cmp-nick-t")) return;
        selectRow(tr);
      });
    });
    if (IS_ADMIN) {
      tbody.querySelectorAll(".cmp-ed").forEach(b =>
        b.addEventListener("click", () => openEdit(+b.dataset.id)));
      tbody.querySelectorAll(".cmp-del").forEach(b =>
        b.addEventListener("click", () => delMember(+b.dataset.id, b.dataset.nick)));
      tbody.querySelectorAll(".cmp-ok").forEach(b =>
        b.addEventListener("click", (e) => { e.stopPropagation(); verifyMember(+b.dataset.id); }));
    }
  }

  // ── Подтвердить, что строка распознана верно (снять сомнение) ──
  async function verifyMember(id) {
    const cur = (DATA.members || []).find(x => x.id === id);
    const canon = cur && cur.nick_canon;
    try {
      await API.valorMemberVerify(id);
      toast("Отмечено как верное");
      await reloadKeepScroll(canon);
    } catch (e) { toast("Ошибка: " + (e.detail || e.message)); }
  }

  // Текущая выбранная папка недели (для перезагрузки после правок).
  const activeFolder = () => document.querySelector(".vs-folder-on");

  // Подсветить ник, на который пришли двойным кликом из таблицы Доблести.
  function focusFromUrl() {
    if (!FOCUS_CANON) return;
    const tbody = $("cmp-rows").querySelector("tbody");
    if (!tbody) return;
    const tr = [...tbody.querySelectorAll(".cmp-row")]
      .find(x => x.dataset.canon === FOCUS_CANON);
    if (!tr) return;
    tr.scrollIntoView({ behavior: "smooth", block: "center" });
    selectRow(tr);
  }

  // Перечитать данные недели и перерисовать ТОЛЬКО правую таблицу, СОХРАНИВ
  // прокрутку (скрины не трогаем, чтобы не дёргалось). После правки/verify
  // это держит пользователя на том же месте и подсвечивает строку.
  async function reloadKeepScroll(focusCanon) {
    const box = $("cmp-rows");
    const prevTop = box ? box.scrollTop : 0;
    try {
      DATA = await API.valorCompare(openWeek);
    } catch (e) { toast("Ошибка: " + (e.detail || e.message)); return; }
    const sn = DATA.snapshot || {};
    $("cmp-meta").innerHTML = `<b>${esc(openWeek)}</b> · норма ${sn.valor_norm ?? "?"} · ` +
      `${DATA.members.length} строк · ${DATA.screenshots.length} кадров`;
    renderRows();                                   // выставит _i + полную таблицу
    const q = ($("cmp-filter").value || "").trim();
    if (q || $("cmp-suspect").checked) applyFilter(); // если фильтр активен
    if (box) box.scrollTop = prevTop;               // вернуть позицию
    if (focusCanon && box) {
      const tr = [...box.querySelectorAll(".cmp-row")].find(x => x.dataset.canon === focusCanon);
      if (tr) {
        tr.classList.add("cmp-row-on");
        const rt = tr.offsetTop, rb = rt + tr.offsetHeight;
        if (rt < box.scrollTop || rb > box.scrollTop + box.clientHeight)
          box.scrollTop = Math.max(0, rt - box.clientHeight / 2);
      }
    }
  }

  // ── Удаление строки (админ): фантом OCR / дубль ──
  async function delMember(id, nick) {
    if (!confirm(`Удалить строку «${nick}» из недели ${openWeek}?\n` +
      `Используй для фантома OCR или дубля. Строка исчезнет и из таблицы «Доблесть».`)) return;
    try {
      await API.valorMemberDelete(id);
      toast("Удалено: " + nick);
      await reloadKeepScroll();   // строки больше нет — просто держим позицию
    } catch (e) { toast("Ошибка: " + (e.detail || e.message)); }
  }

  // ── Добавить пропущенную строку (админ) ──
  function openAdd() {
    if (!openWeek) { toast("Сначала выбери неделю"); return; }
    const ov = $("cmp-edit");
    const f = (lbl, key, val, type) =>
      `<label class="ce-f"><span>${lbl}</span>
        <input data-k="${key}" type="${type || "text"}" value="${esc(val == null ? "" : val)}"></label>`;
    ov.innerHTML =
      `<div class="ce-box">
        <div class="ce-h">Добавить строку · неделя <b>${esc(openWeek)}</b></div>
        ${f("Ник", "nick", "")}
        ${f("Имя (true_name)", "true_name", "")}
        ${f("Должность", "rank", "")}
        ${f("Титул", "title", "")}
        ${f("Уровень", "level", "", "number")}
        ${f("Класс", "class", "")}
        ${f("Доблесть", "valor", "", "number")}
        <label class="ce-f ce-chk"><input data-k="is_afk" type="checkbox"> АФК</label>
        <div class="ce-btns">
          <button id="ce-save" class="ce-save">Добавить</button>
          <button id="ce-cancel" class="ce-cancel">Отмена</button>
        </div>
        <div class="ce-msg" id="ce-msg"></div>
      </div>`;
    ov.hidden = false;
    ov.querySelector("#ce-cancel").onclick = () => { ov.hidden = true; };
    ov.onclick = (e) => { if (e.target === ov) ov.hidden = true; };
    ov.querySelector("#ce-save").onclick = async () => {
      const fields = { week: openWeek };
      ov.querySelectorAll("[data-k]").forEach(inp => {
        const k = inp.dataset.k;
        if (k === "is_afk") fields[k] = inp.checked;
        else if (inp.type === "number") fields[k] = inp.value === "" ? null : parseInt(inp.value, 10);
        else fields[k] = inp.value;
      });
      const msg = ov.querySelector("#ce-msg");
      if (!(fields.nick || "").trim()) { msg.textContent = "Укажи ник"; return; }
      msg.textContent = "Добавление…";
      try {
        await API.valorMemberAdd(fields);
        ov.hidden = true;
        toast("Добавлено: " + fields.nick);
        await loadWeek(openWeek, activeFolder());
      } catch (e) {
        msg.textContent = e.status === 409
          ? "Такой ник уже есть в этой неделе — правь его строкой ✎"
          : "Ошибка: " + (e.detail || e.message);
      }
    };
  }

  // ── «Готово»: перечитать неделю и подтвердить, что Доблесть актуальна ──
  async function doneRefresh() {
    if (!openWeek) { toast("Сначала выбери неделю"); return; }
    await loadWeek(openWeek, activeFolder());
    toast("Готово — таблица «Доблесть» содержит данные недели " + openWeek);
  }

  // Примерный кадр для строки i: пропорция позиции среди всех строк.
  function scrollToFrame(i, frameIdx) {
    const shots = DATA.screenshots; if (!shots.length) return;
    let targetIdx;
    if (Number.isInteger(frameIdx)) {
      targetIdx = frameIdx;   // точный кадр (idx скрина), где распознан ник
    } else {
      // фолбэк (нет точного кадра): пропорция позиции в списке по доблести
      const fi = Math.min(shots.length - 1,
        Math.round(i / Math.max(1, DATA.members.length - 1) * (shots.length - 1)));
      targetIdx = shots[fi].idx;
    }
    let el = $("cmp-shots").querySelector(`.cmp-shot[data-idx="${targetIdx}"]`);
    // если такого кадра нет в загруженных — берём ближайший существующий
    if (!el && shots.length) {
      const near = shots.reduce((a, b) =>
        Math.abs(b.idx - targetIdx) < Math.abs(a.idx - targetIdx) ? b : a);
      el = $("cmp-shots").querySelector(`.cmp-shot[data-idx="${near.idx}"]`);
    }
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("cmp-shot-on");
      setTimeout(() => el.classList.remove("cmp-shot-on"), 1600);
    }
  }

  // ── Правка строки (админ) ──
  function openEdit(id) {
    const m = DATA.members.find(x => x.id === id); if (!m) return;
    const ov = $("cmp-edit");
    const f = (lbl, key, val, type) =>
      `<label class="ce-f"><span>${lbl}</span>
        <input data-k="${key}" type="${type || "text"}" value="${esc(val == null ? "" : val)}"></label>`;
    ov.innerHTML =
      `<div class="ce-box">
        <div class="ce-h">Правка строки · <b>${esc(m.nick)}</b></div>
        ${f("Ник", "nick", m.nick)}
        ${f("Имя (true_name)", "true_name", m.true_name)}
        ${f("Должность", "rank", m.rank)}
        ${f("Титул", "title", m.title)}
        ${f("Уровень", "level", m.level, "number")}
        ${f("Класс", "class", m.class)}
        ${f("Доблесть", "valor", m.valor, "number")}
        <label class="ce-f ce-chk"><input data-k="is_afk" type="checkbox" ${m.is_afk ? "checked" : ""}> АФК</label>
        <div class="ce-btns">
          <button id="ce-save" class="ce-save">Сохранить</button>
          <button id="ce-cancel" class="ce-cancel">Отмена</button>
        </div>
        <div class="ce-msg" id="ce-msg"></div>
      </div>`;
    ov.hidden = false;
    ov.querySelector("#ce-cancel").onclick = () => { ov.hidden = true; };
    ov.onclick = (e) => { if (e.target === ov) ov.hidden = true; };
    ov.querySelector("#ce-save").onclick = async () => {
      const fields = {};
      ov.querySelectorAll("[data-k]").forEach(inp => {
        const k = inp.dataset.k;
        if (k === "is_afk") fields[k] = inp.checked;
        else if (inp.type === "number") fields[k] = inp.value === "" ? null : parseInt(inp.value, 10);
        else fields[k] = inp.value;
      });
      const msg = ov.querySelector("#ce-msg"); msg.textContent = "Сохранение…";
      try {
        const res = await API.valorMemberEdit(id, fields);
        ov.hidden = true;
        toast("Сохранено: " + (fields.nick || m.nick));
        // Перечитываем данные (бэкенд мог снять флаги сомнений у изменённого
        // поля, переписать ник из реестра и т.п.), но БЕЗ прыжка вверх:
        // сохраняем прокрутку и подсвечиваем отредактированную строку.
        // canon мог мигрировать при смене ника — берём из ответа.
        await reloadKeepScroll((res && res.nick_canon) || m.nick_canon);
      } catch (e) {
        msg.textContent = "Ошибка: " + (e.detail || e.message);
      }
    };
  }

  // ── Папки недель (объединённый «Архив скринов доблести») ──
  try {
    // Все сборы (snapshots = master-список недель) + где есть скрины (кадры).
    const [weeks, sessions] = await Promise.all([
      API.valorScreenshotWeeks().catch(() => []),
      API.valorSessions().catch(() => []),
    ]);
    $("vs-loading").hidden = true;
    const shotsByWeek = {};
    (weeks || []).forEach(w => { shotsByWeek[w.week] = w.count; });
    // Список недель: все снимки (с метаданными); если их нет — fallback на
    // недели со скринами.
    let list = (sessions && sessions.length)
      ? sessions.slice()
      : (weeks || []).map(w => ({ week: w.week, screens_count: w.count }));
    if (!list.length) { $("vs-empty").hidden = false; return; }
    // сводка-журнал (как было в «Архиве доблести»)
    const totalMembers = list.reduce((a, s) => a + (s.members_count || 0), 0);
    $("vs-summary").innerHTML =
      `<span>сборов: <b>${list.length}</b></span>` +
      `<span>всего записей: <b>${totalMembers}</b></span>`;
    $("vs-weeks").innerHTML = list.map(s => {
      const shots = (shotsByWeek[s.week] != null) ? shotsByWeek[s.week] : (s.screens_count || 0);
      const dt = (s.captured_at || "").replace("T", " ").slice(0, 16);
      const meta = [
        `${shots} кадр.`,
        (s.members_count != null) ? `${s.members_count} уч.` : null,
        (s.valor_norm != null) ? `норма ${s.valor_norm}` : null,
      ].filter(Boolean).join(" · ");
      return `<button class="vs-folder" data-week="${esc(s.week)}">
         <span class="vs-folder-ic">📁</span>
         <span class="vs-folder-txt">
           <span class="vs-folder-w">${esc(s.week)}</span>
           <span class="vs-folder-c">${esc(meta)}</span>
           ${dt ? `<span class="vs-folder-d">собрано ${esc(dt)} UTC</span>` : ""}
           ${s.notes ? `<span class="vs-folder-n" title="${esc(s.notes)}">✎ ${esc(s.notes)}</span>` : ""}
         </span>
       </button>`;
    }).join("");
    $("vs-weeks").querySelectorAll(".vs-folder").forEach(el =>
      el.addEventListener("click", () => loadWeek(el.dataset.week, el)));
    $("cmp-filter").addEventListener("input", applyFilter);
    $("cmp-suspect").addEventListener("change", applyFilter);
    // Двойной клик по строке справа → к этому нику в таблице Доблести.
    // Делегируем на стабильный #cmp-rows (его <tbody> пересоздаётся при
    // каждом рендере). Страница доступна только офицеру/админу (гость
    // редиректится в начале файла), отдельный гейт не нужен.
    $("cmp-rows").addEventListener("dblclick", (e) => {
      if (e.target.closest(".cmp-ed") || e.target.closest(".cmp-del") ||
          e.target.closest(".cmp-ok")) return;
      const tr = e.target.closest(".cmp-row");
      if (!tr || !tr.dataset.canon) return;
      location.href = "clan-valor.html?focus=" + encodeURIComponent(tr.dataset.canon);
    });
    if (IS_ADMIN) {
      $("cmp-live").hidden = false;
      $("cmp-admin-actions").hidden = false;
      $("cmp-add").addEventListener("click", openAdd);
      $("cmp-done").addEventListener("click", doneRefresh);
    }
    const first = $("vs-weeks").querySelector(".vs-folder");
    if (first) loadWeek(first.dataset.week, first).then(focusFromUrl);
  } catch (e) {
    $("vs-loading").textContent = "Ошибка загрузки: " + (e.detail || e.message);
  }
})();
