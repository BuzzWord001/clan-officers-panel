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
    const inactive = profile.is_active === 0 || profile.is_active === false;
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

    const inactiveBadge = inactive
      ? `<span class="chat-pop-inactive" title="Уже не в клановых чатах. Данные сохранены для архива.">не в чате</span>`
      : "";
    const unregBadge = (profile.registered === false)
      ? `<span class="chat-pop-unreg" title="Не зарегистрирован через /reg в клан. Данные взяты автоматически из его сообщений в чате.">не в клане</span>`
      : "";
    const seen = (profile._msg_count != null)
      ? `<div class="chat-pop-seen">${profile._msg_count} сообщ.</div>`
      : "";
    const head = `
      <div class="chat-pop-head">
        <span class="chat-pop-name">${escapeHtml(dn || name)}</span>
        ${inactiveBadge}
        ${unregBadge}
        ${seen}
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

  // Распознаём ссылки в тексте и делаем их кликабельными. Поддержанные:
  //   - http(s)://...
  //   - www.example.com
  //   - t.me/foo, vk.com/foo (без протокола — добавим https://)
  // URL прерывается на пробелах, переносах строк и стандартных
  // pre-trail знаках препинания (.,!?)»);]} — чтобы они не уходили
  // внутрь ссылки.
  const URL_RE = /\b(?:https?:\/\/|www\.|t\.me\/|vk\.com\/|vk\.me\/|github\.com\/|youtu\.be\/|youtube\.com\/|telegra\.ph\/)[^\s<>"' ]+/gi;
  // Хвостовая пунктуация которую НЕ включаем в URL (закрывающие
  // скобки/кавычки тоже снимем для безопасности).
  const URL_TRAIL_RE = /[.,!?;:)»\]>}'"]+$/;

  function linkifyAndHighlight(text, terms) {
    if (!text) return "";
    let result = "";
    let last = 0;
    let m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(text)) !== null) {
      // Хвостовая пунктуация — за пределами URL'а.
      let url = m[0];
      const tail = (url.match(URL_TRAIL_RE) || [""])[0];
      if (tail) url = url.slice(0, -tail.length);
      const start = m.index;
      const end = start + url.length;
      // Текст до URL'а
      const before = text.slice(last, start);
      if (before) result += highlight(escapeHtml(before), terms);
      // Сам URL — кликабельная ссылка.
      const escUrl = escapeHtml(url);
      const href = /^https?:/i.test(url) ? url : ("https://" + url);
      result += `<a class="chat-link" href="${escapeHtml(href)}" target="_blank" rel="noopener nofollow">${escUrl}</a>`;
      // Tail-пунктуацию (если была) добавляем как обычный текст ПОСЛЕ ссылки.
      if (tail) result += escapeHtml(tail);
      last = end + tail.length;
      URL_RE.lastIndex = last;
    }
    if (last < text.length) {
      result += highlight(escapeHtml(text.slice(last)), terms);
    }
    return result;
  }
  function formatBytes(b) {
    if (!b) return "";
    if (b < 1024) return b + "Б";
    if (b < 1024 * 1024) return Math.round(b / 1024) + "КБ";
    return (b / (1024 * 1024)).toFixed(1) + "МБ";
  }

  // Имя для атрибута download — берём из name либо синтезируем по kind.
  function downloadFileName(url, kind, name) {
    if (name) return name;
    // Берём последний segment из URL.
    try {
      const u = new URL(url);
      const last = u.pathname.split("/").pop() || "";
      if (last) return last;
    } catch (_) {}
    return kind || "file";
  }

  // Маленькая «скачать» кнопка-оверлей. Под капотом — backend-proxy
  // /chat/media/download (с Content-Disposition: attachment). Клик
  // перехватывается JS: fetch с Bearer-токеном → blob → программный
  // click — браузер сохраняет файл, а не открывает inline.
  //
  // Для стикеров (kind=sticker / sticker_anim_thumb) добавляется ?as=png:
  // backend конвертирует .webp → .png через Pillow. Делаем потому что
  // .webp не открывается двойным кликом в Проводнике Windows у части
  // пользователей — браузер видит как inline и открывается там.
  function buildDownloadHref(url, name, kind) {
    const base = ((window.OFFICERS_CONFIG && window.OFFICERS_CONFIG.API_URL)
                  || "").replace(/\/$/, "");
    if (!base) return url;
    const u = new URL(base + "/chat/media/download");
    u.searchParams.set("u", url);
    if (name) u.searchParams.set("name", name);
    // Стикеры конвертируем в PNG. sticker_video оставляем .webm —
    // браузер/VLC его проигрывают. animation тоже не трогаем.
    if (kind === "sticker" || kind === "sticker_anim_thumb") {
      u.searchParams.set("as", "png");
    }
    return u.toString();
  }
  function downloadBtn(url, kind, name) {
    if (!url) return "";
    let fn = downloadFileName(url, kind, name);
    // Подменяем расширение для PNG-конверсии (чтобы blob a.download
    // сохранил с правильным суффиксом).
    if (kind === "sticker" || kind === "sticker_anim_thumb") {
      fn = fn.replace(/\.[a-z0-9]{1,5}$/i, "") + ".png";
    }
    const dlHref = buildDownloadHref(url, name, kind);
    // <button> вместо <a> — гарантия что default navigation никогда не
    // сработает (раньше с <a href=...> в редких случаях когда JS успевал
    // не сразу, browser открывал URL в новой вкладке).
    return `<button type="button" class="chat-media-dl"
              data-dl-href="${escapeHtml(dlHref)}" data-dl-name="${escapeHtml(fn)}"
              title="Скачать ${escapeHtml(fn)}">⬇</button>`;
  }

  function renderMedia(media) {
    if (!media || !media.length) return "";
    const items = media.map(m => {
      const kind = m.kind || "";
      const url = m.url || "";
      const name = m.name || "";
      const size = m.size ? formatBytes(m.size) : "";
      const sizePart = size ? ` · ${escapeHtml(size)}` : "";

      // Photo / sticker — миниатюра, по клику открывается в новой вкладке,
      // на hover — большой overlay-zoom (см. chat-archive-zoom).
      // Lottie .tgs (Telegram анимированные стикеры) — браузер не умеет
      // рендерить через <img>. Показываем placeholder с возможностью скачать.
      const isLottie = url && (
        url.toLowerCase().endsWith(".tgs") ||
        (m.mime || "").toLowerCase() === "application/x-tgsticker"
      );
      if (url && isLottie) {
        const dl = downloadBtn(url, kind, name || "sticker.tgs");
        return `<div class="chat-media-wrap chat-media-wrap-doc">
                  <a class="chat-media chat-media-lottie" href="${escapeHtml(url)}" target="_blank" rel="noopener" title="Lottie-стикер .tgs — анимированный, скачай для просмотра в Telegram">
                    🎬 анимированный стикер${size ? ' · ' + escapeHtml(size) : ''}
                  </a>
                  ${dl}
                </div>`;
      }
      // Hover-zoom только для kind=photo. У стикеров/смайликов/GIF
      // оригинал такого же мелкого размера (~512px), и зум только
      // мешает — оставляем привычный thumbnail.
      if (url && kind === "photo") {
        const dl = downloadBtn(url, kind, name);
        return `<div class="chat-media-wrap">
                  <a class="chat-media-thumb" href="${escapeHtml(url)}" target="_blank" rel="noopener" data-zoom-url="${escapeHtml(url)}" title="${escapeHtml(name || kind)}${size ? ' · ' + size : ''}">
                    <img loading="lazy" src="${escapeHtml(url)}" alt="${escapeHtml(kind)}">
                  </a>
                  ${dl}
                </div>`;
      }
      if (url && (kind === "sticker" ||
                  kind === "sticker_anim_thumb" || kind === "animation")) {
        const dl = downloadBtn(url, kind, name);
        return `<div class="chat-media-wrap">
                  <a class="chat-media-thumb" href="${escapeHtml(url)}" target="_blank" rel="noopener" title="${escapeHtml(name || kind)}${size ? ' · ' + size : ''}">
                    <img loading="lazy" src="${escapeHtml(url)}" alt="${escapeHtml(kind)}">
                  </a>
                  ${dl}
                </div>`;
      }
      // Video / video_note / sticker_video — нативный плеер прямо в ленте.
      // controlslist=nodownload убирает встроенный «download» из 3-точечного
      // меню — оставляем единственный путь через нашу кнопку ⬇.
      if (url && (kind === "video" || kind === "video_note" ||
                  kind === "sticker_video")) {
        const dl = downloadBtn(url, kind, name);
        return `<div class="chat-media-wrap chat-media-wrap-video">
                  <video class="chat-media-video" controls controlslist="nodownload" preload="metadata" src="${escapeHtml(url)}">
                    <a href="${escapeHtml(url)}" target="_blank" rel="noopener">скачать видео</a>
                  </video>
                  ${dl}
                </div>`;
      }
      // Voice / audio — audio-плеер. controlslist=nodownload убирает
      // встроенную «скачать» из 3-точечного меню — оставляем единственный
      // путь через нашу кнопку ⬇ (она угол wrap'а).
      if (url && (kind === "voice" || kind === "audio")) {
        const icon = kind === "voice" ? "🎙" : "🎵";
        const dl = downloadBtn(url, kind, name);
        return `<div class="chat-media-wrap chat-media-wrap-audio">
                  <div class="chat-media-audio">
                    <span class="chat-media-audio-icon">${icon}</span>
                    <audio controls controlslist="nodownload" preload="none" src="${escapeHtml(url)}"></audio>
                  </div>
                  ${dl}
                </div>`;
      }
      // Document / unknown — карточка с скачать.
      const kindRu = {
        photo: "фото", video: "видео", document: "файл",
        audio: "аудио", voice: "голос", sticker: "стикер",
        animation: "GIF", wall: "репост стены",
      }[kind] || kind;
      const inner = `📎 ${kindRu}${name ? " · " + escapeHtml(name) : ""}${sizePart}`;
      if (!url) {
        return `<span class="chat-media chat-media-placeholder">${inner}</span>`;
      }
      const dl = downloadBtn(url, kind, name);
      return `<span class="chat-media-wrap chat-media-wrap-doc">
                <a class="chat-media" href="${escapeHtml(url)}" target="_blank" rel="noopener">${inner}</a>
                ${dl}
              </span>`;
    });
    return `<div class="chat-media-list">${items.join("")}</div>`;
  }

  function renderReply(m) {
    if (!m.reply_to_user && !m.reply_to_text && !m.reply_to_msg_id) return "";
    const tgtMid = String(m.reply_to_msg_id || "");
    const replyUser = m.reply_to_user || "";
    const replyText = m.reply_to_text || "";
    // Кликабельность: либо есть msg_id (точный поиск), либо есть
    // user+text — эвристический поиск по тексту в той же ленте.
    const hasMid = Boolean(tgtMid);
    const hasUserText = Boolean(replyUser || replyText);
    const isClickable = hasMid || hasUserText;
    const dataAttrs =
      ` data-reply-platform="${escapeHtml(m.platform)}"`
    + ` data-reply-chat="${escapeHtml(m.chat_id)}"`
    + (hasMid ? ` data-reply-mid="${escapeHtml(tgtMid)}"` : "")
    + ` data-reply-user="${escapeHtml(replyUser)}"`
    + ` data-reply-text="${escapeHtml(replyText)}"`;
    const cls = "chat-reply"
              + (isClickable ? " chat-reply-clickable" : "")
              + ((!replyUser && !replyText) ? " chat-reply-dim" : "");
    const title = isClickable
      ? (hasMid ? "Перейти к оригиналу"
                : "Перейти к оригиналу (поиск по тексту)")
      : "";
    if (replyUser || replyText) {
      const author = escapeHtml(replyUser);
      const text = escapeHtml(replyText);
      return `<div class="${cls}"${dataAttrs} title="${title}">↩ <b>${author}:</b> ${text}</div>`;
    }
    // legacy: только id, без автора и текста
    return `<div class="${cls}"${dataAttrs} title="${title}">↩ ответ на сообщение</div>`;
  }

  function detectEventKind(m) {
    // События входа/выхода идут с media.kind = "event_join" / "event_leave".
    for (const it of (m.media || [])) {
      if (it && typeof it.kind === "string" && it.kind.startsWith("event_")) {
        return it.kind.slice(6); // "join" | "leave" | ...
      }
    }
    return null;
  }

  function renderEvent(m, kind) {
    const icon = kind === "join" ? "➜" : "✕";
    const cls  = kind === "join" ? "join" : "leave";
    const time = fmtTs(m.sent_at);
    const url = originalUrl(m);
    const timeHtml = url
      ? `<a class="chat-event-time" href="${escapeHtml(url)}" target="_blank" rel="noopener">${time}</a>`
      : `<span class="chat-event-time">${time}</span>`;
    const nameHl = highlight(escapeHtml(m.user_display), highlightTerms.author);
    const delBtn = isAdmin
      ? `<button class="chat-msg-del" data-del-id="${m.id}" title="Удалить из архива">✕</button>`
      : "";
    return `
      <div class="chat-event chat-event-${cls}" data-id="${m.id}">
        ${delBtn}
        <span class="chat-event-icon">${icon}</span>
        <span class="chat-event-name chat-author">${nameHl}</span>
        <span class="chat-event-text">${escapeHtml(m.text)}</span>
        <span class="chat-event-group">${groupLabel(m.chat_group)} · ${platformBadge(m.platform)}</span>
        ${timeHtml}
      </div>
    `;
  }

  function renderMessage(m, prev) {
    // События — отдельный плоский стиль (нет шапки/реплая/медиа)
    const eventKind = detectEventKind(m);
    if (eventKind) return renderEvent(m, eventKind);

    const reply = renderReply(m);
    const fresh = freshIds.has(m.id) ? " chat-msg-fresh" : "";
    const cont = isContinuation(m, prev) ? " chat-msg-cont" : "";

    const authorEsc = escapeHtml(m.user_display);
    const authorHl = highlight(authorEsc, highlightTerms.author);
    const profileUrl = authorProfileUrl(m);
    const author = profileUrl
      ? `<a class="chat-author chat-author-link" href="${escapeHtml(profileUrl)}" target="_blank" rel="noopener" title="Открыть профиль в ${platformBadge(m.platform)}">${authorHl}</a>`
      : `<span class="chat-author">${authorHl}</span>`;
    // Текст: ссылки кликабельные, поисковые термины подсвечены.
    const textHtml = linkifyAndHighlight(m.text, highlightTerms.text);
    const text = m.text ? `<div class="chat-text">${textHtml}</div>` : "";
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

  function updateVisibility() {
    $("empty-state").hidden = loaded.length > 0;
    $("load-more-wrap").hidden = loaded.length === 0
      || loaded.length < PAGE_SIZE
      || loaded.length % PAGE_SIZE !== 0;
  }

  // Полная перерисовка с нуля (применение фильтров, начальная загрузка,
  // delete сообщения). Тяжёлая операция — innerHTML wipe + refill, при
  // 500+ messages блокирует main thread на сотни мс.
  function renderReset() {
    const feed = $("chat-feed");
    feed.innerHTML = loaded.map((m, i) =>
      renderMessage(m, loaded[i - 1])
    ).join("");
    updateVisibility();
  }

  // Дорисовать новые элементы СНИЗУ (load-more). Старые DOM не трогаем —
  // никакого мерцания, никакой нагрузки на DOM кроме новых ~80 элементов.
  // items — новые объекты из БД (уже добавлены в конец loaded[]).
  function renderAppendBottom(items) {
    if (!items || !items.length) { updateVisibility(); return; }
    const feed = $("chat-feed");
    // prev для первого нового = тот что был последний в loaded ДО append.
    const prevForFirst = loaded[loaded.length - items.length - 1] || null;
    const html = items.map((m, i) =>
      renderMessage(m, i === 0 ? prevForFirst : items[i - 1])
    ).join("");
    feed.insertAdjacentHTML("beforeend", html);
    updateVisibility();
  }

  // Дорисовать новые элементы СВЕРХУ (auto-refresh свежих сообщений).
  function renderPrependTop(items) {
    if (!items || !items.length) { updateVisibility(); return; }
    const feed = $("chat-feed");
    // items[items.length-1].prev = первый из старых был при добавлении
    // последним для items[i-1]; для самого первого items[0] prev=null
    // (так как это будет верх ленты).
    const html = items.map((m, i) =>
      renderMessage(m, items[i - 1])
    ).join("");
    feed.insertAdjacentHTML("afterbegin", html);
    updateVisibility();
  }

  // Делегированный delete handler: один listener на всю ленту. Раньше
  // привязывались handler'ы к каждой кнопке на каждом render — O(n) на
  // каждой подгрузке. Теперь — один.
  if (isAdmin) {
    $("chat-feed").addEventListener("click", async (ev) => {
      const btn = ev.target.closest(".chat-msg-del");
      if (!btn) return;
      ev.stopPropagation();
      const id = parseInt(btn.dataset.delId, 10);
      if (!id) return;
      if (!confirm("Удалить это сообщение из архива?")) return;
      try {
        await API.chatMessageDelete(id);
        loaded = loaded.filter(m => m.id !== id);
        renderReset();
        refreshStats();
      } catch (e) {
        alert("Не удалось удалить: " + (e.detail || e.message));
      }
    });
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
      if (reset) {
        loaded = page;
        if (page.length) oldestId = page[page.length - 1].id;
        renderReset();
      } else {
        // load-more: добавляем новые в КОНЕЦ loaded, дорисовываем снизу
        // без перерисовки старых.
        loaded = loaded.concat(page);
        if (page.length) oldestId = page[page.length - 1].id;
        renderAppendBottom(page);
      }
    } catch (e) {
      $("chat-feed").innerHTML =
        `<div class="empty">Ошибка: ${escapeHtml(e.detail || e.message)}</div>`;
    } finally {
      $("chat-loading").hidden = true;
    }
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
      renderPrependTop(page);
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

  // Клик по тегам тем в подсказке → подставляет «тема:X» в поле поиска
  // и сразу запускает. Остальные фильтры (даты, автор, чат) НЕ трогаем —
  // их можно дополнить и нажать «Поиск» ещё раз.
  document.querySelectorAll(".chat-hint-themes code").forEach(el => {
    el.style.cursor = "pointer";
    el.addEventListener("click", () => {
      const name = (el.textContent || "").trim();
      if (!name) return;
      $("f-search").value = `тема:${name}`;
      $("f-search").focus();
      applyFilters();
    });
  });
  // Примеры в первой части подсказки (Мелодька, рейд, "нужна помощь", ...)
  // и в строке про минус — все <code> кликабельные. textContent даёт сам
  // запрос как есть, его и подставляем.
  document.querySelectorAll(".chat-hint-grid code, .chat-hint-note code")
    .forEach(el => {
      el.style.cursor = "pointer";
      el.addEventListener("click", () => {
        const q = (el.textContent || "").trim();
        if (!q) return;
        $("f-search").value = q;
        $("f-search").focus();
        applyFilters();
      });
    });
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

  // ─────────────── Reply click-to-scroll ───────────────
  // При клике на reply ищем в loaded оригинал. Если не нашли — автоматически
  // подгружаем архив страница за страницей пока не найдём ИЛИ пока не
  // достигнем лимита. Для эвристики лимит чуть меньше — там шанс ложного
  // совпадения растёт с глубиной (одинаковые тексты от разных людей).
  // Благодаря renderAppendBottom (insertAdjacentHTML) подгрузка дешёвая —
  // не перерисовывает ленту, поэтому глубокий поиск не вызывает мерцания.
  const REPLY_LOOKUP_PAGES_MID = 30;    // ~2400 сообщений
  const REPLY_LOOKUP_PAGES_FUZZY = 20;  // ~1600 сообщений

  // В JSONL архиве reply_to_text сохранён с media-префиксом ([фото],
  // [GIF], [стикер 😂], [фото, видео], [ссылка] и т.д.). Бот всегда
  // ставит маркер в формате [...слова без вложенных скобок...] в самом
  // начале текста, далее либо пробел и реальный текст, либо конец строки.
  // Оригинал-сообщение в БД хранится БЕЗ префикса — снимаем перед
  // эвристическим матчем.
  const MEDIA_PREFIX_RE = /^\s*\[[^\[\]]{1,40}\](?:\s+|$)/;
  function stripReplyMediaMarker(s) {
    return (s || "").replace(MEDIA_PREFIX_RE, "");
  }

  // Бот-мост ретранслирует сообщения между TG и VK. Когда кто-то отвечает
  // на ретрансляцию, reply_to_text имеет формат "<метка чата> | <Автор>: <текст>",
  // например «𝗧𝗚 𝗰𝗵𝗮𝘁 | Follk: а люди с вк видят чат в тг?»
  // Оригинал тогда лежит в ПАРНОЙ платформе/чате, а не там же где reply.
  const BOT_RELAY_RE = /^([^|]{1,30}?)\s*\|\s*([^:]{1,40}):\s*([\s\S]+)$/;
  const PAIRED_CHATS = {
    "2000000001":   "-1003868189678",  // general: vk peer ↔ tg chat
    "-1003868189678": "2000000001",
    "2000000002":   "-1003999223250",  // officers: vk peer ↔ tg chat
    "-1003999223250": "2000000002",
  };
  function detectBotRelay(rt) {
    const m = (rt || "").match(BOT_RELAY_RE);
    if (!m) return null;
    // NFKD: «𝗧𝗚 𝗰𝗵𝗮𝘁» → «TG chat», math-bold убирается.
    const norm = m[1].normalize("NFKD").toLowerCase().trim();
    let src;
    if (norm.indexOf("tg") >= 0 || norm.indexOf("тг") >= 0
        || norm.indexOf("telegram") >= 0) {
      src = "tg";
    } else if (norm.indexOf("vk") >= 0 || norm.indexOf("вк") >= 0
        || norm.indexOf("вконтакте") >= 0) {
      src = "vk";
    } else {
      return null;
    }
    return { src, author: m[2].trim(), text: m[3].trim() };
  }

  function findReplyTargetIndex(platform, chatId, msgId) {
    if (!msgId) return -1;
    for (let i = 0; i < loaded.length; i++) {
      const m = loaded[i];
      if (m.platform === platform
          && String(m.chat_id) === String(chatId)
          && String(m.message_id) === String(msgId)) {
        return i;
      }
    }
    return -1;
  }

  // Эвристический поиск оригинала по reply_to_user + reply_to_text,
  // когда msg_id отсутствует (старые исторические reply из JSONL).
  // reply_to_text может начинаться с media-маркера ([фото]/[GIF]/etc),
  // его снимаем перед сравнением.
  // Скоринг:
  //   +3  m.text начинается с очищенного reply_to_text[:50]
  //   +1  очищенный reply_to_text[:50] содержится в m.text
  //   +2  m.user_display точно равен reply_to_user
  //   +1  частичное совпадение user_display ↔ reply_to_user
  //   +1  оригинал содержит МЕДИА (kind=photo/video/...) если в reply
  //       был media-маркер — дополнительный сигнал
  // Принимаем матч если score >= 3 (текст-старт ИЛИ user+contains).
  function findReplyTargetHeuristic(platform, chatId, replyUser, replyText) {
    const userTrim = (replyUser || "").trim();
    const rawText = (replyText || "").trim();
    const hadMediaMarker = MEDIA_PREFIX_RE.test(rawText);
    const cleanText = stripReplyMediaMarker(rawText).trim();
    const textTrim = cleanText.substring(0, 50);
    // Если ни юзера, ни осмысленного текста — искать нечего.
    if (!userTrim && !textTrim) return -1;
    // Если только marker без текста и нет user — тоже бесполезно.
    if (!textTrim && !userTrim) return -1;
    let best = -1, bestScore = 0;
    for (let i = 0; i < loaded.length; i++) {
      const m = loaded[i];
      if (m.platform !== platform) continue;
      if (String(m.chat_id) !== String(chatId)) continue;
      let score = 0;
      const mText = (m.text || "");
      const mUser = (m.user_display || "");
      if (textTrim) {
        if (mText.startsWith(textTrim)) score += 3;
        else if (mText.indexOf(textTrim) >= 0) score += 1;
      }
      if (userTrim) {
        if (mUser === userTrim) score += 2;
        else if (mUser && (mUser.indexOf(userTrim) >= 0
                 || userTrim.indexOf(mUser) >= 0)) score += 1;
      }
      if (hadMediaMarker && Array.isArray(m.media) && m.media.length > 0) {
        score += 1;
      }
      if (score > bestScore) { best = i; bestScore = score; }
    }
    return bestScore >= 3 ? best : -1;
  }

  function flashMessage(el) {
    if (!el) return;
    el.classList.remove("chat-msg-flash");
    // reflow → restart animation
    void el.offsetWidth;
    el.classList.add("chat-msg-flash");
  }

  function findReplyTarget(platform, chatId, msgId, replyUser, replyText) {
    // 1) Точный поиск по msg_id, если есть.
    if (msgId) {
      const i = findReplyTargetIndex(platform, chatId, msgId);
      if (i >= 0) return i;
    }
    // 2) Bot-relay: если reply_to_text имеет формат «TG чат | Автор: …»,
    //    оригинал в ПАРНОЙ платформе/чате. Идём искать туда.
    const relay = detectBotRelay(replyText);
    if (relay && relay.src !== platform) {
      const otherChat = PAIRED_CHATS[String(chatId)];
      if (otherChat) {
        const i = findReplyTargetHeuristic(
          relay.src, otherChat, relay.author, relay.text);
        if (i >= 0) return i;
      }
    }
    // 3) Обычная эвристика по reply_to_user + reply_to_text
    return findReplyTargetHeuristic(platform, chatId, replyUser, replyText);
  }

  async function scrollToReply(platform, chatId, msgId, replyUser, replyText, btn) {
    let idx = findReplyTarget(platform, chatId, msgId, replyUser, replyText);
    if (idx < 0) {
      // По msg_id ищем глубоко, по эвристике — мелко: дальше шанс
      // правильного матча падает, а каждая подгрузка рисует 80 новых
      // сообщений → большая нагрузка на DOM.
      const maxPages = msgId ? REPLY_LOOKUP_PAGES_MID : REPLY_LOOKUP_PAGES_FUZZY;
      if (btn) btn.classList.add("chat-reply-loading");
      try {
        for (let p = 0; p < maxPages; p++) {
          if (loaded.length < PAGE_SIZE) break;
          await load(false);
          // Даём UI отрисоваться/обработать события между подгрузками.
          await new Promise(r => setTimeout(r, 0));
          idx = findReplyTarget(platform, chatId, msgId, replyUser, replyText);
          if (idx >= 0) break;
          if (loaded.length % PAGE_SIZE !== 0) break;
        }
      } finally {
        if (btn) btn.classList.remove("chat-reply-loading");
      }
    }
    if (idx < 0) {
      if (btn) {
        // Визуальный flash красным + tooltip — пользователь сразу
        // видит что попытки перехода была, но не получилось.
        btn.classList.remove("chat-reply-notfound");
        void btn.offsetWidth;
        btn.classList.add("chat-reply-notfound");
        setTimeout(() => btn.classList.remove("chat-reply-notfound"), 1500);
        const prev = btn.getAttribute("title") || "";
        btn.setAttribute("title",
          msgId ? "Оригинал не в архиве (удалён или вне выборки)"
                : "Оригинал не найден в загруженной выборке");
        setTimeout(() => btn.setAttribute("title", prev), 3000);
      }
      return;
    }
    const target = loaded[idx];
    const el = document.querySelector(
      `.chat-msg[data-id="${target.id}"], .chat-event[data-id="${target.id}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      flashMessage(el);
    }
  }

  $("chat-feed").addEventListener("click", (ev) => {
    const r = ev.target.closest(".chat-reply-clickable");
    if (!r) return;
    ev.preventDefault();
    const platform = r.dataset.replyPlatform;
    const chatId = r.dataset.replyChat;
    const mid = r.dataset.replyMid || "";
    const replyUser = r.dataset.replyUser || "";
    const replyText = r.dataset.replyText || "";
    if (!mid && !replyUser && !replyText) return;
    scrollToReply(platform, chatId, mid, replyUser, replyText, r);
  });

  // ─────────────── Hover-zoom для фото/стикеров/GIF ───────────────
  // Большой overlay-предпросмотр поверх thumb при наведении. Открывается
  // через 350мс задержки чтобы случайные movement не дёргали zoom.
  let zoomEl = null;
  let zoomTimer = null;
  let zoomFor = null;

  function ensureZoom() {
    if (zoomEl) return zoomEl;
    zoomEl = document.createElement("div");
    zoomEl.className = "chat-media-zoom";
    zoomEl.hidden = true;
    document.body.appendChild(zoomEl);
    return zoomEl;
  }

  function showZoom(anchor, url) {
    ensureZoom();
    zoomEl.innerHTML = `<img src="${escapeHtml(url)}" alt="zoom">`;
    zoomEl.style.left = "-10000px";
    zoomEl.hidden = false;
    zoomFor = anchor;

    const reposition = () => {
      // Если за время raf пользователь уже отвёл мышь / открыл другой
      // zoom — не позиционируем. hideZoom уже сработал отдельно.
      if (zoomFor !== anchor || !anchor.isConnected) return;
      const r = anchor.getBoundingClientRect();
      const zr = zoomEl.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      let left = r.right + 12;
      if (left + zr.width > vw - 8) {
        left = Math.max(8, r.left - zr.width - 12);
      }
      let top = r.top;
      if (top + zr.height > vh - 8) {
        top = Math.max(8, vh - zr.height - 8);
      }
      zoomEl.style.left = left + "px";
      zoomEl.style.top = top + "px";
    };

    requestAnimationFrame(reposition);
    const img = zoomEl.querySelector("img");
    if (img && !img.complete) {
      img.addEventListener("load", () => requestAnimationFrame(reposition),
                          { once: true });
    }
  }

  function hideZoom() {
    if (zoomTimer) { clearTimeout(zoomTimer); zoomTimer = null; }
    if (zoomEl) {
      zoomEl.hidden = true;
      zoomEl.style.left = "-10000px";
    }
    zoomFor = null;
  }

  // mouseenter/mouseleave не bubble и не работают через делегацию. Поэтому
  // используем mouseover/mouseout + relatedTarget guard: переход между
  // потомками одного thumb не должен считаться уходом.
  $("chat-feed").addEventListener("mouseover", (ev) => {
    const t = ev.target.closest(".chat-media-thumb");
    if (!t) return;
    // Уже навели на этот же thumb — таймер не перезапускаем.
    if (zoomFor === t) return;
    const from = ev.relatedTarget;
    if (from && t.contains(from)) return;
    const url = t.dataset.zoomUrl || "";
    if (!url) return;
    if (zoomTimer) clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => showZoom(t, url), 350);
  });
  $("chat-feed").addEventListener("mouseout", (ev) => {
    const t = ev.target.closest(".chat-media-thumb");
    if (!t) return;
    const to = ev.relatedTarget;
    // Уход на потомка того же thumb — не считаем выходом, оверлей живёт.
    if (to && t.contains(to)) return;
    hideZoom();
  });
  // Safety-net: если пользователь перевёл фокус мыши на тело страницы вне
  // .chat-feed (через scroll, alt+tab, …) — гарантированно прячем оверлей.
  document.addEventListener("mousemove", (ev) => {
    if (!zoomFor) return;
    const r = zoomFor.getBoundingClientRect();
    const x = ev.clientX, y = ev.clientY;
    // Outside текущего thumb по ОБЕИМ осям + outside зоны самого overlay
    // (overlay pointer-events:none, но координатно может перекрывать).
    const insideThumb = x >= r.left - 2 && x <= r.right + 2
                     && y >= r.top - 2 && y <= r.bottom + 2;
    if (insideThumb) return;
    const zr = zoomEl && !zoomEl.hidden ? zoomEl.getBoundingClientRect() : null;
    const insideZoom = zr
      && x >= zr.left - 2 && x <= zr.right + 2
      && y >= zr.top - 2 && y <= zr.bottom + 2;
    if (insideZoom) return;
    hideZoom();
  });
  window.addEventListener("scroll", hideZoom, true);
  window.addEventListener("blur", hideZoom);

  // Скачивание: перехватываем клик, шлём fetch с Authorization Bearer
  // (cross-origin cookies в Brave/Yandex/ETP могут не доходить — Bearer
  // фолбэк надёжнее). Получаем blob, сохраняем через программный <a>.
  $("chat-feed").addEventListener("click", async (ev) => {
    const btn = ev.target.closest(".chat-media-dl");
    if (!btn) return;
    const href = btn.dataset.dlHref;
    const name = btn.dataset.dlName || "file";
    if (!href) return;
    ev.preventDefault();
    let tok = "";
    try { tok = localStorage.getItem("officer_session_token") || ""; }
    catch (_) {}
    const origLabel = btn.textContent;
    btn.textContent = "…";
    try {
      const r = await fetch(href, {
        credentials: "include",
        headers: tok ? { "Authorization": "Bearer " + tok } : {},
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const blob = await r.blob();
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objUrl;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
      btn.textContent = "✓";
      setTimeout(() => { btn.textContent = origLabel; }, 1000);
    } catch (e) {
      btn.textContent = origLabel;
      console.error("download failed:", e);
      alert("Не удалось скачать файл: " + (e.message || e));
    }
  });

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
