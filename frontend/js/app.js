// Главная страница — таблица, форма добавления, inline-редактирование.
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
  $("who").textContent = `${fmtRoleLabel(me.role)} • ${me.name}`;
  if (me.role === "admin") {
    const tab = $("settings-tab");
    if (tab) tab.hidden = false;
  }
  $("logout-btn").addEventListener("click", async () => {
    try { await API.logout(); } catch (_) {}
    window.location.href = "login.html";
  });

  // ── Form: defaults ──
  const dateInput = $("f-date");
  dateInput.value = new Date().toISOString().slice(0, 10);

  $("add-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const nick = $("f-nick").value.trim();
    const title = $("f-title").value.trim();
    const date = $("f-date").value;
    const note = $("f-note").value.trim();
    if (!nick || !date) return;

    setStatus("Добавляю…");
    try {
      await API.create({ game_nick: nick, title, accepted_date: date, note });
      $("f-nick").value = "";
      $("f-title").value = "";
      $("f-note").value = "";
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

  function fmtRoleLabel(role) {
    if (role === "admin") return "АДМИНИСТРАТОР";
    if (role === "officer") return "ОФИЦЕР";
    return role.toUpperCase();
  }

  // ── Render table ──
  function fmtDate(iso) {
    const [y, m, d] = iso.split("-");
    return `${d}.${m}.${y}`;
  }

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
        <td class="date">${fmtDate(r.accepted_date)}</td>
        <td class="${r.immune_active ? "immune-active" : "immune-expired"}">
          ${r.immune_active ? "до " : "истёк "}${fmtDate(r.immune_until)}
        </td>
        <td class="note"></td>
        <td style="color: var(--muted); font-size: 12px;"></td>
        <td class="row-actions">
          <button class="btn-edit">Изменить</button>
          <button class="btn-del danger">Удалить</button>
        </td>
      `;
      tr.querySelector(".nick").textContent = r.game_nick;
      tr.querySelector(".title").textContent = r.title || "—";
      tr.querySelector(".note").textContent = r.note || "—";
      tr.querySelector("td:nth-child(7)").textContent =
        `${r.created_by_platform}:${r.created_by_name}`;

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
    if (!confirm(`Удалить запись "${r.game_nick}" (принят ${fmtDate(r.accepted_date)})?`)) return;
    try {
      await API.remove(r.id);
      await reload();
    } catch (e) {
      alert(`Не удалось удалить: ${e.detail || e.message}`);
    }
  }

  function onEdit(tr, r) {
    const nickCell  = tr.querySelector(".nick");
    const titleCell = tr.querySelector(".title");
    const dateCell  = tr.querySelector(".date");
    const noteCell  = tr.querySelector(".note");
    const actions   = tr.querySelector(".row-actions");

    nickCell.innerHTML  = `<input type="text" value="${escapeAttr(r.game_nick)}" style="width:100%">`;
    titleCell.innerHTML = `<input type="text" value="${escapeAttr(r.title || "")}" placeholder="Титул" style="width:100%">`;
    dateCell.innerHTML  = `<input type="date" value="${r.accepted_date}" style="width:100%">`;
    noteCell.innerHTML  = `<input type="text" value="${escapeAttr(r.note || "")}" style="width:100%">`;
    actions.innerHTML = `<button class="save">Сохранить</button><button class="cancel">Отмена</button>`;

    actions.querySelector(".cancel").addEventListener("click", reload);
    actions.querySelector(".save").addEventListener("click", async () => {
      const payload = {
        game_nick:     nickCell.querySelector("input").value.trim(),
        title:         titleCell.querySelector("input").value.trim(),
        accepted_date: dateCell.querySelector("input").value,
        note:          noteCell.querySelector("input").value.trim(),
      };
      try {
        await API.update(r.id, payload);
        await reload();
      } catch (e) {
        alert(`Не удалось сохранить: ${e.detail || e.message}`);
      }
    });
  }

  function escapeAttr(s) {
    return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  await reload();
  setInterval(reload, 30000);
})();
