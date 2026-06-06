// Главная — таблица, форма добавления, inline-редактирование.
(async function () {
  const $ = (id) => document.getElementById(id);

  // ── Auth gate ──
  let me;
  try {
    me = await API.me();
  } catch (e) {
    window.location.href = "login.html";
    return;
  }
  // Гость допущен только к таблице Доблести. На офицерских страницах данные
  // вернут 403 и страница будет битой — отправляем гостя на его раздел.
  if (me.role !== "officer" && me.role !== "admin") {
    window.location.href = "clan-valor.html";
    return;
  }
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
    window.location.href = "login.html";
  });

  // ── Date input ──
  DateRu.bindDateInput($("f-date"));
  $("f-date").value = DateRu.today();

  // ── Add form ──
  $("add-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const nick = $("f-nick").value.trim();
    const title = $("f-title").value.trim();
    const rusDate = $("f-date").value.trim();
    const note = $("f-note").value.trim();

    const iso = DateRu.parseRus(rusDate);
    if (!nick) return;
    if (!iso) {
      setStatus("✗ Неверная дата — ожидаю ДД.ММ.ГГГГ");
      return;
    }

    setStatus("Добавляю…");
    try {
      await API.create({ game_nick: nick, title, accepted_date: iso, note });
      $("f-nick").value = "";
      $("f-title").value = "";
      $("f-note").value = "";
      $("f-date").value = DateRu.today();
      setStatus(`✓ Добавлен: ${nick}`);
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
          <button class="btn-del danger">Удалить</button>
        </td>
      `;
      tr.querySelector(".nick").textContent = r.game_nick;
      tr.querySelector(".title").textContent = r.title || "—";
      tr.querySelector(".note").textContent = r.note || "—";
      tr.querySelector(".actor").textContent = r.created_by_name;

      tr.querySelector(".btn-del").addEventListener("click", () => onDelete(r));
      tr.querySelector(".btn-edit").addEventListener("click", () => onEdit(tr, r));
      tbody.appendChild(tr);
    });
  }

  async function reload() {
    try {
      const data = await API.list();
      renderTable(data);
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
    actions.innerHTML = `<button class="save">Сохранить</button><button class="cancel">Отмена</button>`;

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
      const payload = {
        game_nick:     nickCell.querySelector("input").value.trim(),
        title:         titleCell.querySelector("input").value.trim(),
        accepted_date: iso,
        note:          noteCell.querySelector("input").value.trim(),
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
  // Auto-refresh раз в 30 сек, но НЕ выбивает пользователя из редактирования.
  setInterval(() => { if (editingId === null) reload(); }, 30000);
})();
