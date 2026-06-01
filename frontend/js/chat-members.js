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

  // Маппинг технических ключей профиля → читаемые подписи. Сгруппирован
  // по платформам, чтобы можно было отрисовать «карточки» с аватаркой
  // справа от данных.
  const TG_FIELDS = {
    tg_id:           "ID",
    tg_username:     "@username",
    tg_first_name:   "Имя",
    tg_last_name:    "Фамилия",
    tg_display:      "Полное имя",
  };
  const VK_FIELDS = {
    vk_id:           "ID",
    vk_screen_name:  "screen_name",
    vk_first:        "Имя",
    vk_last:         "Фамилия",
    vk_display:      "Полное имя",
  };
  const OTHER_FIELDS = {
    game_nick:       "Игровые ники",
    display_name:    "Отображаемое имя",
    is_active:       "Активен",
  };

  function _fmtRow(k, v) {
    let val = String(v);
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
    return val;
  }

  function _rowsHtml(p, labelsMap) {
    const out = [];
    for (const [k, label] of Object.entries(labelsMap)) {
      const v = p[k];
      if (v === undefined || v === null || v === "" || v === 0) continue;
      out.push(`<dt>${escapeHtml(label)}</dt><dd>${_fmtRow(k, v)}</dd>`);
    }
    return out;
  }

  // Аватарка: src берётся из R2 (см. clan-reg-bot/refresh_avatars.py),
  // cache-bust через ?v={updated_at}. Если URL пуст — плейсхолдер с
  // первой буквой ника (платформа в подсказке).
  function _avatarHtml(url, updated, platform, fallbackChar) {
    if (url) {
      const bust = updated
        ? "?v=" + encodeURIComponent(updated.slice(0, 19))
        : "";
      return `<img class="m-avatar m-avatar-${platform}"
                   src="${escapeHtml(url)}${bust}"
                   alt="${platform.toUpperCase()} avatar"
                   loading="lazy"
                   onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
              <span class="m-avatar m-avatar-${platform} m-avatar-placeholder"
                    style="display:none">${escapeHtml(fallbackChar)}</span>`;
    }
    return `<span class="m-avatar m-avatar-${platform} m-avatar-placeholder"
                  title="Нет аватарки">${escapeHtml(fallbackChar)}</span>`;
  }

  function renderProfileDetails(p) {
    const sections = [];

    const otherRows = _rowsHtml(p, OTHER_FIELDS);
    if (otherRows.length) {
      sections.push(
        `<div class="m-details-section m-section-other">
           <dl>${otherRows.join("")}</dl>
         </div>`
      );
    }

    const tgRows = _rowsHtml(p, TG_FIELDS);
    if (tgRows.length || p.tg_avatar_url) {
      const fb = ((p.tg_first_name || p.tg_username || "T").trim().charAt(0) || "T").toUpperCase();
      sections.push(
        `<div class="m-details-section m-section-tg">
           ${_avatarHtml(p.tg_avatar_url, p.tg_avatar_updated, "tg", fb)}
           <dl>${tgRows.join("") || "<dt>Telegram</dt><dd>—</dd>"}</dl>
         </div>`
      );
    }

    const vkRows = _rowsHtml(p, VK_FIELDS);
    if (vkRows.length || p.vk_avatar_url) {
      const fb = ((p.vk_first || p.vk_screen_name || "V").trim().charAt(0) || "V").toUpperCase();
      sections.push(
        `<div class="m-details-section m-section-vk">
           ${_avatarHtml(p.vk_avatar_url, p.vk_avatar_updated, "vk", fb)}
           <dl>${vkRows.join("") || "<dt>VK</dt><dd>—</dd>"}</dl>
         </div>`
      );
    }

    if (!sections.length) {
      return `<div class="m-details-empty">Нет дополнительных данных</div>`;
    }
    return `<div class="m-details">${sections.join("")}</div>`;
  }

  function renderTrend(trend) {
    if (!trend || trend.direction === null || trend.direction === undefined) {
      return `<span class="m-trend m-trend-none" title="Недостаточно данных для сравнения">—</span>`;
    }
    const d = trend.direction;
    const pct = trend.pct;
    const arrow = d === "up"   ? "▲"
                : d === "down" ? "▼"
                : d === "new"  ? "★"
                : d === "dead" ? "✕"
                : "▬";
    let label;
    if (d === "new")       label = "★ new";
    else if (d === "dead") label = "✕ -100%";
    else                   label = `${arrow} ${pct > 0 ? "+" : ""}${pct}%`;

    // Полный tooltip: PoP + регрессия + R²
    const parts = [];
    if (d === "new") {
      parts.push(`Раньше молчал, недавно: ${trend.second_half} сообщ.`);
    } else if (d === "dead") {
      parts.push(`Было ${trend.first_half} сообщ., сейчас 0`);
    } else {
      parts.push(`PoP (вторая/первая половина): ${trend.first_half} → ${trend.second_half} сообщ.`);
    }
    if (trend.slope_pct !== null && trend.slope_pct !== undefined) {
      const sp = trend.slope_pct;
      parts.push(`Slope: ${sp > 0 ? "+" : ""}${sp}% за период`);
    }
    if (trend.r_squared !== null && trend.r_squared !== undefined) {
      const r2 = trend.r_squared;
      const conf = r2 >= 0.5 ? "сильный" : r2 >= 0.15 ? "умеренный" : "шумный";
      parts.push(`R² = ${r2} (${conf} тренд)`);
    }
    if (trend.recent_pct !== null && trend.recent_pct !== undefined
        && trend.recent_window) {
      const w = trend.recent_window;
      const label = w === 1 ? "Последний период" : `Последние ${w}`;
      parts.push(`${label}: ${trend.recent_pct > 0 ? "+" : ""}${trend.recent_pct}% (${trend.recent_direction})`);
    } else if (trend.recent_direction === "dead") {
      parts.push(`Последний период: затихли`);
    } else if (trend.recent_direction === "new") {
      parts.push(`Последний всплеск`);
    }
    return `<span class="m-trend m-trend-${d}" title="${escapeHtml(parts.join("\n"))}">${label}</span>`;
  }

  // Имя участника для UI с приоритетом игрового ника, согласовано с
  // backend _primary_display_name. game_nick первым: в клане людей
  // знают по нику, не по @username.
  function primaryName(p, fallbackKey) {
    const gn = (p.game_nick || "").trim();
    if (gn) {
      const first = gn.split(",")[0].trim();
      if (first) return first;
    }
    for (const f of ["display_name", "vk_display", "tg_display",
                     "tg_username", "vk_screen_name"]) {
      const v = (p[f] || "").trim();
      if (v) return v;
    }
    return fallbackKey || "(без имени)";
  }

  // ── Valor combined cells ──────────────────────────────────────────
  let VALOR_MAP = {};  // canon → {valor, norm_pct, compliance, ...}

  function pctClass(pct) {
    if (pct >= 100) return "norm-good";
    if (pct >=  80) return "norm-p80";
    if (pct >=  60) return "norm-p60";
    if (pct >=  40) return "norm-p40";
    if (pct >=  20) return "norm-p20";
    return "norm-p0";
  }

  function nickCanon(s) {
    return (s || "").toString().toLowerCase()
      .replace(/[\s\W_]+/gu, "");
  }

  function lookupValor(item) {
    const p = item.profile || {};
    // Пробуем разные ники в порядке: основной display, game_nick parts,
    // username и др. Первый что найдём в VALOR_MAP — берём.
    const candidates = [];
    const dn = (p.game_nick || "").split(",").map(s => s.trim());
    for (const x of dn) if (x) candidates.push(x);
    if (p.display_name) candidates.push(p.display_name);
    for (const c of candidates) {
      const cn = nickCanon(c);
      if (cn && VALOR_MAP[cn]) return VALOR_MAP[cn];
    }
    return null;
  }

  function renderValorCells(item) {
    const v = lookupValor(item);
    if (!v) {
      return `<td class="m-cell-num valor-col"><span style="color:#555">—</span></td>
              <td class="m-cell-num valor-col"><span style="color:#555">—</span></td>
              <td class="m-cell-num valor-col"><span style="color:#555">—</span></td>`;
    }
    // Норматив тек. недели
    let normCell;
    if (v.is_afk) {
      normCell = `<span class="norm-cell norm-afk">АФК</span>`;
    } else if (v.norm_pct == null) {
      normCell = `<span style="color:#888">?</span>`;
    } else {
      normCell = `<span class="norm-cell ${pctClass(v.norm_pct)}"
        title="доблесть текущей недели">${v.norm_pct}%</span>`;
    }
    // Compliance
    const c = v.compliance;
    const compCell = c
      ? `<span class="norm-cell ${pctClass(c.avg_pct)}"
          title="${c.weeks_met}/${c.weeks_count} недель с полным выполнением"
          >${c.avg_pct}% <small style="opacity:0.7">${c.weeks_met}/${c.weeks_count}</small></span>`
      : `<span style="color:#555">—</span>`;
    // Valor
    const valorCell = v.valor != null
      ? `<b>${v.valor}</b>`
      : `<span style="color:#888">—</span>`;
    return `<td class="m-cell-num valor-col">${normCell}</td>
            <td class="m-cell-num valor-col">${compCell}</td>
            <td class="m-cell-num valor-col">${valorCell}</td>`;
  }

  async function loadValorMap() {
    try {
      const weeks = +$("vc-weeks").value || 0;
      VALOR_MAP = await API.valorByCanon(weeks);
    } catch (e) {
      VALOR_MAP = {};
    }
    applyFilterAndRender();
  }

  $("vc-toggle").addEventListener("change", async (e) => {
    if (e.target.checked) {
      document.body.classList.add("show-valor");
      $("vc-weeks-wrap").style.display = "";
      await loadValorMap();
    } else {
      document.body.classList.remove("show-valor");
      $("vc-weeks-wrap").style.display = "none";
    }
  });
  $("vc-weeks").addEventListener("change", () => {
    if ($("vc-toggle").checked) loadValorMap();
  });

  function renderMemberRow(item, idx) {
    const p = item.profile || {};
    const s = item.stats || {};
    const dn = primaryName(p, item.key);
    // Подпись под именем: остальные ники из game_nick (если их несколько
    // через запятую — показываем тех что не вошли в primary) и
    // display_name если он отличается И НЕ дублирует @tg_username
    // или vk_screen_name (часто display_name = "@darkero4ek", а
    // дальше всё равно идёт TG @darkero4ek — не нужно повторять).
    const subs = [];
    const gnAll = (p.game_nick || "").trim();
    if (gnAll && gnAll.indexOf(",") >= 0) {
      subs.push(`<span class="m-game">${escapeHtml(gnAll)}</span>`);
    }
    const dnStripped = (p.display_name || "").replace(/^@/, "").trim().toLowerCase();
    const tgU = (p.tg_username || "").replace(/^@/, "").trim().toLowerCase();
    const vkS = (p.vk_screen_name || "").replace(/^@/, "").trim().toLowerCase();
    const dnDuplicatesPlatform = dnStripped
      && (dnStripped === tgU || dnStripped === vkS);
    if (p.display_name
        && p.display_name !== dn
        && p.display_name !== gnAll
        && !dnDuplicatesPlatform) {
      subs.push(`<span class="m-game">${escapeHtml(p.display_name)}</span>`);
    }
    const tg = platformLink("tg", p);
    const vk = platformLink("vk", p);
    if (tg) subs.push(`<span class="m-plat">TG ${tg}</span>`);
    if (vk) subs.push(`<span class="m-plat">VK ${vk}</span>`);
    let statusBadge = "";
    if (item.unregistered) {
      statusBadge = `<span class="m-status-unreg" title="Пишет в чатах, но через /reg в боте не регистрировался. Когда зарегистрируется — статистика автоматически объединится с его игровым ником.">без регистрации</span>`;
    } else if (item.is_active === false) {
      statusBadge = `<span class="m-status-out" title="Покинули все клановые чаты (TG и VK). Запись хранится в архиве для истории сообщений.">вне чатов</span>`;
    }
    const nameBlock = `
      <div class="m-name-row">
        <div class="m-name"><span class="m-expand-icon">▸</span> ${escapeHtml(dn)}</div>
        ${statusBadge}
      </div>
      ${subs.length ? `<div class="m-sub">${subs.join(" · ")}</div>` : ""}
    `;
    const total = s.msgs || 0;
    const period = (s.first_seen || s.last_seen)
      ? `<span class="m-period">${fmtDate(s.first_seen)}<br>${fmtDate(s.last_seen)}</span>`
      : `<span class="m-period m-period-empty">—</span>`;
    const detailsHtml = renderProfileDetails(p);
    const idxNum = (typeof idx === "number" ? idx + 1 : "");
    // Подсветка-«молчун»: 0 сообщений в архиве. Чаще всего это
    // MANUAL-регистрация через GUI (key начинается с manual_) —
    // админ занёс ник вручную, юзер сам в чатах не писал ИЛИ его
    // tg_id/vk_id указан админом неточно и не матчится с сообщениями.
    // Tooltip объясняет это, чтобы офицер не думал что баг.
    const isManual = (item.key || "").startsWith("manual_");
    const silentTitle = total ? "" : (isManual
      ? "Ни одного сообщения в архиве. Запись добавлена админом через GUI (manual_*) — возможно tg_id/vk_id указан неточно или человек реально не пишет в чатах."
      : "Ни одного сообщения в архиве за всё время сбора (TG с 13.04.2026, VK с 29.03.2026).");
    const rowClasses = "m-row"
      + (total ? "" : " m-row-silent")
      + (item.is_active === false ? " m-row-left" : "")
      + (item.unregistered ? " m-row-unreg" : "");
    return `
      <tr class="${rowClasses}"
          data-key="${escapeHtml(item.key)}"${silentTitle ? ` title="${escapeHtml(silentTitle)}"` : ""}>
        <td class="m-cell-idx">${idxNum}</td>
        <td class="m-cell-name">${nameBlock}</td>
        <td class="m-cell-num m-cell-total">${fmtNum(total)}</td>
        <td class="m-cell-num">${fmtNum(s.msgs_general)}</td>
        <td class="m-cell-num">${fmtNum(s.msgs_officers)}</td>
        <td class="m-cell-num">${fmtNum(s.chars)}</td>
        <td class="m-cell-num">${fmtNum(s.media)}</td>
        <td class="m-cell-act">${renderSparkline(s.weeks)}</td>
        <td class="m-cell-trend">${renderTrend(s.trend)}</td>
        <td class="m-cell-time">${period}</td>
        ${renderValorCells(item)}
      </tr>
      <tr class="m-row-details" data-for="${escapeHtml(item.key)}" hidden>
        <td colspan="13">${detailsHtml}</td>
      </tr>
    `;
  }

  // ── Сортировка ─────────────────────────────────────────────────────
  const SORT_FNS = {
    name:          x => primaryName(x.profile, x.key).toLowerCase(),
    msgs_total:    x => x.stats.msgs || 0,
    msgs_general:  x => x.stats.msgs_general || 0,
    msgs_officers: x => x.stats.msgs_officers || 0,
    chars:         x => x.stats.chars || 0,
    media:         x => x.stats.media || 0,
    last_seen:     x => x.stats.last_seen || "",
    trend:         x => {
      const t = x.stats.trend;
      if (!t || t.pct === null || t.pct === undefined) return -1e9;
      return t.pct;
    },
    vc_norm:       x => {
      const v = lookupValor(x);
      if (!v) return -1;
      return v.norm_pct == null ? -1 : v.norm_pct;
    },
    vc_compliance: x => {
      const v = lookupValor(x);
      return v && v.compliance ? v.compliance.avg_pct : -1;
    },
    vc_valor:      x => {
      const v = lookupValor(x);
      return v && v.valor != null ? v.valor : -1;
    },
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
    const hideLeft = $("members-hide-left").checked;
    let items = allItems;
    if (hideLeft) {
      items = items.filter(it => it.is_active !== false);
    }
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
    $("members-tbody").innerHTML = items
      .map((it, i) => renderMemberRow(it, i)).join("");
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
    const registered   = allItems.filter(x => !x.unregistered);
    const unregistered = allItems.filter(x =>  x.unregistered);
    const totalMembers = registered.length;
    const totalMsgs = allItems.reduce((a, x) => a + (x.stats.msgs || 0), 0);
    const active = allItems.filter(x => (x.stats.msgs || 0) > 0).length;
    const chars  = allItems.reduce((a, x) => a + (x.stats.chars || 0), 0);
    const media  = allItems.reduce((a, x) => a + (x.stats.media || 0), 0);
    const nLeft = registered.filter(x => x.is_active === false).length;
    const unregBadge = unregistered.length
      ? `<span title="Пишут в чатах, но через /reg в боте не зарегистрированы. Учитываются в общих числах ниже.">без рег.: <b>${unregistered.length}</b></span>`
      : "";
    $("members-stats").innerHTML = `
      <span>зарегистрировано: <b>${totalMembers}</b></span>
      ${unregBadge}
      <span>писали в чате: <b>${active}</b></span>
      <span>всего сообщений: <b>${fmtNum(totalMsgs)}</b></span>
      <span>символов: <b>${fmtNum(chars)}</b></span>
      <span>медиа: <b>${fmtNum(media)}</b></span>
    `;
    updateHideLeftControl("members-hide-left",
                         "members-left-count",
                         "members-hide-left-wrap",
                         nLeft);
  }

  // Обновляет label/счётчик/disabled чекбокса «скрыть ушедших».
  // Если ушедших нет — чекбокс выключен с поясняющим title.
  function updateHideLeftControl(checkboxId, countId, wrapId, nLeft) {
    const cb  = $(checkboxId);
    const cnt = $(countId);
    const wrap = $(wrapId);
    if (!cb || !cnt || !wrap) return;
    if (nLeft > 0) {
      cnt.textContent = `(${nLeft})`;
      cb.disabled = false;
      wrap.classList.remove("hide-left-disabled");
      wrap.title = `Скрыть ${nLeft} ушедших из выборки`;
    } else {
      cnt.textContent = "(0)";
      cb.disabled = true;
      cb.checked = false;
      wrap.classList.add("hide-left-disabled");
      wrap.title = "Сейчас никого с пометкой «ушёл» нет. " +
        "Запусти clan-reg-bot/reconcile_membership.py --apply " +
        "чтобы обновить статусы.";
    }
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
  $("members-hide-left").addEventListener("change", applyFilterAndRender);

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
      `<tr><td colspan="13" class="m-error">Ошибка загрузки: ${escapeHtml(e.detail || e.message)}</td></tr>`;
  } finally {
    $("members-loading").hidden = true;
  }

  // ────────────────────────────────────────────────────────────────────
  // Timeline активности — большой график внизу страницы.
  // ────────────────────────────────────────────────────────────────────

  // Палитра 24 различимых цветов (HSL равномерно, насыщенность 70%,
  // светлота 60% — хорошо видно на тёмном фоне).
  const PALETTE = (() => {
    const out = [];
    for (let i = 0; i < 24; i++) {
      out.push(`hsl(${Math.round((i * 360) / 24)}, 70%, 60%)`);
    }
    return out;
  })();
  function colorFor(idx) { return PALETTE[idx % PALETTE.length]; }

  // Локальное состояние timeline
  const TL = {
    chart: null,
    raw: null,           // {granularity, periods, series}
    visibleKeys: new Set(),
    soloKey: null,
    mode: "stacked",
    topN: 10,
    filter: "",
  };

  function fmtPeriodLabel(p, granularity) {
    if (granularity === "week") {
      const m = p.match(/(\d{4})-W(\d{1,2})/);
      if (m) return `${m[1]} нед.${m[2]}`;
      return p;
    }
    if (granularity === "month") {
      const m = p.match(/(\d{4})-(\d{2})/);
      if (m) {
        const months = ["янв","фев","мар","апр","май","июн",
                        "июл","авг","сен","окт","ноя","дек"];
        return `${months[+m[2]-1]} ${m[1]}`;
      }
    }
    return p;
  }

  function visibleSeries() {
    if (!TL.raw) return [];
    let s = TL.raw.series;
    if (TL.filter) {
      const q = TL.filter.toLowerCase();
      s = s.filter(x => x.name.toLowerCase().indexOf(q) >= 0);
    }
    if (TL.topN > 0) s = s.slice(0, TL.topN);
    return s;
  }

  function buildDatasets() {
    if (!TL.raw) return [];
    const all = visibleSeries();
    let chosen;
    if (TL.mode === "solo" && TL.soloKey) {
      chosen = all.filter(s => s.key === TL.soloKey);
    } else {
      chosen = all.filter(s => TL.visibleKeys.has(s.key));
    }
    return chosen.map((s, i) => ({
      label: s.name,
      data: s.counts,
      borderColor: colorFor(allSeriesIndex(s.key)),
      backgroundColor: TL.mode === "stacked"
        ? colorFor(allSeriesIndex(s.key)).replace("hsl", "hsla").replace(")", ", 0.55)")
        : "transparent",
      borderWidth: TL.mode === "stacked" ? 1 : 2,
      pointRadius: 0,
      pointHoverRadius: 4,
      fill: TL.mode === "stacked",
      tension: 0.25,
      _key: s.key,
    }));
  }

  // Индекс серии в полном списке (для стабильного цвета даже после
  // фильтрации и toggle).
  function allSeriesIndex(key) {
    if (!TL.raw) return 0;
    return TL.raw.series.findIndex(s => s.key === key);
  }

  function renderTrendBig(trend) {
    if (!trend || trend.direction === null || trend.direction === undefined) {
      return "";
    }
    const d = trend.direction;
    const pct = trend.pct;

    // 7 уровней силы + 2 особых случая (new/dead).
    // Эмодзи и формулировка по фактической величине pct, не только
    // по direction (up/down/flat — бинарные).
    let emoji, word, level, pctText;
    if (d === "new") {
      emoji = "⭐"; word = "новые активные участники"; level = "new";
      pctText = "★";
    } else if (d === "dead") {
      emoji = "💀"; word = "чат вымер"; level = "down";
      pctText = "−100%";
    } else if (pct >= 50) {
      emoji = "🚀"; word = "чат бурлит — клан оживает!"; level = "up";
      pctText = "+" + pct + "%";
    } else if (pct >= 15) {
      emoji = "📈"; word = "активность растёт"; level = "up";
      pctText = "+" + pct + "%";
    } else if (pct > 5) {
      emoji = "🔼"; word = "лёгкий подъём"; level = "up";
      pctText = "+" + pct + "%";
    } else if (pct >= -5) {
      emoji = "⚖️"; word = "ровный фон — стабильно"; level = "flat";
      pctText = (pct > 0 ? "+" : "") + pct + "%";
    } else if (pct > -15) {
      emoji = "🔽"; word = "лёгкий спад"; level = "down";
      pctText = pct + "%";
    } else if (pct > -50) {
      emoji = "📉"; word = "активность падает"; level = "down";
      pctText = pct + "%";
    } else {
      emoji = "💤"; word = "чат затихает — может угаснуть"; level = "down";
      pctText = pct + "%";
    }

    const arrow = level === "up" ? "▲"
                : level === "down" ? "▼"
                : level === "new" ? "★" : "▬";
    // Расширенный tooltip с обеими метриками
    const tipParts = [];
    if (d === "new") {
      tipParts.push(`Раньше клан молчал, недавно: ${trend.second_half} сообщений`);
    } else if (d === "dead") {
      tipParts.push(`Было ${trend.first_half} сообщений, сейчас 0`);
    } else {
      tipParts.push(`Общий PoP: ${trend.first_half} → ${trend.second_half}`);
    }
    if (trend.slope_pct !== null && trend.slope_pct !== undefined) {
      tipParts.push(`Slope (наклон линии): ${trend.slope_pct > 0 ? "+" : ""}${trend.slope_pct}% за период`);
    }
    if (trend.r_squared !== null && trend.r_squared !== undefined) {
      const r2 = trend.r_squared;
      const conf = r2 >= 0.5 ? "сильный" : r2 >= 0.15 ? "умеренный" : "шумный";
      tipParts.push(`R² = ${r2} (${conf} тренд)`);
    }
    if (trend.recent_pct !== null && trend.recent_pct !== undefined
        && trend.recent_window) {
      const rsign = trend.recent_pct > 0 ? "+" : "";
      const w = trend.recent_window;
      const label = w === 1 ? "Последний период" : `Последние ${w} периодов`;
      tipParts.push(`${label}: ${rsign}${trend.recent_pct}% (${trend.recent_direction})`);
    } else if (trend.recent_direction === "new") {
      tipParts.push(`Последний всплеск (был молчок)`);
    } else if (trend.recent_direction === "dead") {
      tipParts.push(`Последний период: затихли`);
    }

    // Предупреждение: общий тренд up, но недавний down (и наоборот)
    let warning = "";
    if (trend.recent_direction
        && trend.recent_direction !== d
        && (d === "up" || d === "down")
        && (trend.recent_direction === "up"
            || trend.recent_direction === "down"
            || trend.recent_direction === "dead")) {
      if (trend.recent_direction === "down" || trend.recent_direction === "dead") {
        warning = ` <span class="tl-trend-warn" title="${escapeHtml(
          "Общий тренд позитивный, но в недавних периодах активность снижается. Сигнал ранне-угасания."
        )}">⚠ но сейчас ▼ ${trend.recent_pct}%</span>`;
      } else if (trend.recent_direction === "up") {
        warning = ` <span class="tl-trend-warn tl-trend-warn-up" title="${escapeHtml(
          "Общий тренд негативный, но в недавних периодах рост — возможно восстановление."
        )}">⚡ но сейчас ▲ +${trend.recent_pct}%</span>`;
      }
    }

    return `<span class="tl-trend-big tl-trend-${level}"
                  title="${escapeHtml(tipParts.join("\n"))}">
              <b>тренд:</b> ${arrow} ${pctText}
              <span class="tl-trend-emoji">${emoji}</span>
              <i>${word}</i>${warning}
            </span>`;
  }

  function renderTrendSmall(trend) {
    if (!trend || trend.direction === null || trend.direction === undefined) return "";
    const d = trend.direction;
    const arrow = d === "up"   ? "▲"
                : d === "down" ? "▼"
                : d === "new"  ? "★"
                : d === "dead" ? "✕" : "▬";
    let text;
    if (d === "new")       text = "new";
    else if (d === "dead") text = "-100%";
    else                   text = (trend.pct > 0 ? "+" : "") + trend.pct + "%";
    return ` <span class="tl-trend-mini tl-trend-${d}">${arrow}${text}</span>`;
  }

  function renderLegend() {
    if (!TL.raw) return;
    const container = $("timeline-legend");
    const all = visibleSeries();
    const html = all.map(s => {
      const idx = allSeriesIndex(s.key);
      const visible = TL.mode === "solo"
        ? (TL.soloKey === s.key)
        : TL.visibleKeys.has(s.key);
      const leftMark = s.is_active === false
        ? ` <span class="tl-legend-left" title="Покинул все клановые чаты">🚪</span>` : "";
      return `<span class="tl-legend-item${visible ? "" : " tl-legend-off"}${s.is_active === false ? " tl-legend-leaver" : ""}"
                    data-key="${escapeHtml(s.key)}">
                <span class="tl-legend-dot" style="background:${colorFor(idx)}"></span>
                ${escapeHtml(s.name)}${leftMark} <span class="tl-legend-total">${fmtNum(s.total)}</span>${renderTrendSmall(s.trend)}
              </span>`;
    }).join("");
    container.innerHTML = html;
  }

  function renderChart() {
    if (!TL.raw) return;
    const ctx = $("timeline-canvas").getContext("2d");
    if (TL.chart) { TL.chart.destroy(); TL.chart = null; }
    const labels = TL.raw.periods.map(p => fmtPeriodLabel(p, TL.raw.granularity));
    const datasets = buildDatasets();
    TL.chart = new Chart(ctx, {
      type: "line",
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },     // своя легенда
          tooltip: {
            backgroundColor: "rgba(0,0,0,0.92)",
            borderColor: "#00ff41",
            borderWidth: 1,
            titleColor: "#00ff41",
            bodyColor: "#cfd",
            callbacks: {
              title: (items) => items[0]?.label || "",
              label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y}`,
            },
          },
        },
        scales: {
          x: {
            ticks: { color: "#9aa", maxRotation: 60, minRotation: 30,
                     autoSkip: true, maxTicksLimit: 16 },
            grid:  { color: "rgba(0,255,65,0.05)" },
            stacked: TL.mode === "stacked",
          },
          y: {
            ticks: { color: "#9aa" },
            grid:  { color: "rgba(0,255,65,0.07)" },
            stacked: TL.mode === "stacked",
            beginAtZero: true,
          },
        },
      },
    });
  }

  async function loadTimeline() {
    const g = $("tl-granularity").value;
    const cg = $("tl-chat-group").value || null;
    const includeInactive = !$("tl-hide-left").checked;
    $("timeline-loading").hidden = false;
    try {
      const data = await API.chatMembersTimeline(g, cg, includeInactive);
      TL.raw = data;
      // По умолчанию показываем top-N. После смены фильтра топ
      // пересчитывается на сервере по нужному chat_group, потому что
      // series отсортированы по total в выбранном чате.
      const all = visibleSeries();
      TL.visibleKeys = new Set(all.map(s => s.key));
      if (!TL.soloKey && all.length) TL.soloKey = all[0].key;

      // Сводка + общий trend
      const totalMsgs = TL.raw.series.reduce((a, s) => a + s.total, 0);
      const period0 = TL.raw.periods[0] || "—";
      const periodN = TL.raw.periods[TL.raw.periods.length - 1] || "—";
      const overall = TL.raw.overall && TL.raw.overall.trend;
      const trendHtml = overall
        ? renderTrendBig(overall)
        : "";
      // Обновляем чекбокс «скрыть ушедших» на основании backend-счётчика
      updateHideLeftControl("tl-hide-left", "tl-left-count",
                            "tl-hide-left-wrap", TL.raw.inactive_count || 0);

      const chatLabel = TL.raw.chat_group === "general"  ? "только общий"
                      : TL.raw.chat_group === "officers" ? "только офицерский"
                      : "оба чата";
      const ts = new Date().toLocaleTimeString("ru-RU",
                  { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      $("timeline-stats").innerHTML = `
        <span>чат: <b>${escapeHtml(chatLabel)}</b></span>
        <span>период: <b>${escapeHtml(period0)} → ${escapeHtml(periodN)}</b></span>
        <span>всего сообщений: <b>${fmtNum(totalMsgs)}</b></span>
        <span>активных участников: <b>${TL.raw.series.length}</b></span>
        <span>интервалов: <b>${TL.raw.periods.length}</b></span>
        <span class="tl-stamp" title="Последнее обновление с сервера">обновлено в ${ts}</span>
        ${trendHtml}
      `;

      renderChart();
      renderLegend();
    } catch (e) {
      $("timeline-stats").innerHTML =
        `<span class="m-error">Ошибка: ${escapeHtml(e.detail || e.message)}</span>`;
    } finally {
      $("timeline-loading").hidden = true;
    }
  }

  // Events
  $("tl-granularity").addEventListener("change", () => {
    // При смене гранулярности сбрасываем solo-выбор: иначе можем
    // ссылаться на отсутствующий ключ.
    TL.soloKey = null;
    loadTimeline();
  });
  $("tl-chat-group").addEventListener("change", () => {
    // Смена чата = другой топ-актив, сбрасываем visible/solo.
    TL.soloKey = null;
    loadTimeline();
  });
  $("tl-refresh").addEventListener("click", () => {
    // Просто перезапрос с теми же параметрами — обновит timestamp
    // и подтянет любые новые сообщения с последнего загруза.
    loadTimeline();
  });
  $("tl-hide-left").addEventListener("change", () => {
    TL.soloKey = null;
    loadTimeline();
  });
  $("tl-mode").addEventListener("change", () => {
    TL.mode = $("tl-mode").value;
    renderChart();
    renderLegend();
  });
  $("tl-topn").addEventListener("change", () => {
    TL.topN = parseInt($("tl-topn").value, 10) || 0;
    // Обновляем visibleKeys для нового топа
    if (TL.raw) {
      const all = visibleSeries();
      TL.visibleKeys = new Set(all.map(s => s.key));
    }
    renderChart();
    renderLegend();
  });
  let tlFilterTimer = null;
  $("tl-filter").addEventListener("input", () => {
    if (tlFilterTimer) clearTimeout(tlFilterTimer);
    tlFilterTimer = setTimeout(() => {
      TL.filter = $("tl-filter").value.trim();
      if (TL.raw) {
        const all = visibleSeries();
        TL.visibleKeys = new Set(all.map(s => s.key));
        if (all.length && !all.find(s => s.key === TL.soloKey)) {
          TL.soloKey = all[0].key;
        }
      }
      renderChart();
      renderLegend();
    }, 200);
  });

  // Toggle участника в легенде
  $("timeline-legend").addEventListener("click", (ev) => {
    const item = ev.target.closest(".tl-legend-item");
    if (!item) return;
    const key = item.dataset.key;
    if (TL.mode === "solo") {
      TL.soloKey = key;
    } else {
      if (TL.visibleKeys.has(key)) TL.visibleKeys.delete(key);
      else TL.visibleKeys.add(key);
    }
    renderChart();
    renderLegend();
  });

  loadTimeline();
})();
