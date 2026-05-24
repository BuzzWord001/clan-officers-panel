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
  $("who").textContent = `${me.role.toUpperCase()} :: ${me.name}`;
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
    const date = $("f-date").value;
    const note = $("f-note").value.trim();
    if (!nick || !date) return;

    setStatus("Запись…");
    try {
      await API.create({ game_nick: nick, accepted_date: date, note });
      $("f-nick").value = "";
      $("f-note").value = "";
      setStatus(`✓ Принят: ${nick}`);
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
        <td class="date">${fmtDate(r.accepted_date)}</td>
        <td class="${r.immune_active ? "immune-active" : "immune-expired"}">
          ${r.immune_active ? "иммунитет до " : "иммунитет был до "}${fmtDate(r.immune_until)}
        </td>
        <td class="note"></td>
        <td style="color: var(--muted); font-size: 12px;"></td>
        <td class="row-actions">
          <button class="btn-edit">Edit</button>
          <button class="btn-del danger">Del</button>
        </td>
      `;
      tr.querySelector(".nick").textContent = r.game_nick;
      tr.querySelector(".note").textContent = r.note || "—";
      tr.querySelector("td:nth-child(6)").textContent =
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
    // Превращаем строку в редактируемую: ник, дата, примечание.
    const nickCell = tr.querySelector(".nick");
    const dateCell = tr.querySelector(".date");
    const noteCell = tr.querySelector(".note");
    const actions  = tr.querySelector(".row-actions");

    nickCell.innerHTML = `<input type="text" value="${escapeAttr(r.game_nick)}" style="width:100%">`;
    dateCell.innerHTML = `<input type="date" value="${r.accepted_date}" style="width:100%">`;
    noteCell.innerHTML = `<input type="text" value="${escapeAttr(r.note || "")}" style="width:100%">`;
    actions.innerHTML = `<button class="save">Save</button><button class="cancel">Cancel</button>`;

    actions.querySelector(".cancel").addEventListener("click", reload);
    actions.querySelector(".save").addEventListener("click", async () => {
      const payload = {
        game_nick: nickCell.querySelector("input").value.trim(),
        accepted_date: dateCell.querySelector("input").value,
        note: noteCell.querySelector("input").value.trim(),
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
  // Лёгкий авто-рефреш на случай если другой офицер только что добавил.
  setInterval(reload, 30000);
})();
