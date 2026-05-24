// Admin Settings — смена паролей + snapshots/restore.
(async function () {
  const $ = (id) => document.getElementById(id);

  let me;
  try { me = await API.me(); } catch (_) { window.location.href = "admin_login.html"; return; }
  if (me.role !== "admin") {
    alert("Эта страница доступна только администратору.");
    window.location.href = "index.html";
    return;
  }
  $("who").textContent = `АДМИНИСТРАТОР • ${me.name}`;
  $("logout-btn").addEventListener("click", async () => {
    try { await API.logout(); } catch (_) {}
    window.location.href = "admin_login.html";
  });

  function flash(el, text, ok) {
    el.textContent = text;
    el.style.color = ok ? "var(--accent)" : "var(--danger)";
    setTimeout(() => { el.textContent = ""; }, 5000);
  }

  // ── Officer password ──
  $("officer-pwd-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const a = $("op-new").value;
    const b = $("op-confirm").value;
    const status = $("op-status");
    if (a !== b) { flash(status, "Пароли не совпадают.", false); return; }
    try {
      await API.setOfficerPwd(a);
      $("op-new").value = "";
      $("op-confirm").value = "";
      flash(status, "✓ Новый пароль офицеров сохранён.", true);
    } catch (e) {
      flash(status, e.detail || e.message || "Ошибка", false);
    }
  });

  // ── Admin credentials ──
  $("admin-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const status = $("a-status");
    const payload = { current_password: $("a-current").value };
    const u = $("a-new-user").value.trim();
    const p = $("a-new-pwd").value;
    if (u) payload.new_username = u;
    if (p) payload.new_password = p;
    if (!u && !p) { flash(status, "Заполни хотя бы одно поле для смены.", false); return; }
    try {
      await API.updateAdmin(payload);
      $("a-current").value = "";
      $("a-new-user").value = "";
      $("a-new-pwd").value = "";
      flash(status, "✓ Креды администратора обновлены.", true);
      if (u) {
        setTimeout(() => { window.location.href = "admin_login.html"; }, 1500);
      }
    } catch (e) {
      if (e.status === 401) flash(status, "Текущий пароль неверный.", false);
      else flash(status, e.detail || e.message || "Ошибка", false);
    }
  });

  // ── Snapshots ──
  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + " Б";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " КБ";
    return (bytes / (1024 * 1024)).toFixed(2) + " МБ";
  }

  function fmtIso(iso) {
    if (!iso) return "";
    const d = new Date(iso + (iso.endsWith("Z") ? "" : "Z"));
    return d.toLocaleString("ru-RU", {
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  }

  async function reloadSnapshots() {
    try {
      const list = await API.snapshotList();
      const tbody = $("snap-tbody");
      tbody.innerHTML = "";
      if (!list.length) {
        $("snap-empty").hidden = false;
        return;
      }
      $("snap-empty").hidden = true;
      for (const s of list) {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td class="nick"></td>
          <td class="date"></td>
          <td></td>
          <td class="row-actions">
            <button class="btn-restore">Откатить</button>
            <button class="btn-del-snap danger">Удалить</button>
          </td>
        `;
        tr.children[0].textContent = s.name;
        tr.children[1].textContent = fmtIso(s.created_at);
        tr.children[2].textContent = fmtSize(s.size);

        tr.querySelector(".btn-restore").addEventListener("click", () => doRestore(s.name));
        tr.querySelector(".btn-del-snap").addEventListener("click", () => doDelete(s.name));
        tbody.appendChild(tr);
      }
    } catch (e) {
      flash($("snap-status"), `Ошибка: ${e.detail || e.message}`, false);
    }
  }

  async function doRestore(name) {
    if (!confirm(`Откатить базу к снапшоту "${name}"?\n\nТекущая база будет сохранена как pre_restore_*.\nСервер перезапустится — обнови страницу через несколько секунд.`)) return;
    try {
      await API.snapshotRestore(name);
      flash($("snap-status"), "✓ Откат запущен. Сервер перезапускается…", true);
      setTimeout(() => location.reload(), 5000);
    } catch (e) {
      flash($("snap-status"), `Ошибка: ${e.detail || e.message}`, false);
    }
  }

  async function doDelete(name) {
    if (!confirm(`Удалить снапшот "${name}"?`)) return;
    try {
      await API.snapshotDelete(name);
      await reloadSnapshots();
    } catch (e) {
      flash($("snap-status"), `Ошибка: ${e.detail || e.message}`, false);
    }
  }

  $("snapshot-now").addEventListener("click", async () => {
    try {
      const s = await API.snapshotCreate();
      flash($("snap-status"), `✓ Создан: ${s.name}`, true);
      await reloadSnapshots();
    } catch (e) {
      flash($("snap-status"), `Ошибка: ${e.detail || e.message}`, false);
    }
  });

  await reloadSnapshots();
})();
