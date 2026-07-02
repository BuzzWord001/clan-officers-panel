// Скрины сбора ↔ распознанные данные: папки по неделям + сравнение скринов с
// тем, как база распознала строки, с правкой (админ) и копированием.
(async function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  let me, IS_ADMIN = false, IS_OFFICER = false;
  try { me = await API.me(); } catch (_) { location.href = "login.html?_=" + Date.now(); return; }
  if (!me || me.role === "guest") { location.href = "clan-valor.html"; return; }
  document.documentElement.classList.remove("booting");   // роль ок — показать (анти-вспышка)
  IS_ADMIN = me.role === "admin";
  IS_OFFICER = (me.role === "officer" || me.role === "admin");  // архив доступен и офицеру
  $("who").textContent = (me.username || me.name || "") +
    (IS_ADMIN ? " · админ" : " · офицер");
  document.body.setAttribute("data-role", me.role || "");
  $("logout-btn").addEventListener("click", async () => {
    try { await API.logout(); } catch (_) {}
    location.href = "login.html?_=" + Date.now();
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
  let CALIB_MODE = false, _calibLastRect = null;   // ручная калибровка строк
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
    const rec = DATA.members.length;            // распознал Gemini
    const real = sn.actual_members;             // реально в клане (ввод офицера)
    // Кикнутые вручную (force_archived): есть в снимке, но в Таблице скрыты.
    // Явно сводим счётчик, иначе «распознано 200 · в Таблице 199» выглядит багом.
    const kicked = DATA.members.filter(m => m.force_archived).length;
    let people;
    if (real != null) {
      const diff = real - rec;
      people = `распознано <b>${rec}</b> из <b>${real}</b> в клане` +
        (diff ? ` <span class="cmp-meta-warn" title="Gemini распознал ${rec}, в клане ${real}">⚠ ${diff > 0 ? "не хватает " + diff : "лишних " + (-diff)}</span>` : " ✓");
    } else {
      people = `распознано <b>${rec}</b>`;
    }
    if (kicked) {
      people += ` · <span class="cmp-meta-warn" title="Эти строки есть в скринах, но вручную скрыты из таблицы Доблести — поэтому в Таблице на ${kicked} меньше. Кнопка ↩ у строки вернёт человека.">кикнут вручную ${kicked} → в Таблице ${rec - kicked}</span>`;
    }
    const editBtn = IS_ADMIN
      ? ` <button class="cmp-people-edit" title="Указать/исправить, сколько реально людей было в клане на этот сбор">✎ людей в клане</button>`
      : "";
    $("cmp-meta").innerHTML = `<b>${esc(WeekFmt.range(week))}</b> <span style="opacity:.6">· ${esc(WeekFmt.num(week))}</span> · норма ${sn.valor_norm ?? "?"} · ` +
      `${people} · ${DATA.screenshots.length} кадров${editBtn}`;
    if (IS_ADMIN) {
      const eb = $("cmp-meta").querySelector(".cmp-people-edit");
      if (eb) eb.addEventListener("click", () => editClanSize(week, real));
    }
    renderShots();
    renderRows();
    // Сохраняем активный фильтр при переключении недель: если включена галочка
    // «только требующие проверки» или задан текст — применяем сразу.
    if ($("cmp-suspect").checked || ($("cmp-filter").value || "").trim()) {
      applyFilter();
    }
  }

  // Правка «реально людей в клане» для недели (админ).
  async function editClanSize(week, current) {
    const v = prompt(`Сколько реально людей было в клане на сбор ${week}?\n` +
      `(Gemini распознал ${ (DATA.members || []).length }. Пусто — не менять.)`,
      current == null ? "" : String(current));
    if (v == null) return;
    const t = v.trim();
    if (t === "") return;
    const n = parseInt(t, 10);
    if (!Number.isFinite(n) || n < 0) { toast("Нужно число"); return; }
    try {
      await API.valorSnapshotMeta({ week, actual_members: n });
      toast("Сохранено: в клане " + n);
      await loadWeek(week, activeFolder());
    } catch (e) { toast("Ошибка: " + (e.detail || e.message)); }
  }

  // ── Левая колонка: скрины ──
  function renderShots() {
    const box = $("cmp-shots");
    // АВТО-СКРЫТИЕ ХВОСТОВЫХ ДУБЛЕЙ: десктоп-тул иногда шлёт лишние кадры в
    // конце (прокрутка упёрлась в низ → тот же кусок таблицы). У них нет ни
    // одного нового участника (idx > последнего кадра с людьми) → это чистые
    // дубли. Прячем их в обычном режиме; в калибровке показываем ВСЕ кадры,
    // чтобы админ мог их размечать/чистить.
    const lastF = lastFrameIdx();
    const shots = (!CALIB_MODE && lastF != null)
      ? DATA.screenshots.filter(s => s.idx <= lastF)
      : DATA.screenshots;
    box.innerHTML = shots.map(s =>
      // data-idx — внутренний 0-based индекс (связка строка↔кадр, scrollToFrame).
      // Пользователю показываем номер с 1 (s.idx + 1).
      `<figure class="cmp-shot" data-idx="${s.idx}">
         <img loading="lazy" src="${esc(s.url)}" alt="кадр ${s.idx + 1}" data-full="${esc(s.url)}">
         <figcaption>кадр #${s.idx + 1}</figcaption>
       </figure>`).join("");
    box.querySelectorAll(".cmp-shot img").forEach(img =>
      img.addEventListener("click", () => { if (!CALIB_MODE) openLightbox(img.dataset.full); }));
    if (CALIB_MODE) renderCalibShots();   // вернуть рамки калибровки после перерисовки
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
    if (m.force_archived) {
      const ai = m.archive_info || {};
      const when = ai.at ? String(ai.at).slice(0, 10) : "";
      const tip = "Строка есть в скринах, но вручную скрыта из таблицы Доблести"
        + (when ? " (" + when + (ai.by ? ", " + ai.by : "") + ")" : "")
        + (ai.reason ? ": " + ai.reason : "") + ". Кнопка ↩ вернёт человека в таблицу.";
      b.push(`<span class="cmp-badge bdg-kick" title="${esc(tip)}">кикнут вручную</span>`);
    }
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
      return `<tr class="cmp-row${warn ? " cmp-row-warn" : ""}${m.force_archived ? " cmp-row-kick" : ""}" data-i="${m._i}" data-canon="${esc(m.nick_canon)}" data-frame="${m.frame == null ? "" : m.frame}">
        <td class="cmp-num">${m._i + 1}</td>
        <td class="cmp-nick"><span class="cmp-nick-t${sf.nick ? " cmp-cell-warn" : ""}" title="${sf.nick ? esc(sf.nick.tip) : "клик — показать кадр слева · двойной клик — к нику в Доблести"}">${esc(m.nick)}</span><br>${badges(m)}${susBadge}${reasonsLine}</td>
        ${cell(m.true_name)}${cell(m.rank)}${cell(m.title)}${cellW(m.level, !!sf.level, sf.level && sf.level.tip)}
        ${cellW(m.class, !!sf.class_, sf.class_ && sf.class_.tip)}<td class="cmp-c cmp-valor${valorWarn ? " cmp-cell-warn" : ""}" title="${valorWarn ? esc(sf.valor.tip) : "клик — копировать"}">${m.valor == null ? "—" : m.valor}</td>
        <td class="cmp-act">${IS_ADMIN
          ? `<span class="cmp-act-ic"><button class="cmp-ed" data-id="${m.id}" title="править">✎</button><button class="cmp-del" data-id="${m.id}" data-nick="${esc(m.nick)}" title="удалить фантом OCR / дубль">🗑</button><button class="cmp-ins" data-id="${m.id}" title="Добавить пропущенный ник НИЖЕ этой строки — встанет ровно между ней и следующей">➕</button></span>`
          : ""}${IS_OFFICER
          ? (m.force_archived
             ? `<button class="cmp-unarch" data-id="${m.id}" data-canon="${esc(m.nick_canon)}" data-nick="${esc(m.nick)}" title="Вернуть игрока в таблицу Доблести (снять ручной кик). Сейчас он есть в скринах, но скрыт из Таблицы.">↩ вернуть</button>`
             : `<button class="cmp-arch" data-id="${m.id}" data-canon="${esc(m.nick_canon)}" data-nick="${esc(m.nick)}" title="Кикнуть в архив — убрать игрока в «Покинули клан», даже если он ещё есть в снимке. Вернуть можно кнопкой «↩ Из архива» сверху.">🚪 в архив</button>`)
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
    tbody.querySelectorAll(".cmp-row-on").forEach(x => x.classList.remove("cmp-row-on"));
    tr.classList.add("cmp-row-on");
    const m = DATA.members[+tr.dataset.i];
    pinMember(m);                       // клик = зафиксировать (для навигации ↑/↓)
    if (rowBand(m)) showRowZoom(m, true, tr);
    else { hideZoom(); scrollToFrame(+tr.dataset.i, null); }   // нет кадра → старое поведение
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
            e.target.closest(".cmp-arch") || e.target.closest(".cmp-unarch") ||
            e.target.closest(".cmp-ok") || e.target.closest(".cmp-c") ||
            e.target.closest(".cmp-nick-t")) return;
        selectRow(tr);
      });
      // Наведение на строку = лупа НАД этой строкой (без принудительной прокрутки).
      tr.addEventListener("mouseenter", () => {
        const m = DATA.members[+tr.dataset.i];
        if (rowBand(m)) showRowZoom(m, false, tr); else hideZoom();
      });
    });
    // Ушли из таблицы строк — лупа скрывается (показываем только при наведении).
    tbody.addEventListener("mouseleave", () => hideZoom());
    if (IS_ADMIN) {
      tbody.querySelectorAll(".cmp-ed").forEach(b =>
        b.addEventListener("click", () => openEdit(+b.dataset.id)));
      tbody.querySelectorAll(".cmp-del").forEach(b =>
        b.addEventListener("click", () => delMember(+b.dataset.id, b.dataset.nick)));
      tbody.querySelectorAll(".cmp-ok").forEach(b =>
        b.addEventListener("click", (e) => { e.stopPropagation(); verifyMember(+b.dataset.id); }));
      tbody.querySelectorAll(".cmp-ins").forEach(b =>
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          openAdd(DATA.members.find(x => x.id === +b.dataset.id) || null);
        }));
    }
    if (IS_OFFICER) {
      tbody.querySelectorAll(".cmp-arch").forEach(b =>
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          archiveMember(b.dataset.canon, b.dataset.nick);
        }));
      tbody.querySelectorAll(".cmp-unarch").forEach(b =>
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          unarchiveMember(b.dataset.canon, b.dataset.nick);
        }));
    }
  }

  // ── Кикнуть в архив (офицер/админ) ──
  async function archiveMember(canon, nick) {
    const reason = prompt(`Кикнуть «${nick}» в архив доблести?\nПометка (причина, необязательно):`, "");
    if (reason === null) return;
    try {
      await API.valorArchive(canon, reason);
      toast("Кикнут в архив: " + nick);
      await reloadKeepScroll();
    } catch (e) { toast("Ошибка: " + (e.detail || e.message)); }
  }

  // ── Вернуть из архива прямо со строки скринов (кикнут вручную) ──
  async function unarchiveMember(canon, nick) {
    if (!confirm(`Вернуть «${nick}» в таблицу Доблести? Он есть в скринах, но сейчас скрыт из Таблицы.`)) return;
    try {
      await API.valorRestore(canon, "");
      toast("Возвращён в таблицу: " + nick);
      await reloadKeepScroll();
    } catch (e) { toast("Ошибка: " + (e.detail || e.message)); }
  }

  // ── Вернуть из архива (офицер/админ): список ушедших + восстановление ──
  async function openRestore() {
    const ov = $("cmp-edit");
    ov.innerHTML = `<div class="ce-box"><div class="ce-h">Загрузка архива…</div></div>`;
    ov.hidden = false;
    ov.onclick = (e) => { if (e.target === ov) ov.hidden = true; };
    let dep = [];
    try { dep = await API.valorDeparted(); } catch (_) {}
    const rows = (dep || []).map(d => `
      <tr>
        <td><b>${esc(d.nick)}</b></td>
        <td>${esc(WeekFmt.range(d.last_week))}</td>
        <td class="ce-note">${d.archive_reason ? esc(d.archive_reason) + (d.archive_by ? " · " + esc(d.archive_by) : "") : "—"}</td>
        <td><button class="ce-restore" data-canon="${esc(d.nick_canon)}" data-nick="${esc(d.nick)}">↩ вернуть</button></td>
      </tr>`).join("");
    ov.innerHTML = `<div class="ce-box ce-box-wide">
      <div class="ce-h">Архив доблести — «Покинули клан» (${(dep || []).length})</div>
      ${rows ? `<table class="ce-dep-table"><thead><tr><th>Ник</th><th>Последняя неделя</th><th>Пометка</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
             : `<p class="ce-msg">Архив пуст.</p>`}
      <div class="ce-btns"><button id="ce-close" class="ce-cancel">Закрыть</button></div>
    </div>`;
    ov.querySelector("#ce-close").onclick = () => { ov.hidden = true; };
    ov.querySelectorAll(".ce-restore").forEach(b =>
      b.addEventListener("click", async () => {
        const reason = prompt(`Вернуть «${b.dataset.nick}» из архива в основной список?\nПометка (причина возврата, необязательно):`, "");
        if (reason === null) return;
        try {
          await API.valorRestore(b.dataset.canon, reason);
          toast("Возвращён: " + b.dataset.nick);
          b.closest("tr").remove();
          if (openWeek) await reloadKeepScroll();
        } catch (e) { toast("Ошибка: " + (e.detail || e.message)); }
      }));
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
  // afterMember — если открыли кнопкой ➕ на строке: вставить сразу ПОСЛЕ неё.
  function openAdd(afterMember) {
    if (!openWeek) { toast("Сначала выбери неделю"); return; }
    const ov = $("cmp-edit");
    const f = (lbl, key, val, type) =>
      `<label class="ce-f"><span>${lbl}</span>
        <input data-k="${key}" type="${type || "text"}" value="${esc(val == null ? "" : val)}"></label>`;
    // Селектор позиции: «в конец» + «после каждого ника». По умолчанию —
    // строка, на которой нажали ➕ (иначе конец списка).
    const afterId = afterMember ? afterMember.id : "";
    const posOpts = [`<option value="">— в конец списка —</option>`]
      .concat((DATA.members || []).map((mm, i) =>
        `<option value="${mm.id}"${mm.id === afterId ? " selected" : ""}>${i + 1}. после «${esc(mm.nick)}»${mm.frame != null ? ` · кадр #${mm.frame + 1}` : ""}</option>`))
      .join("");
    ov.innerHTML =
      `<div class="ce-box">
        <div class="ce-h">Добавить пропущенный ник · неделя <b>${esc(openWeek)}</b></div>
        <label class="ce-f"><span>Куда вставить</span>
          <select data-k="after_id" id="ce-after">${posOpts}</select></label>
        <div class="ce-msg" id="ce-pos-hint"></div>
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
    // Живая подсказка: между какими двумя никами встанет строка.
    const sel = ov.querySelector("#ce-after");
    const hint = ov.querySelector("#ce-pos-hint");
    const updHint = () => {
      const v = sel.value;
      if (!v) { hint.textContent = "Строка встанет в КОНЕЦ списка."; return; }
      const idx = (DATA.members || []).findIndex(mm => mm.id === +v);
      const a = DATA.members[idx], b = DATA.members[idx + 1];
      hint.textContent = b
        ? `Встанет между «${a.nick}» и «${b.nick}»` + (a.frame != null ? ` · кадр #${a.frame + 1}` : "")
        : `Встанет сразу после «${a.nick}» (последним)` + (a.frame != null ? ` · кадр #${a.frame + 1}` : "");
    };
    sel.addEventListener("change", updHint);
    updHint();
    ov.querySelector("#ce-save").onclick = async () => {
      const fields = { week: openWeek };
      ov.querySelectorAll("[data-k]").forEach(inp => {
        const k = inp.dataset.k;
        if (k === "is_afk") fields[k] = inp.checked;
        else if (k === "after_id") fields[k] = inp.value ? parseInt(inp.value, 10) : null;
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
        const c = e.status === 409 && e.detail && e.detail.conflict;
        if (c && c.via_alias) {
          // Ник авто-связан (алиасом) с ДРУГИМ игроком (напр. Нефеса↔Небеса).
          // Предлагаем разорвать связь и добавить как отдельного игрока.
          const frameTxt = c.frame != null ? ` · кадр #${c.frame + 1}` : "";
          msg.innerHTML =
            `Ник «${esc(fields.nick)}» авто-связан с игроком «${esc(c.nick)}» ` +
            `(доблесть ${c.valor == null ? "—" : c.valor} · ур ${c.level == null ? "—" : c.level}${frameTxt}) — считается тем же.<br>` +
            `Если это <b>другой</b> игрок — разорви связь и добавь отдельно:` +
            `<div style="margin-top:7px"><button type="button" id="ce-breakalias" class="ce-save">🔗✂ Разорвать связь и добавить</button></div>`;
          const bb = ov.querySelector("#ce-breakalias");
          if (bb) bb.onclick = async () => {
            bb.disabled = true; bb.textContent = "Добавляю…";
            try {
              await API.valorMemberAdd({ ...fields, break_alias: true });
              ov.hidden = true;
              toast("Добавлено отдельно: " + fields.nick);
              await loadWeek(openWeek, activeFolder());
            } catch (e2) { msg.textContent = "Ошибка: " + (e2.detail || e2.message); }
          };
        } else if (c) {
          // Прямой дубль по нику — предлагаем исправить ту строку (✎).
          const frameTxt = c.frame != null ? ` · кадр #${c.frame + 1}` : "";
          msg.innerHTML =
            `Ник «${esc(c.nick)}» уже есть в этой неделе: ` +
            `доблесть ${c.valor == null ? "—" : c.valor} · ур ${c.level == null ? "—" : c.level}${frameTxt}.<br>` +
            `Если это <b>другой</b> игрок (ошибка распознавания) — исправь ту строку, потом добавь этого.` +
            `<div style="margin-top:7px"><button type="button" id="ce-fixconflict" class="ce-save">✎ Исправить строку «${esc(c.nick)}»</button></div>`;
          const fb = ov.querySelector("#ce-fixconflict");
          if (fb) fb.onclick = () => openEdit(c.id);
        } else if (e.status === 409) {
          msg.textContent = "Такой ник уже есть в этой неделе — правь его строкой ✎";
        } else {
          msg.textContent = "Ошибка: " + (e.detail || e.message);
        }
      }
    };
  }

  // ── «Готово»: перечитать неделю и подтвердить, что Доблесть актуальна ──
  async function doneRefresh() {
    if (!openWeek) { toast("Сначала выбери неделю"); return; }
    await loadWeek(openWeek, activeFolder());
    toast("Готово — таблица «Доблесть» содержит данные недели " + openWeek);
  }

  // ── ШАГ 1 авто-проверки: снять ложные флаги «ИИ-ник» у известных игроков ──
  async function autoVerify() {
    if (!openWeek) { toast("Сначала выбери неделю"); return; }
    const btn = $("cmp-autoverify");
    if (btn) { btn.disabled = true; btn.textContent = "🔍 проверяю…"; }
    try {
      const r = await API.valorAutoVerify(openWeek);
      const left = (r.remaining || []).length;
      const dd = r.deduped ? ` · удалено дублей ${r.deduped}` : "";
      toast(`Авто-проверка: снято флагов ${r.cleared}/${r.checked}${dd}` +
            (left ? ` · осталось ${left}` : " · больше нечего"));
      await loadWeek(openWeek, activeFolder());
    } catch (e) { toast("Ошибка: " + (e.detail || e.message)); }
    if (btn) { btn.disabled = false; btn.textContent = "🔍 Авто-проверка"; }
  }

  // ── Журнал правок недели (только админ): просмотр + отмена ──
  const ELOG_ACT = { edit: "Правка", add: "Добавление", delete: "Удаление",
                     verify: "Снято сомнение", meta: "Правка снимка" };
  const ELOG_FIELDS = { nick: "ник", true_name: "имя", rank: "должн.",
                        title: "титул", level: "ур.", class_: "класс",
                        valor: "добл.", is_afk: "АФК" };
  const elv = (v) => (v == null || v === "") ? "—" : String(v);

  function elogSummary(it) {
    const b = it.before || {}, a = it.after || {};
    if (it.action === "add") return "добавлена строка";
    if (it.action === "delete") return "удалена строка";
    if (it.action === "verify") return "снято сомнение (ИИ-ник / класс)";
    if (it.action === "meta") {
      const p = [];
      if (a.actual_members !== b.actual_members) p.push(`людей в клане: ${elv(b.actual_members)} → ${elv(a.actual_members)}`);
      if (a.valor_norm !== b.valor_norm) p.push(`норматив: ${elv(b.valor_norm)} → ${elv(a.valor_norm)}`);
      if ((a.notes || "") !== (b.notes || "")) p.push("заметка изменена");
      return p.join("; ") || "правка снимка";
    }
    const p = [];
    for (const k in ELOG_FIELDS) {
      if (k in a && a[k] !== b[k]) p.push(`${ELOG_FIELDS[k]}: ${elv(b[k])} → ${elv(a[k])}`);
    }
    return p.join("; ") || "правка";
  }

  async function openEditLog(week) {
    if (!week) { toast("Сначала выбери неделю"); return; }
    let data;
    try { data = await API.valorEditLog(week); }
    catch (e) { toast("Ошибка: " + (e.detail || e.message)); return; }
    renderEditLog(week, data);
  }

  function renderEditLog(week, data) {
    const items = (data && data.items) || [];
    const actors = (data && data.actors) || [];
    const fmtDT = (s) => s ? String(s).replace("T", " ").slice(0, 16) : "—";
    const rows = items.length ? items.map(it => `
      <tr class="${it.undone ? "el-undone" : ""}">
        <td>${esc(ELOG_ACT[it.action] || it.action)}</td>
        <td>${esc(it.nick || "")}</td>
        <td class="el-sum">${esc(elogSummary(it))}</td>
        <td>${esc(it.actor_name || "—")}</td>
        <td class="el-dt">${fmtDT(it.created_at)}</td>
        <td>${it.undone
          ? `<span class="el-done">отменено</span>`
          : `<button class="el-undo" data-id="${it.id}">отменить</button>`}</td>
      </tr>`).join("") : `<tr><td colspan="6" class="el-empty">Правок за эту неделю нет</td></tr>`;
    const actorOpts = actors.map(a =>
      `<option value="${esc(a.actor_name)}">${esc(a.actor_name)} (${a.count})</option>`).join("");
    const ov = $("cmp-edit");
    ov.innerHTML =
      `<div class="ce-box el-box">
        <div class="ce-h">🧾 Журнал правок · неделя <b>${esc(week)}</b></div>
        ${actors.length ? `<div class="el-bar">
          <span>Отменить все правки человека:</span>
          <select id="el-actor">${actorOpts}</select>
          <button id="el-undo-actor" class="cmp-del">↩ Отменить всё</button>
        </div>` : ""}
        <div class="el-scroll">
          <table class="el-table">
            <thead><tr><th>Действие</th><th>Ник</th><th>Что изменено</th><th>Кто</th><th>Когда (UTC)</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <div class="ce-btns"><button id="el-close" class="ce-cancel">Закрыть</button></div>
      </div>`;
    ov.hidden = false;
    ov.onclick = (e) => { if (e.target === ov) ov.hidden = true; };
    ov.querySelector("#el-close").onclick = () => { ov.hidden = true; };
    ov.querySelectorAll(".el-undo").forEach(b => b.addEventListener("click", async () => {
      try {
        await API.valorEditUndo(+b.dataset.id);
        toast("Действие отменено");
        await reloadKeepScroll();
        openEditLog(week);   // обновить окно журнала
      } catch (e) { toast("Ошибка: " + (e.detail || e.message)); }
    }));
    const ua = ov.querySelector("#el-undo-actor");
    if (ua) ua.addEventListener("click", async () => {
      const who = ov.querySelector("#el-actor").value;
      if (!confirm(`Отменить ВСЕ правки «${who}» за неделю ${week}?`)) return;
      try {
        const r = await API.valorEditUndoActor(week, who);
        toast(`Отменено действий: ${r.undone || 0}`);
        await reloadKeepScroll();
        openEditLog(week);
      } catch (e) { toast("Ошибка: " + (e.detail || e.message)); }
    });
  }

  // Находит DOM-элемент кадра по его idx (или ближайший загруженный).
  function findShot(frameIdx, i) {
    const shots = DATA.screenshots; if (!shots.length) return null;
    let targetIdx;
    if (Number.isInteger(frameIdx)) {
      targetIdx = frameIdx;   // точный кадр (idx скрина), где распознан ник
    } else {
      // фолбэк (нет точного кадра): пропорция позиции в списке по доблести
      const fi = Math.min(shots.length - 1,
        Math.round((i || 0) / Math.max(1, DATA.members.length - 1) * (shots.length - 1)));
      targetIdx = shots[fi].idx;
    }
    let el = $("cmp-shots").querySelector(`.cmp-shot[data-idx="${targetIdx}"]`);
    if (!el) {
      const near = shots.reduce((a, b) =>
        Math.abs(b.idx - targetIdx) < Math.abs(a.idx - targetIdx) ? b : a);
      el = $("cmp-shots").querySelector(`.cmp-shot[data-idx="${near.idx}"]`);
    }
    return el;
  }

  function scrollToFrame(i, frameIdx) {
    const el = findShot(frameIdx, i);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("cmp-shot-on");
      setTimeout(() => el.classList.remove("cmp-shot-on"), 1600);
    }
  }

  // ── Зум строки: рамка на кадре + лупа (увеличенный кроп именно этой строки) ──
  //
  // Геометрия строки — ЕДИНАЯ модель {frame, x, y, w, h} в долях кадра (0..1).
  //   Фаза 2 (точно): m.bbox из десктоп-калибровки (пока трекер их не шлёт).
  //   Ручная калибровка: прямоугольник области строк кадра + ФИКС. высота
  //     строки rh (доля кадра). Строки стоят сеткой y = top + idx*rh, высота
  //     rh — ОДИНАКОВО на всех кадрах (rh от кадра, на котором калибровали).
  //     Старые записи без rh → откат к делению области /n (для совместимости).
  //   Фаза 1 (грубо): нет калибровки → делим ВСЮ высоту кадра по числу строк.
  // Высота строки сетки (доля кадра) = высота области / число строк сетки.
  // Берётся из gridRows (там же защита от мусора/отсутствия номеров кадров).
  function calibRowH(c) {
    return c.h / gridRows(c);
  }
  // Первый кадр сбора (мин. номер): у него смещения нет; у остальных кадров
  // строки начинаются НИЖЕ на «перекрытие» (частичная прокрутка между скринами).
  function firstFrameIdx() {
    let f = null;
    (DATA.members || []).forEach(m => {
      if (m.frame != null && (f === null || m.frame < f)) f = m.frame;
    });
    return f;
  }
  function lastFrameIdx() {
    let f = null;
    (DATA.members || []).forEach(m => {
      if (m.frame != null && (f === null || m.frame > f)) f = m.frame;
    });
    return f;
  }
  function frameCount(f) {
    return (DATA.members || []).filter(m => m.frame === f).length;
  }
  // Авто-перекрытие (строк) = видимых строк (1-й кадр) − шаг прокрутки (2-й кадр).
  // Полная прокрутка → 0; частичная → сколько строк дублируется между кадрами.
  function autoOverlap() {
    const ff = firstFrameIdx();
    if (ff === null) return 0;
    let second = null;
    (DATA.members || []).forEach(m => {
      if (m.frame != null && m.frame > ff && (second === null || m.frame < second)) second = m.frame;
    });
    if (second === null) return 0;
    return Math.max(0, frameCount(ff) - frameCount(second));
  }
  function weekOverlap(frame) {
    // 1) Ручной пофреймовый off (админ задал явно) — высший приоритет.
    const fr = (frame != null && DATA.calib && DATA.calib.frames)
               ? DATA.calib.frames[frame] : null;
    if (fr && fr.off != null) return fr.off;
    const d = DATA.calib && DATA.calib.default;
    // 2) АВТО-ФИКС ХВОСТА: у ПОСЛЕДНЕГО кадра прокрутка упирается в низ, шаг
    //    меньше обычного → перекрытие = видимых строк − новых в кадре. Считаем
    //    автоматически для любой недели. Середину НЕ трогаем (там глобальный off
    //    верен; авто по всем кадрам ловил бы OCR-пропуски как ложный сдвиг).
    if (frame != null && d && frame === lastFrameIdx()
        && frame !== firstFrameIdx()) {
      const nnew = frameCount(frame);
      const gr = gridRows(d);
      if (nnew > 0 && gr > 0) return Math.max(0, gr - nnew);
    }
    // 3) Общий off / авто-оценка по первым двум кадрам.
    return (d && d.off != null) ? d.off : autoOverlap();
  }
  // Номер видимого ряда игрока в его кадре: idx + перекрытие (для НЕ первого кадра).
  function memberRow(m, idx) {
    return (m.frame === firstFrameIdx() ? 0 : weekOverlap(m.frame)) + idx;
  }
  function rowBand(m) {
    if (m && m.bbox && m.bbox.frame != null) return m.bbox;   // Фаза 2 (десктоп)
    if (!m || m.frame == null) return null;
    const same = DATA.members.filter(x => x.frame === m.frame);
    const idx = Math.max(0, same.indexOf(m));
    const n = Math.max(1, same.length);
    const c = (DATA.calib && DATA.calib.default) || null;     // единая сетка-регион
    if (c) { const rh = calibRowH(c);
             return { frame: m.frame, x: c.x, w: c.w,
                      y: c.y + memberRow(m, idx) * rh, h: rh }; }
    return { frame: m.frame, x: 0, w: 1, y: idx / n, h: 1 / n };  // Фаза 1
  }

  function _loupe() {
    let l = $("cmp-loupe");
    if (!l) {
      l = document.createElement("div");
      l.className = "cmp-loupe"; l.id = "cmp-loupe"; l.hidden = true;
      l.innerHTML = `<img alt=""><div class="cmp-loupe-cap"></div>`;
      document.body.appendChild(l);
    }
    return l;
  }
  function hideZoom() {
    const l = $("cmp-loupe"); if (l) l.hidden = true;
    document.querySelectorAll(".cmp-rowband").forEach(x => x.remove());
  }
  function showRowZoom(m, scroll, anchorEl) {
    const band = rowBand(m);
    const shot = band ? findShot(band.frame) : null;
    if (!band || !shot) { hideZoom(); return; }
    if (scroll) shot.scrollIntoView({ behavior: "smooth", block: "nearest" });
    const img = shot.querySelector("img");
    if (!img) return;
    // Рамка строки на кадре.
    document.querySelectorAll(".cmp-rowband").forEach(x => { if (x.parentNode !== shot) x.remove(); });
    let ov = shot.querySelector(".cmp-rowband");
    if (!ov) { ov = document.createElement("div"); ov.className = "cmp-rowband"; shot.appendChild(ov); }
    // Позиционируем рамку В ПИКСЕЛЯХ относительно изображения (а не figure с
    // подписью), чтобы она совпадала с лупой и калибровкой.
    const _iw = img.clientWidth, _ih = img.clientHeight;
    if (_iw && _ih) {
      const ox = img.offsetLeft, oy = img.offsetTop;
      ov.style.left = (ox + band.x * _iw) + "px"; ov.style.width = (band.w * _iw) + "px";
      ov.style.top = (oy + band.y * _ih) + "px"; ov.style.height = (band.h * _ih) + "px";
    } else {
      ov.style.left = (band.x * 100) + "%"; ov.style.width = (band.w * 100) + "%";
      ov.style.top = (band.y * 100) + "%";  ov.style.height = (band.h * 100) + "%";
    }
    // Лупа — увеличенный кроп ИМЕННО этой строки, появляется НАД наведённой
    // строкой справа (anchorEl). Без наведения — скрыта (hideZoom).
    const l = _loupe(), li = l.querySelector("img");
    const paint = () => {
      const dw = img.clientWidth, dh = img.clientHeight;
      if (!dw) { img.addEventListener("load", paint, { once: true }); return; }
      l.hidden = false;
      // Лупа = РОВНО откалиброванная строка: вписываем ширину полосы в ширину
      // лупы, ВЫСОТА лупы = высоте строки (без соседних). Ширина лупы = ширине
      // наведённой строки справа (не шире её), чтобы зум был ровно над строкой.
      let LW = Math.min(900, Math.round(window.innerWidth * 0.94));
      if (anchorEl) {
        const aw = Math.round(anchorEl.getBoundingClientRect().width);
        const rowsW = $("cmp-rows") ? $("cmp-rows").clientWidth : aw;
        if (aw > 50) LW = Math.min(aw, rowsW || aw, LW);
      }
      l.style.width = LW + "px";
      const Z = Math.max(1.5, Math.min(8, LW / Math.max(1, band.w * dw)));
      const rowPx = Math.max(20, band.h * dh * Z);   // высота строки в зуме
      const capH = 13;                                // тонкая шапка под номер кадра
      const LH = Math.round(rowPx) + capH + 4;
      l.style.height = LH + "px";
      li.src = img.src; li.style.width = (dw * Z) + "px";
      const cx = (band.x + band.w / 2) * dw * Z, cy = (band.y + band.h / 2) * dh * Z;
      const targetCy = capH + rowPx / 2 + 2;          // строка ПОД шапкой
      li.style.transform = `translate(${LW / 2 - cx}px, ${targetCy - cy}px)`;
      l.querySelector(".cmp-loupe-cap").textContent = "кадр #" + (band.frame + 1);
      if (anchorEl) positionLoupe(l, anchorEl);
    };
    paint();
  }
  // Поставить лупу прямо НАД наведённой строкой (если не влезает сверху — под ней).
  function positionLoupe(l, anchorEl) {
    const lw = l.offsetWidth || 600, lh = l.offsetHeight || 110;
    const r = anchorEl.getBoundingClientRect();
    let left = r.left + r.width / 2 - lw / 2;
    left = Math.max(6, Math.min(window.innerWidth - lw - 6, left));
    let top = r.top - lh - 10;
    if (top < 6) top = r.bottom + 10;
    l.style.left = left + "px";
    l.style.top = top + "px";
  }

  // ── Ручная калибровка раскладки строк (админ) ───────────────────────────
  // Список на всех кадрах недели — в ОДНОМ месте экрана (окно игры не двигается),
  // поэтому калибруем ОДНУ сетку-регион {x,y,w,h} + число видимых строк (→ высота
  // строки rh). Между кадрами список прокручен на фикс. ШАГ, обычно меньше экрана,
  // → строки нового кадра начинаются ниже на «перекрытие» off строк (DiosEos после
  // Лисси! не вверху 2-го кадра, а на off строк ниже). Сетка живая; рамку тянем
  // за края; число строк и перекрытие настраиваются.
  function calibFrameMembers(frameIdx) {
    return (DATA.members || []).filter(m => m.frame === frameIdx);
  }
  function clearCalibOverlays() {
    document.querySelectorAll(".calib-rect, .calib-rowline, .calib-hint, .calib-memrow, .calib-colline, .calib-collabel").forEach(x => x.remove());
  }
  function imgMetrics(img) {
    return { ox: img.offsetLeft, oy: img.offsetTop,
             iw: img.clientWidth, ih: img.clientHeight };
  }
  // Текущая сетка-регион (общая для всех кадров).
  function calibRect() { return (DATA.calib && DATA.calib.default) || null; }
  // ── Вертикальная разметка колонок (поля игрока на скрине) ──
  const CALIB_COL_DEFS = [
    { key: "nick", label: "Ник" }, { key: "level", label: "Ур." },
    { key: "class", label: "Класс" }, { key: "rank", label: "Должн." },
    { key: "title", label: "Титул" }, { key: "valor", label: "Добл." },
    { key: "other", label: "проч." },
  ];
  function colLabel(key) { const d = CALIB_COL_DEFS.find(c => c.key === key); return d ? d.label : key; }
  function calibCols() { const c = calibRect(); return (c && c.cols) || []; }
  async function saveCols() {
    const c = calibRect(); if (!c) return;
    c.cols = (c.cols || []).slice().sort((a, b) => a.x - b.x);
    renderCalibShots();
    try { await API.valorCalibSet(openWeek, -1, c); }
    catch (e) { toast("Ошибка: " + (e.detail || e.message)); }
  }
  function addCol() {
    const c = calibRect();
    if (!c) { toast("Сначала обведи область строк"); return; }
    if (!c.cols) c.cols = [];
    const used = new Set(c.cols.map(k => k.key));
    const nextKey = (CALIB_COL_DEFS.find(d => !used.has(d.key)) || CALIB_COL_DEFS[0]).key;
    const lastX = c.cols.length ? Math.max(...c.cols.map(k => k.x)) : c.x;
    const nx = Math.min(c.x + c.w - 0.02, c.cols.length ? lastX + 0.08 : c.x + 0.02);
    c.cols.push({ x: nx, key: nextKey });
    saveCols();
  }
  function cycleCol(i) {
    const c = calibRect(); if (!c || !c.cols[i]) return;
    const cur = c.cols[i].key;
    const idx = CALIB_COL_DEFS.findIndex(d => d.key === cur);
    c.cols[i].key = CALIB_COL_DEFS[(idx + 1) % CALIB_COL_DEFS.length].key;
    saveCols();
  }
  function removeCol(i) {
    const c = calibRect(); if (!c || !c.cols) return;
    c.cols.splice(i, 1);
    saveCols();
  }
  function clearCols() {
    const c = calibRect(); if (!c) return;
    c.cols = []; saveCols(); toast("Колонки сброшены");
  }
  // Авто-разметка сетки строк+колонок по скрину (без AI, на сервере).
  async function autoCalib() {
    if (!openWeek) { toast("Сначала выбери неделю"); return; }
    const btn = $("calib-auto"); if (btn) { btn.disabled = true; btn.textContent = "✨ ищу…"; }
    let res;
    try { res = await API.valorCalibAuto(openWeek); }
    catch (e) {
      toast(e.status === 422 ? "Не удалось распознать сетку — размечай вручную"
            : "Ошибка авто-разметки: " + (e.detail || e.message));
      if (btn) { btn.disabled = false; btn.textContent = "✨ авто"; }
      return;
    }
    const a = res.calib || {};
    if (!DATA.calib) DATA.calib = { default: null, frames: {} };
    const prev = DATA.calib.default;
    const off = (prev && prev.off != null) ? prev.off : autoOverlap();
    DATA.calib.default = { x: a.x, y: a.y, w: a.w, h: a.h, rh: a.rh, off,
                           cols: a.cols || [] };
    _calibLastRect = DATA.calib.default;
    renderCalibShots(); updateOffLabel();
    try {
      await API.valorCalibSet(openWeek, -1, DATA.calib.default);
      const meta = a._meta || {};
      toast(`Авто-разметка: ${meta.rows || "?"} строк, ${(a.cols || []).length} колонок — проверь и поправь`);
    } catch (e) { toast("Ошибка сохранения: " + (e.detail || e.message)); }
    if (btn) { btn.disabled = false; btn.textContent = "✨ авто"; }
  }
  function startColDrag(e, shot, idx, colIdx) {
    if (!CALIB_MODE) return;
    e.preventDefault(); e.stopPropagation();
    const img = shot.querySelector("img"); if (!img) return;
    const r = img.getBoundingClientRect(); if (!r.width) return;
    const c = calibRect(); if (!c || !c.cols[colIdx]) return;
    const cl = (v, lo, hi) => (v < lo ? lo : (v > hi ? hi : v));
    function move(ev) {
      c.cols[colIdx].x = cl((ev.clientX - r.left) / r.width, c.x, c.x + c.w);
      renderCalibShots();
    }
    function up() {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      c.cols.sort((a, b) => a.x - b.x);
      saveCols();
    }
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  }
  // Число видимых строк сетки (= строк на экране в игре). Защита от вырождения:
  //  • нет номеров кадров вообще (frame=null у всех) → авто-rh посчитан от ВСЕХ
  //    игроков (мусор, сотни «строк» → сетка как вертикальная штриховка) →
  //    разумный дефолт 12 (калибровка строк без кадров всё равно бессмысленна,
  //    нужен бэкфилл кадров);
  //  • абсурдно большое число → откат к числу строк первого кадра.
  const GRID_MAX = 60;
  function gridRows(c) {
    if (firstFrameIdx() === null) return 12;
    let r = (c && c.rh && c.rh > 0) ? Math.round(c.h / c.rh) : frameCount(firstFrameIdx());
    if (!(r >= 1) || r > GRID_MAX) r = frameCount(firstFrameIdx());
    if (!(r >= 1) || r > GRID_MAX) r = 12;
    return Math.max(1, r);
  }
  // Нарисовать на кадре сетку (+ при full — рамку с ручками и предсказанные
  // строки игроков с никами, чтобы сверить попадание).
  function paintGrid(shot, idx, rect, full) {
    shot.querySelectorAll(".calib-rect, .calib-rowline, .calib-hint, .calib-memrow, .calib-colline, .calib-collabel").forEach(x => x.remove());
    const img = shot.querySelector("img"); if (!img) return;
    const { ox, oy, iw, ih } = imgMetrics(img);
    if (!iw || !ih) { img.addEventListener("load", () => drawCalibForShot(shot, idx), { once: true }); return; }
    const members = calibFrameMembers(idx);
    const px = (fx, fy) => ({ left: ox + fx * iw, top: oy + fy * ih });
    const hint = document.createElement("div");
    hint.className = "calib-hint";
    const gr = rect ? gridRows(rect) : 0;
    hint.textContent = (members.length ? members.length + " строк" : "нет строк")
      + (rect ? " · сетка " + gr + (idx === firstFrameIdx() ? "" : " · сдвиг " + weekOverlap()) : "");
    shot.appendChild(hint);
    if (!rect) return;
    const rh = rect.h / gr;
    const box = document.createElement("div");
    box.className = "calib-rect" + (full ? " calib-rect-edit" : "");
    const p0 = px(rect.x, rect.y);
    box.style.left = p0.left + "px"; box.style.top = p0.top + "px";
    box.style.width = (rect.w * iw) + "px"; box.style.height = (rect.h * ih) + "px";
    shot.appendChild(box);
    for (let i = 1; i < gr; i++) {
      const ln = document.createElement("div");
      ln.className = "calib-rowline";
      const p = px(rect.x, rect.y + i * rh);
      ln.style.left = p.left + "px"; ln.style.width = (rect.w * iw) + "px"; ln.style.top = p.top + "px";
      shot.appendChild(ln);
    }
    if (!full) return;
    ["n", "s", "e", "w"].forEach(side => {
      const h = document.createElement("div");
      h.className = "calib-h calib-h-" + side;
      h.addEventListener("pointerdown", (e) => startCalibDrag(e, shot, idx, side));
      box.appendChild(h);
    });
    const grip = document.createElement("div");
    grip.className = "calib-grip"; grip.title = "перетащить рамку"; grip.textContent = "✥";
    grip.addEventListener("pointerdown", (e) => startCalibDrag(e, shot, idx, "move"));
    box.appendChild(grip);
    // предсказанные строки игроков этого кадра (зелёным, с ником) — для сверки
    members.forEach((m, i2) => {
      const row = memberRow(m, i2);
      const top = rect.y + row * rh;
      if (top >= 1) return;
      const mr = document.createElement("div");
      mr.className = "calib-memrow";
      const p = px(rect.x, top);
      mr.style.left = p.left + "px"; mr.style.width = (rect.w * iw) + "px";
      mr.style.top = p.top + "px"; mr.style.height = (rh * ih) + "px";
      mr.innerHTML = `<span>${esc(m.nick || "")}</span>`;
      shot.appendChild(mr);
    });
    // ── Вертикальная разметка колонок: линии + метки полей (перетаскиваемые) ──
    const cols = rect.cols || [];
    cols.forEach((col, ci) => {
      const p = px(col.x, rect.y);
      const line = document.createElement("div");
      line.className = "calib-colline";
      line.style.left = p.left + "px"; line.style.top = p.top + "px";
      line.style.height = (rect.h * ih) + "px";
      line.addEventListener("pointerdown", (e) => startColDrag(e, shot, idx, ci));
      shot.appendChild(line);
      const lab = document.createElement("div");
      lab.className = "calib-collabel";
      lab.style.left = p.left + "px"; lab.style.top = (oy + rect.y * ih - 17) + "px";
      lab.innerHTML = `<span class="cl-key" title="клик — сменить поле">${esc(colLabel(col.key))}</span>` +
                      `<span class="cl-x" title="убрать колонку">×</span>`;
      lab.addEventListener("pointerdown", (e) => e.stopPropagation());  // не начинать drag рамки
      lab.querySelector(".cl-key").addEventListener("click",
        (e) => { e.stopPropagation(); cycleCol(ci); });
      lab.querySelector(".cl-x").addEventListener("click",
        (e) => { e.stopPropagation(); removeCol(ci); });
      shot.appendChild(lab);
    });
  }
  function drawCalibForShot(shot, idx) { paintGrid(shot, idx, calibRect(), true); }
  function renderCalibShots() {
    clearCalibOverlays();
    document.querySelectorAll(".cmp-shot").forEach(shot => {
      const idx = +shot.dataset.idx;
      drawCalibForShot(shot, idx);
      const img = shot.querySelector("img");
      if (img && !img._calibBound) {
        img._calibBound = true;
        img.addEventListener("pointerdown", (e) => startCalibDrag(e, shot, idx, "new"));
      }
    });
  }
  // Рисование/перемещение/ресайз рамки. mode: new|move|n|s|e|w.
  function startCalibDrag(e, shot, idx, mode) {
    if (!CALIB_MODE) return;
    const img = shot.querySelector("img"); if (!img) return;
    e.preventDefault(); e.stopPropagation();
    const r = img.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const base = mode === "new" ? null : Object.assign({ x: 0, y: 0, w: 0, h: 0 }, calibRect());
    const sx = e.clientX, sy = e.clientY;
    const cl = (v, lo, hi) => (v < lo ? lo : (v > hi ? hi : v));
    const MIN = 0.02;
    function calc(ev) {
      if (mode === "new") {
        const x0 = cl((Math.min(sx, ev.clientX) - r.left) / r.width, 0, 1);
        const x1 = cl((Math.max(sx, ev.clientX) - r.left) / r.width, 0, 1);
        const y0 = cl((Math.min(sy, ev.clientY) - r.top) / r.height, 0, 1);
        const y1 = cl((Math.max(sy, ev.clientY) - r.top) / r.height, 0, 1);
        return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      }
      const dx = (ev.clientX - sx) / r.width, dy = (ev.clientY - sy) / r.height;
      let { x, y, w, h } = base;
      if (mode === "move") { x = cl(base.x + dx, 0, 1 - base.w); y = cl(base.y + dy, 0, 1 - base.h); }
      else if (mode === "e") { w = cl(base.w + dx, MIN, 1 - base.x); }
      else if (mode === "s") { h = cl(base.h + dy, MIN, 1 - base.y); }
      else if (mode === "w") { const nx = cl(base.x + dx, 0, base.x + base.w - MIN); w = base.x + base.w - nx; x = nx; }
      else if (mode === "n") { const ny = cl(base.y + dy, 0, base.y + base.h - MIN); h = base.y + base.h - ny; y = ny; }
      return { x, y, w, h };
    }
    function move(ev) { paintGrid(shot, idx, calc(ev), false); }
    function up(ev) {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      const nr = calc(ev);
      if (nr.w < MIN || nr.h < MIN) { renderCalibShots(); return; }
      saveCalib(nr);
    }
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    move(e);
  }
  // Сохранить сетку-регион (общую для всех кадров). rh = высота / число строк.
  async function saveCalib(rect) {
    if (!DATA.calib) DATA.calib = { default: null, frames: {} };
    const prev = DATA.calib.default;
    const gr = prev ? gridRows(prev) : Math.max(1, frameCount(firstFrameIdx()));
    const off = (prev && prev.off != null) ? prev.off : autoOverlap();
    const payload = { x: rect.x, y: rect.y, w: rect.w, h: rect.h, rh: rect.h / gr, off,
                      cols: (prev && prev.cols) || [] };   // сохранить разметку колонок
    DATA.calib.default = payload;
    _calibLastRect = payload;
    renderCalibShots(); updateOffLabel();
    try {
      await API.valorCalibSet(openWeek, -1, payload);
      toast("Калибровка сохранена (все кадры)");
    } catch (e) { toast("Ошибка: " + (e.detail || e.message)); }
  }
  // Изменить число видимых строк сетки (rh = h / N).
  async function setGridN(delta) {
    const c = calibRect();
    if (!c) { toast("Сначала обведи область строк"); return; }
    const n = Math.max(1, gridRows(c) + delta);
    c.rh = c.h / n;
    renderCalibShots(); updateOffLabel();
    try { await API.valorCalibSet(openWeek, -1, c); } catch (e) { toast("Ошибка: " + (e.detail || e.message)); }
  }
  // Изменить перекрытие кадров (строк частичной прокрутки).
  async function setOff(delta) {
    const c = calibRect();
    if (!c) { toast("Сначала обведи область строк"); return; }
    c.off = Math.max(0, weekOverlap() + delta);
    renderCalibShots(); updateOffLabel();
    try { await API.valorCalibSet(openWeek, -1, c); } catch (e) { toast("Ошибка: " + (e.detail || e.message)); }
  }
  function updateOffLabel() {
    const v = $("calib-off-val"); if (v) v.textContent = weekOverlap();
    const g = $("calib-n-val"); if (g) g.textContent = calibRect() ? gridRows(calibRect()) : "—";
  }
  async function clearCalibWeek() {
    if (!confirm("Сбросить всю калибровку строк недели " + openWeek + "?")) return;
    try {
      await API.valorCalibClear(openWeek);
      DATA.calib = { default: null, frames: {} };
      toast("Калибровка недели сброшена");
      renderCalibShots(); updateOffLabel();
    } catch (e) { toast("Ошибка: " + (e.detail || e.message)); }
  }
  function calibBanner() {
    if ($("calib-banner")) return;
    const b = document.createElement("div");
    b.id = "calib-banner"; b.className = "calib-banner";
    b.innerHTML =
      `<b>📐 Калибровка строк.</b> <button id="calib-auto" class="btn-mini" title="Авто-разметка строк и колонок по скрину (без AI). Потом проверь и поправь.">✨ авто</button> ` +
      `или обведи мышью область строк; рамку двигай за грип ✥ и тяни за края. ` +
      `<b style="color:#7CFC9A">Зелёным</b> — где система ждёт каждого игрока (с ником), сверь со скрином. ` +
      `<span class="calib-ctl" title="Сколько строк помещается на экране">строк: ` +
      `<button id="calib-n-dec" class="btn-mini">−</button><b id="calib-n-val">—</b>` +
      `<button id="calib-n-inc" class="btn-mini">+</button></span>` +
      `<span class="calib-ctl" title="На сколько строк прокручен каждый следующий кадр (частичная прокрутка). Подгони так, чтобы зелёные строки на 2-м+ кадре совпали со скрином.">` +
      `перекрытие: <button id="calib-off-dec" class="btn-mini">−</button>` +
      `<b id="calib-off-val">0</b><button id="calib-off-inc" class="btn-mini">+</button> строк</span>` +
      `<span class="calib-ctl" title="Вертикальная разметка колонок: добавь границу колонки, перетащи на место; клик по метке — сменить поле (Ник/Добл./Ур./Класс/Должн./Титул), × — убрать.">` +
      `колонки: <button id="calib-col-add" class="btn-mini">+ колонка</button>` +
      `<button id="calib-col-clear" class="btn-mini">× колонки</button></span>` +
      `<button id="calib-clear" class="btn-mini" title="Сбросить всю калибровку недели">× сбросить</button>` +
      `<button id="calib-done" class="btn-mini">Готово</button>`;
    const split = $("cmp").querySelector(".cmp-split");
    $("cmp").insertBefore(b, split);
    $("calib-done").addEventListener("click", () => toggleCalib(false));
    $("calib-clear").addEventListener("click", clearCalibWeek);
    $("calib-n-dec").addEventListener("click", () => setGridN(-1));
    $("calib-n-inc").addEventListener("click", () => setGridN(1));
    $("calib-off-dec").addEventListener("click", () => setOff(-1));
    $("calib-off-inc").addEventListener("click", () => setOff(1));
    $("calib-col-add").addEventListener("click", addCol);
    $("calib-col-clear").addEventListener("click", clearCols);
    $("calib-auto").addEventListener("click", autoCalib);
    updateOffLabel();
  }
  function toggleCalib(on) {
    CALIB_MODE = (on === undefined) ? !CALIB_MODE : !!on;
    document.body.classList.toggle("calib-on", CALIB_MODE);
    const btn = $("cmp-calib");
    if (btn) btn.classList.toggle("cmp-btn-active", CALIB_MODE);
    if (CALIB_MODE) {
      if (!openWeek) { toast("Сначала выбери неделю"); CALIB_MODE = false;
        document.body.classList.remove("calib-on"); if (btn) btn.classList.remove("cmp-btn-active"); return; }
      hideZoom(); calibBanner(); renderCalibShots();
    } else {
      const b = $("calib-banner"); if (b) b.remove();
      clearCalibOverlays();
    }
  }

  // Навигация ↑/↓ по видимым строкам (быстрая сверка спорных).
  let _pinnedId = null;
  function pinMember(m) { _pinnedId = m ? m.id : null; }
  function _visibleRows() {
    const tb = $("cmp-rows") && $("cmp-rows").querySelector("tbody");
    return tb ? Array.from(tb.querySelectorAll(".cmp-row")) : [];
  }
  function _memberOfRow(tr) { return DATA.members[+tr.dataset.i]; }
  function stepRow(dir) {
    const rows = _visibleRows(); if (!rows.length) return;
    let cur = rows.findIndex(tr => _memberOfRow(tr) && _memberOfRow(tr).id === _pinnedId);
    let next = cur < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, cur + dir));
    const tr = rows[next]; if (!tr) return;
    rows.forEach(x => x.classList.remove("cmp-row-on"));
    tr.classList.add("cmp-row-on");
    tr.scrollIntoView({ block: "nearest" });
    const m = _memberOfRow(tr); pinMember(m); showRowZoom(m, true, tr);
  }
  if (!window._cmpKeysBound) {
    window._cmpKeysBound = true;
    document.addEventListener("keydown", (e) => {
      if ($("cmp") && $("cmp").hidden) return;
      const tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      if (e.key === "ArrowDown") { e.preventDefault(); stepRow(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); stepRow(-1); }
      else if (e.key === "Escape") { hideZoom(); }
    });
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

  // ── Пометка «неделя не собрана» ──
  (function injectSkipStyles() {
    if (document.getElementById("skip-styles")) return;
    const st = document.createElement("style");
    st.id = "skip-styles";
    st.textContent = `
      .btn-mini{cursor:pointer;border:1px solid var(--line,#8a6a3a);background:rgba(60,40,20,.5);
        color:var(--fg,#f3e8d2);border-radius:7px;padding:3px 10px;font:inherit;font-size:.85em;margin-left:8px}
      .btn-mini:hover{background:rgba(90,60,30,.7)}
      .vs-folder-skip{opacity:.85}
      .vs-folder-skip .vs-folder-ic{filter:grayscale(.3)}
      .vs-folder-skip .vs-folder-c{color:#c9a06a;font-style:italic}
      .skip-note{padding:18px;color:#d8c7a8;line-height:1.55}
      .skip-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;
        align-items:center;justify-content:center;z-index:10002}
      .skip-modal{background:#2a1d12;border:1px solid #8a6a3a;border-radius:12px;
        padding:18px 20px;max-width:440px;width:92%;max-height:80vh;overflow:auto;color:#f3e8d2}
      .skip-modal h3{margin:0 0 6px}
      .skip-hint{font-size:.85em;opacity:.8;margin:0 0 12px}
      .skip-row{display:flex;align-items:center;justify-content:space-between;
        padding:6px 8px;border-bottom:1px solid rgba(138,106,58,.3)}
      .skip-row small{opacity:.7}
      .skip-empty{opacity:.7;font-size:.9em;padding:6px 0}
      .skip-manual{display:flex;gap:6px;margin-top:14px}
      .skip-manual input{flex:1;background:rgba(20,14,8,.6);border:1px solid #8a6a3a;
        border-radius:7px;color:#f3e8d2;padding:5px 8px;font:inherit}
      .skip-foot{margin-top:14px;text-align:right}`;
    document.head.appendChild(st);
  })();

  async function unskipWeek(week) {
    if (!confirm(`Снять пометку «не собрано» с ${week}?`)) return;
    try { await API.valorSkipWeek({ week, skipped: false }); location.reload(); }
    catch (e) { alert("Не удалось: " + (e.detail || e.message)); }
  }

  function showSkippedView(week, el) {
    document.querySelectorAll(".vs-folder").forEach(e => e.classList.remove("vs-folder-on"));
    el.classList.add("vs-folder-on");
    const meta = document.getElementById("cmp-meta");
    if (meta) meta.textContent = week + " — данные не собирались";
    const shots = document.getElementById("cmp-shots");
    if (shots) shots.innerHTML = "";
    const rows = document.getElementById("cmp-rows");
    if (rows) {
      rows.innerHTML =
        `<div class="skip-note">📭 За неделю <b>${esc(week)}</b> статистика доблести `
        + `не собиралась. Эта неделя не учитывается в оценке игроков.`
        + `<div style="margin-top:12px"><button class="btn-mini" id="skip-note-unskip">`
        + `↩ Снять пометку «не собрано»</button></div></div>`;
      const b = document.getElementById("skip-note-unskip");
      if (b) b.addEventListener("click", () => unskipWeek(week));
    }
  }

  async function openSkipPicker() {
    let missing = [];
    try { missing = await API.valorMissingWeeks(); } catch (_) {}
    const ov = document.createElement("div");
    ov.className = "skip-overlay";
    const rows = missing.length
      ? missing.map(m => {
          const sd = (m.sunday || "").split("-").reverse().join(".");
          return `<div class="skip-row"><span>${esc(m.week)} <small>(вс ${esc(sd)})</small></span>`
            + `<button class="btn-mini skip-pick" data-week="${esc(m.week)}">Отметить</button></div>`;
        }).join("")
      : `<div class="skip-empty">Пропусков между сборами не найдено — укажи неделю вручную ниже.</div>`;
    ov.innerHTML = `<div class="skip-modal">
        <h3>📭 Неделя без сбора</h3>
        <p class="skip-hint">Помеченная неделя покажется в архиве как «не собрано» и НЕ повлияет на статистику игроков (никого не штрафует).</p>
        <div class="skip-list">${rows}</div>
        <div class="skip-manual">
          <input id="skip-manual-w" placeholder="напр. 2026-W24" />
          <button id="skip-manual-go" class="btn-mini">Отметить</button>
        </div>
        <div class="skip-foot"><button id="skip-close" class="btn-mini">Закрыть</button></div>
      </div>`;
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.addEventListener("click", e => { if (e.target === ov) close(); });
    ov.querySelector("#skip-close").addEventListener("click", close);
    async function mark(week) {
      week = (week || "").trim();
      if (!week) return;
      try { await API.valorSkipWeek({ week, skipped: true }); location.reload(); }
      catch (e) {
        alert(e.detail === "has_data"
          ? "За эту неделю уже есть собранные данные — пометить нельзя."
          : "Не удалось: " + (e.detail || e.message));
      }
    }
    ov.querySelectorAll(".skip-pick").forEach(b =>
      b.addEventListener("click", () => mark(b.dataset.week)));
    ov.querySelector("#skip-manual-go").addEventListener("click", () =>
      mark(ov.querySelector("#skip-manual-w").value));
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
    const collected = list.filter(s => !s.skipped);
    const skippedN = list.length - collected.length;
    const totalMembers = list.reduce((a, s) => a + (s.members_count || 0), 0);
    $("vs-summary").innerHTML =
      `<span>сборов: <b>${collected.length}</b></span>` +
      `<span>всего записей: <b>${totalMembers}</b></span>` +
      (skippedN ? `<span>не собрано недель: <b>${skippedN}</b></span>` : "") +
      ` <button id="vs-skip-btn" class="btn-mini" title="Отметить неделю, за которую данные не собирались">📭 Неделя не собрана</button>`;
    $("vs-weeks").innerHTML = list.map(s => {
      if (s.skipped) {
        return `<button class="vs-folder vs-folder-skip" data-week="${esc(s.week)}" data-skipped="1">
           <span class="vs-folder-ic">📭</span>
           <span class="vs-folder-txt">
             <span class="vs-folder-w">${esc(WeekFmt.range(s.week))} <small style="opacity:.55">· ${esc(WeekFmt.num(s.week))}</small></span>
             <span class="vs-folder-c">данные не собирались</span>
           </span>
         </button>`;
      }
      const shots = (shotsByWeek[s.week] != null) ? shotsByWeek[s.week] : (s.screens_count || 0);
      const dt = (s.captured_at || "").replace("T", " ").slice(0, 16);
      const people = (s.actual_members != null)
        ? `${s.members_count ?? 0}/${s.actual_members} чел.`   // распознано / в клане
        : ((s.members_count != null) ? `${s.members_count} уч.` : null);
      const mismatch = (s.actual_members != null && s.members_count != null
        && s.members_count !== s.actual_members);
      const meta = [
        `${shots} кадр.`,
        people,
        (s.valor_norm != null) ? `норма ${s.valor_norm}` : null,
      ].filter(Boolean).join(" · ");
      return `<button class="vs-folder" data-week="${esc(s.week)}">
         <span class="vs-folder-ic">📁</span>
         <span class="vs-folder-txt">
           <span class="vs-folder-w">${esc(WeekFmt.range(s.week))} <small style="opacity:.55">· ${esc(WeekFmt.num(s.week))}</small></span>
           <span class="vs-folder-c${mismatch ? " vs-folder-warn" : ""}">${esc(meta)}${mismatch ? " ⚠" : ""}</span>
           ${dt ? `<span class="vs-folder-d">собрано ${esc(dt)} UTC</span>` : ""}
           ${s.notes ? `<span class="vs-folder-n" title="${esc(s.notes)}">✎ ${esc(s.notes)}</span>` : ""}
         </span>
       </button>`;
    }).join("");
    $("vs-weeks").querySelectorAll(".vs-folder").forEach(el =>
      el.addEventListener("click", () => {
        if (el.dataset.skipped === "1") {
          showSkippedView(el.dataset.week, el);
          return;
        }
        loadWeek(el.dataset.week, el);
      }));
    const skipBtn = document.getElementById("vs-skip-btn");
    if (skipBtn) skipBtn.addEventListener("click", openSkipPicker);
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
      $("cmp-log").addEventListener("click", () => openEditLog(openWeek));
      const av = $("cmp-autoverify");
      if (av) av.addEventListener("click", autoVerify);
      const cb = $("cmp-calib");
      if (cb) cb.addEventListener("click", () => toggleCalib());
    }
    if (IS_OFFICER) {
      const rb = $("cmp-restore-btn");
      if (rb) { rb.hidden = false; rb.addEventListener("click", openRestore); }
    }
    const first = $("vs-weeks").querySelector(".vs-folder");
    if (first) loadWeek(first.dataset.week, first).then(focusFromUrl);
  } catch (e) {
    $("vs-loading").textContent = "Ошибка загрузки: " + (e.detail || e.message);
  }
})();
