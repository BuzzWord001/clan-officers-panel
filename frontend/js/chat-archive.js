// Архив переписки TG/VK. Лента в обратном хронологическом порядке,
// фильтры (чат / даты / автор / поиск), lazy-load по before_id.
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

  const roleLabel = me.role === "admin" ? "АДМИНИСТРАТОР"
                  : me.role === "officer" ? "ОФИЦЕР"
                  : me.role.toUpperCase();
  $("who").textContent = `${roleLabel} • ${me.name}`;
  if (me.role === "admin") {
    const tab = $("settings-tab");
    if (tab) tab.hidden = false;
  }
  $("logout-btn").addEventListener("click", async () => {
    try { await API.logout(); } catch (_) {}
    window.location.href = "login.html";
  });

  // Текущий стек загруженных сообщений (новые сверху).
  let loaded = [];
  // Минимальный id страницы — для следующего before_id.
  let oldestId = null;
  // Текущие фильтры, чтобы load-more подгружал ту же выборку.
  let activeFilters = {};

  function fmtTs(iso) {
    if (!iso) return "";
    // sent_at от ботов идёт уже как ISO в UTC (без 'Z') — парсим как UTC.
    const d = new Date(iso.endsWith("Z") ? iso : iso + "Z");
    return d.toLocaleString("ru-RU", {
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  }

  function platformBadge(p) {
    if (p === "tg") return "TG";
    if (p === "vk") return "VK";
    return p.toUpperCase();
  }

  function groupLabel(g) {
    if (g === "general") return "общий";
    if (g === "officers") return "офицерский";
    return g;
  }

  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;",
      '"': "&quot;", "'": "&#39;",
    }[c]));
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

  function formatBytes(b) {
    if (!b) return "";
    if (b < 1024) return b + "Б";
    if (b < 1024 * 1024) return Math.round(b / 1024) + "КБ";
    return (b / (1024 * 1024)).toFixed(1) + "МБ";
  }

  function renderMessage(m) {
    const reply = m.reply_to_msg_id
      ? `<div class="chat-reply">↩ ответ на сообщение ${escapeHtml(m.reply_to_msg_id)}</div>`
      : "";
    const text = m.text ? `<div class="chat-text">${escapeHtml(m.text)}</div>` : "";
    const media = renderMedia(m.media);
    return `
      <div class="chat-msg chat-msg-${m.platform}" data-id="${m.id}">
        <div class="chat-head">
          <span class="chat-author">${escapeHtml(m.user_display)}</span>
          ${m.user_username ? `<span class="chat-username">@${escapeHtml(m.user_username)}</span>` : ""}
          <span class="chat-badge chat-badge-${m.platform}">${platformBadge(m.platform)}</span>
          <span class="chat-group-tag">${groupLabel(m.chat_group)}</span>
          <span class="chat-time">${fmtTs(m.sent_at)}</span>
        </div>
        ${reply}
        ${text}
        ${media}
      </div>
    `;
  }

  function render(reset) {
    const feed = $("chat-feed");
    if (reset) feed.innerHTML = "";
    const html = loaded.map(renderMessage).join("");
    feed.innerHTML = html;
    $("empty-state").hidden = loaded.length > 0;
    $("load-more-wrap").hidden = loaded.length === 0
      || loaded.length < PAGE_SIZE
      || loaded.length % PAGE_SIZE !== 0;
  }

  function collectFilters() {
    return {
      chat_group: $("f-group").value || undefined,
      date_from: $("f-from").value || undefined,
      date_to: $("f-to").value || undefined,
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
  }

  async function applyFilters() {
    activeFilters = collectFilters();
    oldestId = null;
    await load(true);
    await refreshStats();
  }

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

  $("apply-btn").addEventListener("click", applyFilters);
  $("reset-btn").addEventListener("click", () => {
    $("f-group").value = "";
    $("f-from").value = "";
    $("f-to").value = "";
    $("f-user").value = "";
    $("f-search").value = "";
    applyFilters();
  });
  $("load-more-btn").addEventListener("click", () => load(false));
  $("f-search").addEventListener("keydown", e => {
    if (e.key === "Enter") applyFilters();
  });
  $("f-user").addEventListener("keydown", e => {
    if (e.key === "Enter") applyFilters();
  });

  await applyFilters();
})();
