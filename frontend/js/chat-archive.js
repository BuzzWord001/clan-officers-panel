// Архив переписки TG/VK. Лента в обратном хронологическом порядке,
// фильтры (чат / даты в DD.MM.YYYY / автор / умный поиск), lazy-load
// по before_id, подсветка совпадений, админ-удаление сообщений.
(async function () {
  const $ = (id) => document.getElementById(id);
  const PAGE_SIZE = 80;

  let me;
  try {
    me = await API.me();
  } catch (_) {
    window.location.href = "login.html";
    return;
  }

  const isAdmin = me.role === "admin";
  const roleLabel = isAdmin ? "АДМИНИСТРАТОР"
                  : me.role === "officer" ? "ОФИЦЕР"
                  : me.role.toUpperCase();
  $("who").textContent = `${roleLabel} • ${me.name}`;
  // CSS-гейт: body[data-role=admin] показывает админ-элементы. У офицеров
  // тег отсутствует и .chat-admin-bar / .chat-msg-del скрыты `display:none`.
  document.body.setAttribute("data-role", me.role);
  if (isAdmin) {
    const tab = $("settings-tab");
    if (tab) tab.hidden = false;
    $("chat-admin-bar").hidden = false;
  }
  $("logout-btn").addEventListener("click", async () => {
    try { await API.logout(); } catch (_) {}
    window.location.href = "login.html";
  });

  // Текущий стек загруженных сообщений (новые сверху).
  let loaded = [];
  // Минимальный id страницы — для следующего before_id.
  let oldestId = null;
  // Максимальный id (самое свежее) — для auto-refresh after_id.
  let newestId = null;
  // Активные фильтры — фиксируем при «Поиск», чтобы load-more тянул ту же выборку.
  let activeFilters = {};
  // Термины для подсветки (только позитивы, без -минусов и без от:).
  let highlightTerms = [];
  // Set ID'шников новых сообщений за последний tick — для подсветки в ленте.
  let freshIds = new Set();

  // ─────────────── даты ───────────────

  function parseDateRu(s) {
    // Принимает DD.MM.YYYY, DD/MM/YYYY, DD-MM-YYYY (с цифрами или с
    // ведущими нулями). Возвращает YYYY-MM-DD или null.
    s = (s || "").trim();
    if (!s) return null;
    const m = s.match(/^(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{2,4})$/);
    if (!m) return null;
    let [_, d, mo, y] = m;
    d = d.padStart(2, "0");
    mo = mo.padStart(2, "0");
    if (y.length === 2) y = "20" + y;
    if (y.length !== 4) return null;
    const di = parseInt(d, 10), moi = parseInt(mo, 10), yi = parseInt(y, 10);
    if (di < 1 || di > 31 || moi < 1 || moi > 12 || yi < 2000 || yi > 2100) return null;
    return `${y}-${mo}-${d}`;
  }

  function fmtTs(iso) {
    if (!iso) return "";
    const d = new Date(iso.endsWith("Z") ? iso : iso + "Z");
    return d.toLocaleString("ru-RU", {
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  }

  // ─────────────── подсветка ───────────────

  function normForMatch(s) {
    return String(s || "").toLowerCase().replace(/ё/g, "е");
  }

  function extractHighlightTerms(query) {
    // Парсер должен быть симметричным с backend _build_fts_query, но
    // нам нужны только позитивные термины которые видны пользователю.
    // Извлекаем все токены, выкидываем минусы и от:/автор: префиксы для
    // выделения в основном тексте (их подсветим в авторе отдельно).
    const out = { text: [], author: [] };
    if (!query) return out;
    const re = /-?"[^"]+"\*?|-?\S+/g;
    let m;
    while ((m = re.exec(query)) !== null) {
      let tok = m[0];
      if (tok.startsWith("-")) continue;
      // column prefix
      let target = "text";
      const lc = tok.toLowerCase();
      const prefs = ["от:", "автор:", "author:", "from:"];
      for (const p of prefs) {
        if (lc.startsWith(p)) {
          target = "author";
          tok = tok.slice(p.length);
          break;
        }
      }
      if (tok.startsWith('"') && tok.endsWith('"') && tok.length >= 2) {
        tok = tok.slice(1, -1);
      }
      tok = tok.replace(/\*+$/, "").trim();
      if (tok) out[target].push(tok);
    }
    return out;
  }

  function highlight(escapedHtml, terms) {
    // Работаем по уже escapeHtml-нутой строке. Ищем по нормализованной
    // версии (ё→е, lower), но заменяем в оригинале, сохраняя регистр.
    if (!terms || !terms.length || !escapedHtml) return escapedHtml;
    const normHay = normForMatch(escapedHtml);
    // Подходящие сегменты: [{start, end}]
    const ranges = [];
    for (const t of terms) {
      const nt = normForMatch(t);
      if (!nt) continue;
      let idx = 0;
      while (true) {
        const found = normHay.indexOf(nt, idx);
        if (found < 0) break;
        ranges.push([found, found + nt.length]);
        idx = found + nt.length;
      }
    }
    if (!ranges.length) return escapedHtml;
    // Сливаем пересекающиеся
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [ranges[0]];
    for (let i = 1; i < ranges.length; i++) {
      const last = merged[merged.length - 1];
      if (ranges[i][0] <= last[1]) {
        last[1] = Math.max(last[1], ranges[i][1]);
      } else {
        merged.push(ranges[i]);
      }
    }
    // Собираем строку с <mark>
    let out = "";
    let cur = 0;
    for (const [a, b] of merged) {
      out += escapedHtml.slice(cur, a)
           + "<mark>" + escapedHtml.slice(a, b) + "</mark>";
      cur = b;
    }
    out += escapedHtml.slice(cur);
    return out;
  }

  // ─────────────── рендер ───────────────

  function platformBadge(p) {
    return p === "tg" ? "TG" : p === "vk" ? "VK" : p.toUpperCase();
  }

  // ─────────────── Author popover (наведение на ник) ───────────────
  // Кэш {display_name → profile|null} чтобы не дёргать API на каждое hover.
  const profileCache = new Map();
  let popoverEl = null;
  let popoverShowTimer = null;
  let popoverHideTimer = null;
  let popoverFor = null;   // имя для которого открыт текущий popover

  function ensurePopover() {
    if (popoverEl) return popoverEl;
    popoverEl = document.createElement("div");
    popoverEl.className = "chat-popover";
    popoverEl.hidden = true;
    popoverEl.addEventListener("mouseenter", () => {
      if (popoverHideTimer) { clearTimeout(popoverHideTimer); popoverHideTimer = null; }
    });
    popoverEl.addEventListener("mouseleave", () => schedulePopoverHide());
    document.body.appendChild(popoverEl);
    return popoverEl;
  }

  async function fetchProfile(name) {
    if (profileCache.has(name)) return profileCache.get(name);
    try {
      const res = await API.chatMemberProfile(name);
      const p = res && res.found ? res.profile : null;
      profileCache.set(name, p);
      return p;
    } catch (_) {
      profileCache.set(name, null);
      return null;
    }
  }

  function copyToClipboard(text) {
    try {
      navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      return false;
    }
  }

  function renderPopover(name, profile) {
    if (!profile) {
      return `<div class="chat-pop-empty">Нет дополнительной информации о ${escapeHtml(name)}</div>`;
    }
    const row = (label, value, link, copyable) => {
      if (!value) return "";
      const v = escapeHtml(String(value));
      const linkHtml = link
        ? `<a class="chat-pop-link" href="${escapeHtml(link)}" target="_blank" rel="noopener" title="Открыть">${v} ↗</a>`
        : v;
      const copyHtml = copyable
        ? `<button class="chat-pop-copy" data-copy="${v}" title="Копировать">⧉</button>`
        : "";
      return `<div class="chat-pop-row">
                <span class="chat-pop-label">${label}</span>
                <span class="chat-pop-val">${linkHtml}</span>
                ${copyHtml}
              </div>`;
    };

    const game = profile.game_nick || "";
    const dn = profile.display_name || "";
    // VK блок
    const vk_id = profile.vk_id || "";
    const vk_display = profile.vk_display || (
      [profile.vk_first, profile.vk_last].filter(Boolean).join(" ").trim()
    );
    const vk_screen = profile.vk_screen_name || "";
    const vk_url = vk_screen ? `https://vk.com/${vk_screen}`
                  : vk_id ? `https://vk.com/id${vk_id}` : "";
    const vk = (vk_id || vk_display || vk_screen) ? `
      <div class="chat-pop-section">
        <div class="chat-pop-sec-title">ВКонтакте</div>
        ${row("Имя", vk_display, vk_url, true)}
        ${row("screen", vk_screen, vk_url, true)}
        ${row("ID", vk_id, "", true)}
      </div>` : "";

    // TG блок
    const tg_id = profile.tg_id || "";
    const tg_display = profile.tg_display
      || [profile.tg_first_name, profile.tg_last_name].filter(Boolean).join(" ").trim();
    const tg_username = profile.tg_username || "";
    const tg_url = tg_username ? `https://t.me/${tg_username}` : "";
    const tg = (tg_id || tg_display || tg_username) ? `
      <div class="chat-pop-section">
        <div class="chat-pop-sec-title">Telegram</div>
        ${row("Имя", tg_display, tg_url, true)}
        ${row("@user", tg_username ? "@" + tg_username : "", tg_url, true)}
        ${row("ID", tg_id, "", true)}
      </div>` : "";

    const head = `
      <div class="chat-pop-head">
        <span class="chat-pop-name">${escapeHtml(dn || name)}</span>
      </div>`;
    const gameRow = game ? `
      <div class="chat-pop-section">
        <div class="chat-pop-sec-title">Игра</div>
        <div class="chat-pop-game">${escapeHtml(game)}</div>
      </div>` : "";

    return head + gameRow + vk + tg;
  }

  function positionPopover(anchor) {
    const r = anchor.getBoundingClientRect();
    const margin = 8;
    // По умолчанию справа-снизу от имени
    let left = r.left;
    let top = r.bottom + margin;
    // Проверим что popover влезет — после render-а
    requestAnimationFrame(() => {
      const pr = popoverEl.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      if (left + pr.width + 12 > vw) left = Math.max(8, vw - pr.width - 12);
      if (top + pr.height + 12 > vh) top = Math.max(8, r.top - pr.height - margin);
      popoverEl.style.left = left + "px";
      popoverEl.style.top = top + "px";
    });
  }

  function attachPopoverCopyHandlers() {
    popoverEl.querySelectorAll(".chat-pop-copy").forEach(btn => {
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const v = btn.dataset.copy || "";
        if (copyToClipboard(v)) {
          const old = btn.textContent;
          btn.textContent = "✓";
          setTimeout(() => { btn.textContent = old; }, 900);
        }
      });
    });
  }

  function schedulePopoverShow(anchor, name) {
    if (popoverHideTimer) { clearTimeout(popoverHideTimer); popoverHideTimer = null; }
    if (popoverShowTimer) clearTimeout(popoverShowTimer);
    popoverShowTimer = setTimeout(async () => {
      popoverShowTimer = null;
      const profile = await fetchProfile(name);
      ensurePopover();
      popoverEl.innerHTML = renderPopover(name, profile);
      popoverEl.hidden = false;
      popoverFor = name;
      positionPopover(anchor);
      attachPopoverCopyHandlers();
    }, 250);
  }

  function schedulePopoverHide() {
    if (popoverShowTimer) { clearTimeout(popoverShowTimer); popoverShowTimer = null; }
    if (popoverHideTimer) clearTimeout(popoverHideTimer);
    popoverHideTimer = setTimeout(() => {
      popoverHideTimer = null;
      if (popoverEl) popoverEl.hidden = true;
      popoverFor = null;
    }, 200);
  }

  // Делегированный hover на любую .chat-author внутри ленты.
  $("chat-feed").addEventListener("mouseover", (ev) => {
    const t = ev.target.closest(".chat-author");
    if (!t) return;
    const name = (t.textContent || "").trim();
    if (!name) return;
    schedulePopoverShow(t, name);
  });
  $("chat-feed").addEventListener("mouseout", (ev) => {
    const t = ev.target.closest(".chat-author");
    if (!t) return;
    schedulePopoverHide();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && popoverEl && !popoverEl.hidden) {
      popoverEl.hidden = true;
      popoverFor = null;
    }
  });

  // Ссылка на профиль автора в TG / VK.
  //   TG: только если есть @username — у людей без публичного username
  //       единственный способ — поделиться контактом, ссылки нет.
  //   VK: vk.com/id<sender_id> всегда работает даже без screen_name.
  function authorProfileUrl(m) {
    if (m.platform === "tg") {
      const u = String(m.user_username || "").trim();
      if (u && /^[a-zA-Z0-9_]{4,}$/.test(u)) {
        return `https://t.me/${u}`;
      }
      return null;
    }
    if (m.platform === "vk") {
      const uid = String(m.user_id || "").trim();
      if (uid && /^\d+$/.test(uid) && uid !== "0") {
        return `https://vk.com/id${uid}`;
      }
      return null;
    }
    return null;
  }

  // Группировка подряд идущих сообщений одного автора. Если предыдущее
  // сообщение от того же user_id + platform + chat_group и временной
  // разрыв < GROUP_WINDOW_MS, скрываем шапку — лента визуально плотнее.
  const GROUP_WINDOW_MS = 5 * 60 * 1000;
  function isContinuation(curr, prev) {
    if (!prev) return false;
    if (curr.platform !== prev.platform) return false;
    if (curr.chat_group !== prev.chat_group) return false;
    if (String(curr.user_id) !== String(prev.user_id)) return false;
    if (!curr.user_id || curr.user_id === "0") return false;
    try {
      const t1 = new Date(curr.sent_at + "Z").getTime();
      const t2 = new Date(prev.sent_at + "Z").getTime();
      // loaded — отсортирован новые сверху, prev в массиве идёт раньше (=новее),
      // значит curr старее prev → t1 < t2.
      return (t2 - t1) <= GROUP_WINDOW_MS && (t2 - t1) >= 0;
    } catch (_) {
      return false;
    }
  }

  // Ссылка на оригинал сообщения в TG/VK. Возвращает null если ID не
  // выглядит как реальный (например, для исторических migrated:... id).
  function originalUrl(m) {
    const mid = String(m.message_id || "");
    const cid = String(m.chat_id || "");
    if (!/^\d+$/.test(mid)) return null;       // mig:..., ts:... — не открыть
    if (!/^-?\d+$/.test(cid)) return null;
    if (m.platform === "tg") {
      // Приватные супергруппы: chat_id вида -100xxxxxxxxxx → t.me/c/xxxxxxxxxx/{msg}
      const n = parseInt(cid, 10);
      if (n < -1000000000000) {
        const internal = -n - 1000000000000;
        return `https://t.me/c/${internal}/${mid}`;
      }
      return null;
    }
    if (m.platform === "vk") {
      // VK мульти-чат: peer = 2000000000 + chat_id → vk.com/im?sel=c{N}&msgid={cmid}
      const n = parseInt(cid, 10);
      if (n > 2000000000) {
        const ci = n - 2000000000;
        return `https://vk.com/im?sel=c${ci}&msgid=${mid}`;
      }
      return null;
    }
    return null;
  }
  function groupLabel(g) {
    return g === "general" ? "общий" : g === "officers" ? "офицерский" : g;
  }
  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;",
      '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function formatBytes(b) {
    if (!b) return "";
    if (b < 1024) return b + "Б";
    if (b < 1024 * 1024) return Math.round(b / 1024) + "КБ";
    return (b / (1024 * 1024)).toFixed(1) + "МБ";
  }

  function renderMedia(media) {
    if (!media || !media.length) return "";
    const items = media.map(m => {
      const kindRu = {
        photo: "фото", video: "видео", document: "файл",
        audio: "аудио", voice: "голос", sticker: "стикер",
      }[m.kind] || m.kind;
      const name = m.name || m.mime || "";
      const size = m.size ? ` · ${formatBytes(m.size)}` : "";
      const inner = `📎 ${kindRu}${name ? " · " + escapeHtml(name) : ""}${size}`;
      return m.url
        ? `<a class="chat-media" href="${escapeHtml(m.url)}" target="_blank" rel="noopener">${inner}</a>`
        : `<span class="chat-media chat-media-placeholder">${inner}</span>`;
    });
    return `<div class="chat-media-list">${items.join("")}</div>`;
  }

  function renderReply(m) {
    if (!m.reply_to_user && !m.reply_to_text && !m.reply_to_msg_id) return "";
    if (m.reply_to_user || m.reply_to_text) {
      const author = escapeHtml(m.reply_to_user || "");
      const text = escapeHtml(m.reply_to_text || "");
      return `<div class="chat-reply">↩ <b>${author}:</b> ${text}</div>`;
    }
    // legacy / migrated: только id, без автора и текста
    return `<div class="chat-reply chat-reply-dim">↩ ответ на сообщение</div>`;
  }

  function renderMessage(m, prev) {
    const reply = renderReply(m);
    const fresh = freshIds.has(m.id) ? " chat-msg-fresh" : "";
    const cont = isContinuation(m, prev) ? " chat-msg-cont" : "";

    const authorEsc = escapeHtml(m.user_display);
    const authorHl = highlight(authorEsc, highlightTerms.author);
    const profileUrl = authorProfileUrl(m);
    const author = profileUrl
      ? `<a class="chat-author chat-author-link" href="${escapeHtml(profileUrl)}" target="_blank" rel="noopener" title="Открыть профиль в ${platformBadge(m.platform)}">${authorHl}</a>`
      : `<span class="chat-author">${authorHl}</span>`;
    const textEsc = escapeHtml(m.text);
    const textHl = highlight(textEsc, highlightTerms.text);
    const text = m.text ? `<div class="chat-text">${textHl}</div>` : "";
    const media = renderMedia(m.media);
    const delBtn = isAdmin
      ? `<button class="chat-msg-del" data-del-id="${m.id}" title="Удалить из архива">✕</button>`
      : "";
    const tsText = fmtTs(m.sent_at);
    const url = originalUrl(m);
    const timeHtml = url
      ? `<a class="chat-time chat-time-link" href="${escapeHtml(url)}" target="_blank" rel="noopener" title="Открыть оригинал в ${platformBadge(m.platform)}">${tsText} ↗</a>`
      : `<span class="chat-time" title="Оригинал недоступен (бэкфилл из JSONL)">${tsText}</span>`;

    // В continuation-режиме показываем только время справа компактно,
    // без полной шапки.
    const head = cont
      ? `<div class="chat-head chat-head-cont">${timeHtml}</div>`
      : `<div class="chat-head">
            ${author}
            ${m.user_username ? `<span class="chat-username">@${escapeHtml(m.user_username)}</span>` : ""}
            <span class="chat-badge chat-badge-${m.platform}">${platformBadge(m.platform)}</span>
            <span class="chat-group-tag">${groupLabel(m.chat_group)}</span>
            ${timeHtml}
          </div>`;

    return `
      <div class="chat-msg chat-msg-${m.platform}${fresh}${cont}" data-id="${m.id}">
        ${delBtn}
        ${head}
        ${reply}
        ${text}
        ${media}
      </div>
    `;
  }

  function render(reset) {
    const feed = $("chat-feed");
    if (reset) feed.innerHTML = "";
    // loaded — новые сверху. Для группировки prev для loaded[i] это
    // loaded[i-1] (то что выше = новее = было отправлено ПОЗЖЕ).
    feed.innerHTML = loaded.map((m, i) =>
      renderMessage(m, loaded[i - 1])
    ).join("");
    $("empty-state").hidden = loaded.length > 0;
    $("load-more-wrap").hidden = loaded.length === 0
      || loaded.length < PAGE_SIZE
      || loaded.length % PAGE_SIZE !== 0;
    // Привязываем delete handlers (после innerHTML)
    if (isAdmin) {
      feed.querySelectorAll(".chat-msg-del").forEach(btn => {
        btn.addEventListener("click", async (e) => {
          e.stopPropagation();
          const id = parseInt(btn.dataset.delId, 10);
          if (!id) return;
          if (!confirm("Удалить это сообщение из архива?")) return;
          try {
            await API.chatMessageDelete(id);
            loaded = loaded.filter(m => m.id !== id);
            render(true);
            refreshStats();
          } catch (e) {
            alert("Не удалось удалить: " + (e.detail || e.message));
          }
        });
      });
    }
  }

  // ─────────────── фильтры ───────────────

  function collectFilters() {
    // Валидация дат — невалидные подсвечиваем и не отправляем.
    const fFrom = $("f-from");
    const fTo = $("f-to");
    let dateFrom = parseDateRu(fFrom.value);
    let dateTo = parseDateRu(fTo.value);
    fFrom.classList.toggle("invalid", fFrom.value && !dateFrom);
    fTo.classList.toggle("invalid", fTo.value && !dateTo);
    // Чтобы date_to включал весь день, заменяем YYYY-MM-DD на YYYY-MM-DDT23:59:59
    if (dateTo) dateTo = dateTo + "T23:59:59";
    return {
      chat_group: $("f-group").value || undefined,
      date_from: dateFrom || undefined,
      date_to: dateTo || undefined,
      user: $("f-user").value.trim() || undefined,
      search: $("f-search").value.trim() || undefined,
    };
  }

  async function load(reset) {
    $("chat-loading").hidden = false;
    try {
      const params = { ...activeFilters, limit: PAGE_SIZE };
      if (!reset && oldestId !== null) params.before_id = oldestId;
      const page = await API.chatList(params);
      if (reset) loaded = page;
      else loaded = loaded.concat(page);
      if (page.length) oldestId = page[page.length - 1].id;
      render(reset);
    } catch (e) {
      $("chat-feed").innerHTML =
        `<div class="empty">Ошибка: ${escapeHtml(e.detail || e.message)}</div>`;
    } finally {
      $("chat-loading").hidden = true;
    }
    // Обновляем newest id для будущих auto-refresh запросов.
    if (loaded.length) newestId = Math.max(...loaded.map(m => m.id));
  }

  async function applyFilters() {
    activeFilters = collectFilters();
    highlightTerms = extractHighlightTerms(activeFilters.search);
    oldestId = null;
    newestId = null;
    freshIds.clear();
    await load(true);
    await refreshStats();
  }

  // ─────────────── auto-refresh (polling) ───────────────
  // Polling каждые AUTO_REFRESH_MS если:
  //   - вкладка видна (document.visibilityState === 'visible')
  //   - нет активного редактирования (тут нечего редактировать, но
  //     сохраняем семантику для будущего)
  //   - есть newestId (значит первая загрузка прошла)
  // Параллельный поиск с активными фильтрами тоже работает: backend сам
  // отфильтрует и after_id, и group/date/user/search вместе.
  const AUTO_REFRESH_MS = 20000;

  async function autoRefreshTick() {
    if (document.visibilityState !== "visible") return;
    if (newestId === null) return;
    try {
      const params = { ...activeFilters, after_id: newestId, limit: 200 };
      const page = await API.chatList(params);
      if (!page.length) return;
      // newer выше — front-end ожидает новые сверху. backend вернул DESC.
      const ids = page.map(m => m.id);
      newestId = Math.max(newestId, ...ids);
      ids.forEach(id => freshIds.add(id));
      // Сливаем: новые сверху + старые снизу. Дубликатов не будет — id > newestId.
      loaded = page.concat(loaded);
      render(true);
      // Снимаем «свежесть» через 6 сек, чтобы подсветка ушла.
      setTimeout(() => {
        ids.forEach(id => freshIds.delete(id));
        // Не перерисовываем — CSS-transition сам мягко уберёт класс.
      }, 6000);
      // Обновим статистику (счётчики) фоном.
      refreshStats();
    } catch (_) {
      // тихо: сеть отвалилась, ничего страшного, в следующий tick попробуем
    }
  }
  setInterval(autoRefreshTick, AUTO_REFRESH_MS);
  // При возвращении на вкладку — сразу пытаемся подтянуть пропущенное.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") autoRefreshTick();
  });

  async function refreshStats() {
    try {
      const s = await API.chatStats();
      const parts = [
        `всего: ${s.total}`,
        `общий: ${s.by_group.general || 0}`,
        `офицерский: ${s.by_group.officers || 0}`,
      ];
      if (s.first_at) {
        parts.push(`с ${s.first_at.slice(0, 10)} по ${(s.last_at || "").slice(0, 10)}`);
      }
      $("chat-stats").textContent = parts.join("  ·  ");
    } catch (_) {
      $("chat-stats").textContent = "";
    }
  }

  // ─────────────── события ───────────────

  $("apply-btn").addEventListener("click", applyFilters);
  // Переключение чата (Все/Общий/Офицерский) — сразу применяет фильтр
  // без нажатия «Поиск»: естественное поведение для select-а.
  $("f-group").addEventListener("change", applyFilters);
  $("reset-btn").addEventListener("click", () => {
    for (const id of ["f-group", "f-from", "f-to", "f-user", "f-search"]) {
      $(id).value = "";
      $(id).classList.remove("invalid");
    }
    applyFilters();
  });
  $("load-more-btn").addEventListener("click", () => load(false));

  // Enter в любом поле фильтров = поиск
  for (const id of ["f-from", "f-to", "f-user", "f-search"]) {
    $(id).addEventListener("keydown", e => {
      if (e.key === "Enter") applyFilters();
    });
  }

  if (isAdmin) {
    $("clear-archive-btn").addEventListener("click", async () => {
      if (!confirm("Очистить ВЕСЬ архив переписки? Это нельзя отменить.")) return;
      if (!confirm("Точно? Удалятся ВСЕ сообщения общего и офицерского чатов.")) return;
      try {
        const r = await API.chatClearAll();
        alert(`Архив очищен. Удалено сообщений: ${r.deleted}`);
        await applyFilters();
      } catch (e) {
        alert("Не удалось очистить: " + (e.detail || e.message));
      }
    });
  }

  await applyFilters();
})();
