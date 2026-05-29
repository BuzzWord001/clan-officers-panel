// Таблица всех зарегистрированных участников клана + статистика
// активности в архиве: сообщения общий/офицерский, символы, медиа,
// гистограмма за 12 недель (sparkline).
(async function () {
  const $ = (id) => document.getElementById(id);

  let me;
  try {
    me = await API.me();
  } catch (e) {
    // Не молча редиректим: если backend/конфиг отвалился, важно показать
    // явное состояние, иначе пользователь видит мигание окна логина.
    if (e && (e.status === 401 || e.status === 403)) {
      window.location.href = "login.html";
    } else {
      document.body.innerHTML =
        "<div style='padding:30px;color:#ff6;font-family:monospace'>"
        + "Не удалось подключиться к backend.<br>Ошибка: "
        + (e && (e.detail || e.message) || "unknown")
        + "<br><br><a href='index.html' style='color:#0f0'>Вернуться в реестр</a>"
        + "</div>";
    }
    return;
  }

  const isAdmin = me.role === "admin";
  document.body.setAttribute("data-role", me.role);
  $("who").textContent =
    `${isAdmin ? "АДМИНИСТРАТОР" : (me.role === "officer" ? "ОФИЦЕР" : me.role.toUpperCase())} • ${me.name}`;
  if (isAdmin) {
    const tab = $("settings-tab");
    if (tab) tab.hidden = false;
  }
  $("logout-btn").addEventListener("click", async () => {
    try { await API.logout(); } catch (_) {}
    window.location.href = "login.html";
  });

  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;",
      '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function fmtNum(n) {
    if (!n) return "0";
    if (n < 1000) return String(n);
    if (n < 1_000_000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + "к";
    return (n / 1_000_000).toFixed(1) + "м";
  }
  function fmtDate(iso) {
    if (!iso) return "—";
    try {
      const d = new Date(iso.endsWith("Z") ? iso : iso + "Z");
      return d.toLocaleDateString("ru-RU",
        { day: "2-digit", month: "2-digit", year: "2-digit" });
    } catch (_) { return iso.slice(0, 10); }
  }

  // ── Sparkline ──────────────────────────────────────────────────────
  // Маленький SVG-график активности по неделям. Высота bars относительная
  // к максимуму в этой строке — каждый ряд масштабируется сам по себе,
  // показывая ИНДИВИДУАЛЬНЫЙ паттерн активности (а не сравнение с другими).
  function renderSparkline(weeks) {
    if (!Array.isArray(weeks) || !weeks.length) {
      return `<span class="m-spark-empty">—</span>`;
    }
    const W = 96, H = 24, gap = 1;
    const n = weeks.length;
    const max = Math.max(1, ...weeks);
    const bw = (W - gap * (n - 1)) / n;
    let bars = "";
    for (let i = 0; i < n; i++) {
      const v = weeks[i];
      const h = max > 0 ? Math.max(v > 0 ? 2 : 0, Math.round((v / max) * (H - 2))) : 0;
      const x = i * (bw + gap);
      const y = H - h;
      const cls = v > 0 ? "m-spark-bar" : "m-spark-bar-zero";
      bars += `<rect class="${cls}" x="${x.toFixed(1)}" y="${y}" width="${bw.toFixed(1)}" height="${h}"></rect>`;
    }
    const total = weeks.reduce((a, b) => a + b, 0);
    return `<svg class="m-spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"
              title="Сообщений за 12 недель: ${total}">${bars}</svg>`;
  }

  // ── Информация о профиле для колонки «Участник» ────────────────────
  function platformLink(kind, profile) {
    if (kind === "tg") {
      const u = (profile.tg_username || "").replace(/^@/, "");
      if (u) return `<a class="m-plat-link" href="https://t.me/${escapeHtml(u)}" target="_blank" rel="noopener">@${escapeHtml(u)}</a>`;
      if (profile.tg_id) return `<span class="m-plat-noid">TG id ${escapeHtml(profile.tg_id)}</span>`;
    }
    if (kind === "vk") {
      const u = (profile.vk_screen_name || "").replace(/^@/, "");
      if (u) return `<a class="m-plat-link" href="https://vk.com/${escapeHtml(u)}" target="_blank" rel="noopener">${escapeHtml(u)}</a>`;
      if (profile.vk_id) return `<a class="m-plat-link" href="https://vk.com/id${escapeHtml(profile.vk_id)}" target="_blank" rel="noopener">id${escapeHtml(profile.vk_id)}</a>`;
    }
    return "";
  }

  // Маппинг технических ключей профиля → читаемые подписи (для expand).
  const FIELD_LABELS = {
    display_name:    "Отображаемое имя",
    game_nick:       "Игровые ники",
    tg_id:           "TG · ID",
    tg_username:     "TG · @username",
    tg_first_name:   "TG · Имя",
    tg_last_name:    "TG · Фамилия",
    tg_display:      "TG · Полное имя",
    vk_id:           "VK · ID",
    vk_screen_name:  "VK · screen_name",
    vk_first:        "VK · Имя",
    vk_last:         "VK · Фамилия",
    vk_display:      "VK · Полное имя",
    is_active:       "Активен",
  };

  function renderProfileDetails(p) {
    const rows = [];
    for (const [k, label] of Object.entries(FIELD_LABELS)) {
      const v = p[k];
      if (v === undefined || v === null || v === "" || v === 0) continue;
      let val = String(v);
      // Делаем кликабельным TG @ и VK screen_name
      if (k === "tg_username" && val) {
        const u = val.replace(/^@/, "");
        val = `<a class="m-plat-link" href="https://t.me/${escapeHtml(u)}" target="_blank" rel="noopener">@${escapeHtml(u)}</a>`;
      } else if (k === "vk_screen_name" && val) {
        const u = val.replace(/^@/, "");
        val = `<a class="m-plat-link" href="https://vk.com/${escapeHtml(u)}" target="_blank" rel="noopener">${escapeHtml(u)}</a>`;
      } else if (k === "vk_id" && val) {
        val = `<a class="m-plat-link" href="https://vk.com/id${escapeHtml(val)}" target="_blank" rel="noopener">id${escapeHtml(val)}</a>`;
      } else if (k === "is_active") {
        val = v ? "<span style='color:var(--accent)'>да</span>"
                : "<span style='color:#ff8080'>нет</span>";
      } else {
        val = escapeHtml(val);
      }
      rows.push(`<dt>${escapeHtml(label)}</dt><dd>${val}</dd>`);
    }
    if (!rows.length) {
      return `<div class="m-details-empty">Нет дополнительных данных</div>`;
    }
    return `<dl class="m-details">${rows.join("")}</dl>`;
  }

  function renderMemberRow(item) {
    const p = item.profile || {};
    const s = item.stats || {};
    const dn = p.display_name || p.game_nick || p.vk_display || p.tg_display
             || `(${item.key})`;
    const subs = [];
    if (p.game_nick && p.game_nick !== dn) subs.push(`<span class="m-game">${escapeHtml(p.game_nick)}</span>`);
    const tg = platformLink("tg", p);
    const vk = platformLink("vk", p);
    if (tg) subs.push(`<span class="m-plat">TG ${tg}</span>`);
    if (vk) subs.push(`<span class="m-plat">VK ${vk}</span>`);
    const nameBlock = `
      <div class="m-name"><span class="m-expand-icon">▸</span> ${escapeHtml(dn)}</div>
      ${subs.length ? `<div class="m-sub">${subs.join(" · ")}</div>` : ""}
    `;
    const total = s.msgs || 0;
    const period = (s.first_seen || s.last_seen)
      ? `<span class="m-period">${fmtDate(s.first_seen)}<br>${fmtDate(s.last_seen)}</span>`
      : `<span class="m-period m-period-empty">—</span>`;
    const detailsHtml = renderProfileDetails(p);
    return `
      <tr class="m-row${total ? "" : " m-row-silent"}" data-key="${escapeHtml(item.key)}">
        <td class="m-cell-name">${nameBlock}</td>
        <td class="m-cell-num m-cell-total">${fmtNum(total)}</td>
        <td class="m-cell-num">${fmtNum(s.msgs_general)}</td>
        <td class="m-cell-num">${fmtNum(s.msgs_officers)}</td>
        <td class="m-cell-num">${fmtNum(s.chars)}</td>
        <td class="m-cell-num">${fmtNum(s.media)}</td>
        <td class="m-cell-act">${renderSparkline(s.weeks)}</td>
        <td class="m-cell-time">${period}</td>
      </tr>
      <tr class="m-row-details" data-for="${escapeHtml(item.key)}" hidden>
        <td colspan="8">${detailsHtml}</td>
      </tr>
    `;
  }

  // ── Сортировка ─────────────────────────────────────────────────────
  const SORT_FNS = {
    name:          x => (x.profile.display_name
                       || x.profile.game_nick || x.key || "").toLowerCase(),
    msgs_total:    x => x.stats.msgs || 0,
    msgs_general:  x => x.stats.msgs_general || 0,
    msgs_officers: x => x.stats.msgs_officers || 0,
    chars:         x => x.stats.chars || 0,
    media:         x => x.stats.media || 0,
    last_seen:     x => x.stats.last_seen || "",
  };
  let currentSort = { key: "msgs_total", dir: "desc" };

  function sortItems(items) {
    const f = SORT_FNS[currentSort.key];
    const sign = currentSort.dir === "asc" ? 1 : -1;
    items.sort((a, b) => {
      const va = f(a), vb = f(b);
      if (va < vb) return -1 * sign;
      if (va > vb) return  1 * sign;
      return 0;
    });
  }

  // ── State ──────────────────────────────────────────────────────────
  let allItems = [];

  function applyFilterAndRender() {
    const q = ($("members-filter").value || "").trim().toLowerCase();
    let items = allItems;
    if (q) {
      items = allItems.filter(it => {
        const p = it.profile || {};
        const hay = [
          p.display_name, p.game_nick, p.vk_display, p.vk_first, p.vk_last,
          p.vk_screen_name, p.tg_username, p.tg_first_name, p.tg_last_name,
          p.tg_display, it.key,
        ].join(" ").toLowerCase();
        return hay.indexOf(q) >= 0;
      });
    }
    items = items.slice();
    sortItems(items);
    $("members-tbody").innerHTML = items.map(renderMemberRow).join("");
    $("members-empty").hidden = items.length > 0;
    // Стрелки сортировки в заголовке
    document.querySelectorAll(".members-table th[data-sort]").forEach(th => {
      th.classList.remove("sort-asc", "sort-desc");
      if (th.dataset.sort === currentSort.key) {
        th.classList.add(currentSort.dir === "asc" ? "sort-asc" : "sort-desc");
      }
    });
  }

  function updateOverallStats() {
    const totalMembers = allItems.length;
    const totalMsgs = allItems.reduce((a, x) => a + (x.stats.msgs || 0), 0);
    const active = allItems.filter(x => (x.stats.msgs || 0) > 0).length;
    const chars  = allItems.reduce((a, x) => a + (x.stats.chars || 0), 0);
    const media  = allItems.reduce((a, x) => a + (x.stats.media || 0), 0);
    $("members-stats").innerHTML = `
      <span>зарегистрировано: <b>${totalMembers}</b></span>
      <span>писали в чате: <b>${active}</b></span>
      <span>всего сообщений: <b>${fmtNum(totalMsgs)}</b></span>
      <span>символов: <b>${fmtNum(chars)}</b></span>
      <span>медиа: <b>${fmtNum(media)}</b></span>
    `;
  }

  // ── Events ─────────────────────────────────────────────────────────
  document.querySelectorAll(".members-table th[data-sort]").forEach(th => {
    th.addEventListener("click", () => {
      const k = th.dataset.sort;
      if (currentSort.key === k) {
        currentSort.dir = currentSort.dir === "asc" ? "desc" : "asc";
      } else {
        currentSort.key = k;
        // Имя — по возрастанию по умолчанию, числовые — по убыванию.
        currentSort.dir = (k === "name") ? "asc" : "desc";
      }
      applyFilterAndRender();
    });
  });

  let filterTimer = null;
  $("members-filter").addEventListener("input", () => {
    if (filterTimer) clearTimeout(filterTimer);
    filterTimer = setTimeout(applyFilterAndRender, 150);
  });

  // Раскрытие полных данных профиля по клику на строку.
  document.getElementById("members-tbody").addEventListener("click", (ev) => {
    // Игнорируем клики по ссылкам (TG/VK) — они открывают новые вкладки.
    if (ev.target.closest("a")) return;
    const row = ev.target.closest("tr.m-row");
    if (!row) return;
    const key = row.dataset.key;
    if (!key) return;
    const det = document.querySelector(
      `tr.m-row-details[data-for="${CSS.escape(key)}"]`);
    if (!det) return;
    const open = !det.hidden;
    det.hidden = open;
    row.classList.toggle("m-row-open", !open);
  });

  // ── Load ───────────────────────────────────────────────────────────
  $("members-loading").hidden = false;
  try {
    allItems = await API.chatMembersActivity();
    updateOverallStats();
    applyFilterAndRender();
  } catch (e) {
    $("members-tbody").innerHTML =
      `<tr><td colspan="8" class="m-error">Ошибка загрузки: ${escapeHtml(e.detail || e.message)}</td></tr>`;
  } finally {
    $("members-loading").hidden = true;
  }
})();
