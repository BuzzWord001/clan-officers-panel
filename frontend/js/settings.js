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
  // CSS-гейт админ-группы вкладок через body[data-role=admin].
  document.body.setAttribute("data-role", me.role);
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
      await reloadStorageStats();
    } catch (e) {
      flash($("snap-status"), `Ошибка: ${e.detail || e.message}`, false);
    }
  });

  async function reloadStorageStats() {
    try {
      const st = await API.storage();
      const dbKb = (st.db.db_bytes / 1024).toFixed(1);
      const snapMb = (st.snapshots.total_bytes / (1024*1024)).toFixed(2);
      const rows = st.db.rows || {};
      const top = Object.entries(rows)
        .filter(([k, v]) => v > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}: ${v}`)
        .join("  •  ");
      $("storage-stats").innerHTML =
        `Размер БД: <b>${dbKb} КБ</b>  •  Снапшотов: <b>${st.snapshots.count}</b> (${snapMb} МБ)<br>${top}`;
    } catch (e) {
      $("storage-stats").textContent = "статистика недоступна";
    }
  }

  // ── GeoIP helpers ──
  // countryCode → флаг через regional indicator letters. RU → 🇷🇺
  function flag(code) {
    if (!code || code.length !== 2) return "";
    const A = 0x1F1E6;
    return String.fromCodePoint(A + code.charCodeAt(0) - 65)
         + String.fromCodePoint(A + code.charCodeAt(1) - 65);
  }
  function fmtGeo(g) {
    if (!g) return "—";
    const parts = [];
    if (g.country_code) parts.push(flag(g.country_code));
    if (g.country) parts.push(g.country);
    if (g.city) parts.push(g.city);
    return parts.length ? parts.join(" ") : "—";
  }

  async function resolveAllIps(ips) {
    // Дедуп и фильтрация пустых, чтобы не тратить квоту ip-api.
    const uniq = [...new Set(ips.filter(Boolean).filter(x => x !== "—"))];
    if (!uniq.length) return {};
    try {
      return await API.resolveIps(uniq);
    } catch (e) {
      console.warn("geoip resolve failed:", e);
      return {};
    }
  }

  // ── Login log ──
  async function reloadLogins() {
    try {
      const list = await API.loginLog(200);
      const tbody = $("logins-tbody");
      tbody.innerHTML = "";
      if (!list.length) { $("logins-empty").hidden = false; return; }
      $("logins-empty").hidden = true;
      const geo = await resolveAllIps(list.map(l => l.ip));
      for (const l of list) {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td class="date"></td>
          <td></td>
          <td class="nick"></td>
          <td></td>
          <td class="ip"></td>
          <td class="geo"></td>
          <td class="ua"></td>
          <td class="row-actions"></td>
        `;
        tr.children[0].textContent = fmtIso(l.timestamp);
        tr.children[1].textContent = l.role === "admin" ? "АДМИН" : "офицер";
        tr.children[2].textContent = l.name;
        tr.children[3].className = l.success ? "success-yes" : "success-no";
        tr.children[3].textContent = l.success ? "✓" : "✗";
        if (!l.success && l.reason) {
          tr.children[3].title = l.reason;
        }
        tr.children[4].textContent = l.ip || "—";
        const g = geo[l.ip];
        tr.children[5].textContent = fmtGeo(g);
        if (g && g.isp) tr.children[5].title = g.isp;
        tr.children[6].textContent = l.user_agent || "—";

        // Кнопки быстрой блокировки. По admin блокировать смысла нет.
        const actions = tr.children[7];
        if (l.ip && l.ip !== "—") {
          const ipBtn = document.createElement("button");
          ipBtn.className = "danger";
          ipBtn.textContent = "Блок IP";
          ipBtn.addEventListener("click", () => quickBlock("ip", l.ip, `вход ${l.name}`));
          actions.appendChild(ipBtn);
        }
        if (l.role === "officer" && l.name) {
          const nickBtn = document.createElement("button");
          nickBtn.className = "danger";
          nickBtn.style.marginLeft = "6px";
          nickBtn.textContent = "Блок ник";
          nickBtn.addEventListener("click", () => quickBlock("nick", l.name, `по нику`));
          actions.appendChild(nickBtn);
        }
        tbody.appendChild(tr);
      }
    } catch (e) {
      flash($("logins-status"), `Ошибка: ${e.detail || e.message}`, false);
    }
  }

  $("clear-logins").addEventListener("click", async () => {
    if (!confirm("Полностью очистить журнал входов?")) return;
    try {
      await API.loginLogClear();
      await reloadLogins();
      flash($("logins-status"), "✓ Очищено", true);
    } catch (e) {
      flash($("logins-status"), `Ошибка: ${e.detail || e.message}`, false);
    }
  });

  // ── Blocklist ──
  async function quickBlock(kind, pattern, reason) {
    if (!confirm(`Заблокировать ${kind === "ip" ? "IP " + pattern : "ник " + pattern}?\nПричина: ${reason}`)) return;
    try {
      await API.blocklistAdd({ kind, pattern, reason });
      await reloadBlocklist();
      flash($("block-status"), `✓ Заблокирован ${kind}: ${pattern}`, true);
    } catch (e) {
      flash($("block-status"), `Ошибка: ${e.detail || e.message}`, false);
    }
  }

  async function reloadBlocklist() {
    try {
      const list = await API.blocklist();
      const tbody = $("block-tbody");
      tbody.innerHTML = "";
      if (!list.length) { $("block-empty").hidden = false; return; }
      $("block-empty").hidden = true;
      for (const b of list) {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td></td><td class="nick"></td><td></td><td class="date"></td>
          <td></td><td class="row-actions"></td>
        `;
        tr.children[0].textContent = b.kind === "ip" ? "IP" : "ник";
        tr.children[1].textContent = b.pattern;
        tr.children[2].textContent = b.reason || "—";
        tr.children[3].textContent = fmtIso(b.created_at);
        tr.children[4].textContent = b.created_by;
        const delBtn = document.createElement("button");
        delBtn.textContent = "Разблок.";
        delBtn.addEventListener("click", async () => {
          if (!confirm(`Снять блокировку ${b.kind}:${b.pattern}?`)) return;
          try {
            await API.blocklistRemove(b.id);
            await reloadBlocklist();
            flash($("block-status"), `✓ Разблокирован`, true);
          } catch (e) {
            flash($("block-status"), `Ошибка: ${e.detail || e.message}`, false);
          }
        });
        tr.children[5].appendChild(delBtn);
        tbody.appendChild(tr);
      }
    } catch (e) {
      flash($("block-status"), `Ошибка: ${e.detail || e.message}`, false);
    }
  }

  $("block-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const payload = {
      kind: $("block-kind").value,
      pattern: $("block-pattern").value.trim(),
      reason: $("block-reason").value.trim(),
    };
    if (!payload.pattern) return;
    try {
      await API.blocklistAdd(payload);
      $("block-pattern").value = "";
      $("block-reason").value = "";
      await reloadBlocklist();
      flash($("block-status"), `✓ Заблокирован`, true);
    } catch (e) {
      flash($("block-status"), `Ошибка: ${e.detail || e.message}`, false);
    }
  });

  // ── Access log ──
  async function reloadAccess() {
    try {
      const list = await API.accessLog(500);
      const tbody = $("access-tbody");
      tbody.innerHTML = "";
      if (!list.length) { $("access-empty").hidden = false; return; }
      $("access-empty").hidden = true;
      const geo = await resolveAllIps(list.map(a => a.ip));
      for (const a of list) {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td class="date"></td>
          <td></td>
          <td></td>
          <td></td>
          <td></td>
          <td></td>
          <td class="nick"></td>
          <td class="ip"></td>
          <td class="geo"></td>
        `;
        tr.children[0].textContent = fmtIso(a.timestamp);
        tr.children[1].textContent = a.method;
        tr.children[2].textContent = a.path;
        tr.children[3].textContent = a.status;
        tr.children[3].className = a.status >= 400 ? "success-no" : "success-yes";
        tr.children[4].textContent = a.latency_ms;
        tr.children[5].textContent = a.actor_role === "admin"
          ? "АДМИН" : (a.actor_role === "officer" ? "офицер" : "—");
        tr.children[6].textContent = a.actor_name || "—";
        tr.children[7].textContent = a.ip || "—";
        tr.children[7].title = a.user_agent || "";
        const g = geo[a.ip];
        tr.children[8].textContent = fmtGeo(g);
        if (g && g.isp) tr.children[8].title = g.isp;
        tbody.appendChild(tr);
      }
    } catch (e) {
      flash($("access-status"), `Ошибка: ${e.detail || e.message}`, false);
    }
  }

  // ── Telemetry (failed fetches before they reach auth) ──
  async function reloadTelemetry() {
    try {
      const list = await API.telemetry(200);
      const tbody = $("telemetry-tbody");
      tbody.innerHTML = "";
      if (!list.length) { $("telemetry-empty").hidden = false; return; }
      $("telemetry-empty").hidden = true;
      const geo = await resolveAllIps(list.map(t => t.ip));
      for (const t of list) {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td class="date"></td>
          <td></td>
          <td></td>
          <td></td>
          <td class="ip"></td>
          <td class="geo"></td>
        `;
        tr.children[0].textContent = fmtIso(t.timestamp);
        tr.children[1].textContent = t.kind;
        tr.children[2].textContent = t.message || "—";
        tr.children[2].title = t.user_agent || "";
        tr.children[3].textContent = t.url || "—";
        tr.children[4].textContent = t.ip || "—";
        const g = geo[t.ip];
        tr.children[5].textContent = fmtGeo(g);
        if (g && g.isp) tr.children[5].title = g.isp;
        tbody.appendChild(tr);
      }
    } catch (e) {
      flash($("telemetry-status"), `Ошибка: ${e.detail || e.message}`, false);
    }
  }

  $("clear-telemetry").addEventListener("click", async () => {
    if (!confirm("Очистить журнал telemetry?")) return;
    try {
      await API.telemetryClear();
      await reloadTelemetry();
      flash($("telemetry-status"), "✓ Очищено", true);
    } catch (e) {
      flash($("telemetry-status"), `Ошибка: ${e.detail || e.message}`, false);
    }
  });

  $("clear-access").addEventListener("click", async () => {
    if (!confirm("Полностью очистить журнал действий?")) return;
    try {
      await API.accessLogClear();
      await reloadAccess();
      flash($("access-status"), "✓ Очищено", true);
    } catch (e) {
      flash($("access-status"), `Ошибка: ${e.detail || e.message}`, false);
    }
  });

  await reloadSnapshots();
  await reloadStorageStats();
  await reloadLogins();
  await reloadBlocklist();
  await reloadTelemetry();
  await reloadAccess();
})();
