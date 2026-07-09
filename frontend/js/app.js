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

  // ── Ники из таблицы Доблести — для уведомления о дубле при регистрации ──
  const normNick = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, "");
  let valorNickSet = new Set();
  try {
    const v = await API.valorCurrent();
    const members = (v && (v.members || v.rows || v.list)) || [];
    members.forEach((m) => { const n = m.nick || m.game_nick; if (n) valorNickSet.add(normNick(n)); });
  } catch (_) {}
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

  // ── Add form ──
  $("add-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const nick = $("f-nick").value.trim();
    const title = $("f-title").value.trim();
    const rusDate = $("f-date").value.trim();
    const note = $("f-note").value.trim();
    const veteran = $("f-veteran") ? $("f-veteran").checked : false;
    const elite = $("f-elite") ? $("f-elite").checked : false;

    const iso = DateRu.parseRus(rusDate);
    if (!nick) return;
    if (!iso) {
      setStatus("✗ Неверная дата — ожидаю ДД.ММ.ГГГГ");
      return;
    }

    setStatus("Добавляю…");
    try {
      await API.create({ game_nick: nick, title, accepted_date: iso, note, veteran, elite });
      $("f-nick").value = "";
      $("f-title").value = "";
      $("f-note").value = "";
      $("f-date").value = DateRu.today();
      if ($("f-veteran")) $("f-veteran").checked = false;
      if ($("f-elite")) $("f-elite").checked = false;
      if ($("nick-dup-note")) $("nick-dup-note").hidden = true;
      if ($("nick-kicked-note")) { $("nick-kicked-note").hidden = true; $("nick-kicked-note").innerHTML = ""; }
      setStatus(`✓ Добавлен: ${nick}${veteran ? " (★ Ветеран)" : ""}${elite ? " (⚔ Элита)" : ""}`);
      await reload();
    } catch (e) {
      setStatus(`✗ Ошибка: ${e.detail || e.message}`);
    }
  });

  function setStatus(text) {
    $("form-status").textContent = text;
    if (text.startsWith("✓") || text.startsWith("✗")) {
      setTimeout(() => { $("form-status").textContent = ""; }, 4000);
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
      // Роль «Элита» (Топ по урону) — вся строка в роскошной золотой рамке.
      if (r.elite) tr.classList.add("row-elite");
      tr.innerHTML = `
        <td>${i + 1}</td>
        <td class="nick"></td>
        <td class="title"></td>
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
      if (r.elite || r.veteran) {
        const box = document.createElement("div");
        box.className = "reg-roles";
        const addRole = (cls, txt, title) => {
          const b = document.createElement("span");
          b.className = "reg-role " + cls;
          b.textContent = txt;
          b.title = title;
          box.appendChild(b);
        };
        if (r.elite)   addRole("reg-role-elite", "⚔ Элита", "Роль Элита (Топ по урону)");
        if (r.veteran) addRole("reg-role-vet", "★ Ветеран", "Роль Ветеран");
        nickCell.appendChild(box);
      }
      tr.querySelector(".title").textContent = r.title || "—";
      tr.querySelector(".actor").textContent = r.created_by_name;

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
    let rows = allRows;
    if (q) {
      rows = allRows.filter((r) =>
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
  }

  async function reload() {
    try {
      allRows = await API.list();
      applyFilter();
    } catch (e) {
      setStatus(`✗ Не удалось загрузить: ${e.message}`);
    }
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
    const dateCell  = tr.querySelector(".date");
    const noteCell  = tr.querySelector(".note");
    const actions   = tr.querySelector(".row-actions");

    nickCell.innerHTML  = `<input type="text" value="${esc(r.game_nick)}" style="width:100%">`;
    titleCell.innerHTML = `<input type="text" value="${esc(r.title || "")}" placeholder="титул" style="width:100%">`;
    dateCell.innerHTML  = `<input type="text" value="${DateRu.fmtRus(r.accepted_date)}" placeholder="ДД.ММ.ГГГГ" style="width:100%">`;
    noteCell.innerHTML  = `<input type="text" value="${esc(r.note || "")}" style="width:100%">`;
    actions.innerHTML =
      `<label class="ed-vet-lbl" title="Роль Ветеран в Доблести">`
      + `<input type="checkbox" class="ed-vet" ${r.veteran ? "checked" : ""}> ★Вет</label>`
      + `<label class="ed-elite-lbl" title="Роль Элита (Топ по урону) в Доблести">`
      + `<input type="checkbox" class="ed-elite" ${r.elite ? "checked" : ""}> ⚔Элита</label>`
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
      const payload = {
        game_nick:     nickCell.querySelector("input").value.trim(),
        title:         titleCell.querySelector("input").value.trim(),
        accepted_date: iso,
        note:          noteCell.querySelector("input").value.trim(),
        veteran:       vetBox ? vetBox.checked : undefined,
        elite:         eliteBox ? eliteBox.checked : undefined,
      };
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
