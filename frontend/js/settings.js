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
            <button class="btn-inspect">Открыть</button>
            <button class="btn-restore">Откатить</button>
            <button class="btn-del-snap danger">Удалить</button>
          </td>
        `;
        tr.children[0].textContent = s.name;
        tr.children[1].textContent = fmtIso(s.created_at);
        tr.children[2].textContent = fmtSize(s.size);

        tr.querySelector(".btn-inspect").addEventListener("click", () => doInspect(s.name));
        tr.querySelector(".btn-restore").addEventListener("click", () => doRestore(s.name));
        tr.querySelector(".btn-del-snap").addEventListener("click", () => doDelete(s.name));
        tbody.appendChild(tr);
      }
    } catch (e) {
      flash($("snap-status"), `Ошибка: ${e.detail || e.message}`, false);
    }
  }

  async function doInspect(name) {
    try {
      const data = await API.snapshotInspect(name);
      openInspectModal(name, data);
    } catch (e) {
      flash($("snap-status"), `Ошибка: ${e.detail || e.message}`, false);
    }
  }

  function esc(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  }

  function fmtIsoDate(iso) {
    if (!iso) return "";
    const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
  }

  function fmtTs(iso) {
    if (!iso) return "";
    const d = new Date(iso + (iso.endsWith("Z") ? "" : "Z"));
    return d.toLocaleString("ru-RU", {
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  }

  function openInspectModal(name, data) {
    const old = document.getElementById("inspect-modal");
    if (old) old.remove();

    const accRows = (data.acceptances || []).map((r, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${esc(r.game_nick)}</td>
        <td>${esc(r.title)}</td>
        <td>${fmtIsoDate(r.accepted_date)}</td>
        <td>${esc(r.note)}</td>
      </tr>`).join("") || `<tr><td colspan="5" class="empty">Записей нет</td></tr>`;

    const ACTION = { create: "ДОБАВЛЕНО", update: "ИЗМЕНЕНО", delete: "УДАЛЕНО" };
    const auditRows = (data.audit || []).map(a => `
      <tr>
        <td class="${a.action}" style="color: ${a.action === 'delete' ? 'var(--danger)' : 'var(--accent)'};">
          ${ACTION[a.action] || (a.action || "").toUpperCase()}
        </td>
        <td>${esc(a.game_nick)}</td>
        <td>${esc(a.actor_name)}</td>
        <td>${fmtTs(a.timestamp)}</td>
      </tr>`).join("") || `<tr><td colspan="4" class="empty">История пуста</td></tr>`;

    const modal = document.createElement("div");
    modal.id = "inspect-modal";
    modal.className = "modal-backdrop";
    modal.innerHTML = `
      <div class="modal-card">
        <div class="modal-head">
          <h2>Снапшот: ${esc(name)}</h2>
          <button class="modal-close" type="button" aria-label="Закрыть">×</button>
        </div>

        <h3 style="font-size:13px;letter-spacing:3px;color:var(--accent);margin:8px 0;">РЕЕСТР</h3>
        <div class="table-scroll" style="max-height:30vh;">
          <table>
            <thead><tr>
              <th style="width:42px;">№</th><th>Ник</th><th>Титул</th>
              <th style="width:130px;">Принят</th><th>Примечание</th>
            </tr></thead>
            <tbody>${accRows}</tbody>
          </table>
        </div>

        <h3 style="font-size:13px;letter-spacing:3px;color:var(--accent);margin:18px 0 8px;">ЖУРНАЛ ИЗМЕНЕНИЙ</h3>
        <div class="table-scroll" style="max-height:30vh;">
          <table>
            <thead><tr>
              <th style="width:120px;">Действие</th><th>Ник</th>
              <th style="width:160px;">Автор</th><th style="width:160px;">Когда</th>
            </tr></thead>
            <tbody>${auditRows}</tbody>
          </table>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener("click", (ev) => {
      if (ev.target === modal) modal.remove();
    });
    modal.querySelector(".modal-close").addEventListener("click", () => modal.remove());
    document.addEventListener("keydown", function onEsc(e) {
      if (e.key === "Escape") { modal.remove(); document.removeEventListener("keydown", onEsc); }
    });
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
