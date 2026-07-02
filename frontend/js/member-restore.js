// Возврат состава: резервный ростер участников чатов с профилями и ссылками
// для приглашения назад. Показывает актуальность (в чате сейчас / был до даты),
// ведёт историю датированных снимков.
(async function () {
  const $ = (id) => document.getElementById(id);

  let me;
  try {
    me = await API.me();
  } catch (e) {
    if (e && (e.status === 401 || e.status === 403)) {
      window.location.href = "login.html?_=" + Date.now();
    } else {
      document.body.innerHTML =
        "<div style='padding:30px;color:#ff6;font-family:monospace'>"
        + "Не удалось подключиться к backend.<br>Ошибка: "
        + (e && (e.detail || e.message) || "unknown")
        + "<br><br><a href='index.html' style='color:#0f0'>Вернуться</a></div>";
    }
    return;
  }
  if (me.role !== "officer" && me.role !== "admin") {
    window.location.href = "clan-valor.html";
    return;
  }
  document.documentElement.classList.remove("booting");
  document.body.setAttribute("data-role", me.role);
  const isAdmin = me.role === "admin";
  $("who").textContent =
    `${isAdmin ? "АДМИНИСТРАТОР" : "ОФИЦЕР"} • ${me.name}`;
  if (isAdmin) { const t = $("settings-tab"); if (t) t.hidden = false; }
  $("logout-btn").addEventListener("click", async () => {
    try { await API.logout(); } catch (_) {}
    window.location.href = "login.html?_=" + Date.now();
  });

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function toast(msg) {
    const t = $("mr-toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, 3000);
  }

  function fmtDay(d) {
    if (!d) return "";
    const p = d.split("-"); return p.length === 3 ? `${p[2]}.${p[1]}.${p[0]}` : d;
  }
  function agoSuffix(m) {
    const da = m.days_ago;
    if (da == null) return "";
    return da <= 0 ? " · сегодня" : da === 1 ? " · вчера" : ` · ${da} дн. назад`;
  }
  function agoText(m) {
    if (m.registered) {
      if (m.active) return "🟢 в составе (по сверке)";
      return m.last_active_day
        ? `⚪ вышел · был до ${fmtDay(m.last_active_day)}${agoSuffix(m)}`
        : "⚪ вышел из чатов";
    }
    // незарегистрированный — известно только когда писал
    const msgs = m.msgs ? ` · ${m.msgs} сообщ.` : "";
    return m.last_active_day
      ? `✍ не в реестре · писал до ${fmtDay(m.last_active_day)}${agoSuffix(m)}${msgs}`
      : `✍ не в реестре${msgs}`;
  }

  function avatarHtml(m) {
    const url = m.tg_avatar_url || m.vk_avatar_url || "";
    if (url) return `<img class="mr-ava" src="${esc(url)}" alt="" loading="lazy"
      onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'mr-ava mr-ava-ph',textContent:'👤'}))">`;
    return `<div class="mr-ava mr-ava-ph">👤</div>`;
  }

  function linksHtml(m) {
    const L = m.links || {};
    const out = [];
    if (L.tg) out.push(`<a class="mr-link mr-tg" href="${esc(L.tg)}" target="_blank" rel="noopener" title="Написать/позвать в Telegram">✈ TG</a>`);
    if (L.vk) out.push(`<a class="mr-link mr-vk" href="${esc(L.vk)}" target="_blank" rel="noopener" title="Открыть VK">🅅 VK</a>`);
    if (!out.length) out.push(`<span class="mr-link mr-none" title="Нет ссылки — только id">без ссылки</span>`);
    return out.join(" ");
  }

  function cardHtml(m) {
    const nicks = (m.game_nick || "").split(",").map(s => s.trim()).filter(Boolean);
    const cur = nicks[0] || (m.registered ? "—" : (m.display_name || "—"));
    const aka = nicks.slice(1);
    const badge = m.registered
      ? `<span class="mr-badge mr-reg-b">реестр</span>`
      : `<span class="mr-badge mr-unreg-b">из чата</span>`;
    const plat = (m.has_tg ? "TG" : "") + (m.has_tg && m.has_vk ? "+" : "") + (m.has_vk ? "VK" : "");
    return `<div class="mr-card${m.active ? " mr-on" : ""}${m.registered ? "" : " mr-unreg"}">
      ${avatarHtml(m)}
      <div class="mr-body">
        <div class="mr-nick">${esc(cur)} ${badge}<span class="mr-plat">${plat}</span></div>
        ${aka.length ? `<div class="mr-aka">ранее: ${esc(aka.join(", "))}</div>` : ""}
        <div class="mr-name">${esc(m.display_name || "")}</div>
        <div class="mr-status">${agoText(m)}</div>
      </div>
      <div class="mr-links">${linksHtml(m)}
        <button class="mr-detail-btn" data-key="${esc(m.key)}" title="Полная информация TG / VK + копирование" aria-label="Подробнее">ⓘ</button>
      </div>
    </div>`;
  }

  let roster = [];
  let asOf = "";
  let isLive = false;

  function renderAsOf() {
    if (isLive) {
      $("mr-asof").innerHTML =
        `📌 «В чате сейчас» — по <b>живому опросу</b> состава чатов от <b>${fmtDay(asOf)}</b>
         (все участники VK+TG, включая незарегистрированных). Обновляется авто-сверкой.`;
    } else {
      $("mr-asof").innerHTML = asOf
        ? `📌 Состав — по последней сверке (reconcile) от <b>${fmtDay(asOf)}</b>
           (живого опроса ещё не было; незарегистрированные — по дате, когда писали).`
        : `📌 Сверка состава ещё не проводилась — статусы приблизительные.`;
    }
  }

  function render() {
    const q = ($("mr-filter").value || "").trim().toLowerCase();
    const plat = $("mr-platform").value;
    const reg = $("mr-reg").value;
    const sort = $("mr-sort").value;
    let list = roster.filter(m => {
      if (plat === "tg" && !m.has_tg) return false;
      if (plat === "vk" && !m.has_vk) return false;
      if (plat === "both" && !(m.has_tg && m.has_vk)) return false;
      if (reg === "reg" && !m.registered) return false;
      if (reg === "unreg" && m.registered) return false;
      if (!q) return true;
      return [m.display_name, m.game_nick, m.tg_username, m.vk_screen_name,
              m.tg_id, m.vk_id].some(v => String(v || "").toLowerCase().includes(q));
    });
    if (sort === "name") {
      list = list.slice().sort((a, b) =>
        (a.display_name || a.game_nick || "").localeCompare(b.display_name || b.game_nick || "", "ru"));
    } else if (sort === "tg") {
      // сначала с TG (по username/id), потом без
      list = list.slice().sort((a, b) =>
        (b.has_tg - a.has_tg) ||
        String(a.tg_username || a.tg_id || "").localeCompare(String(b.tg_username || b.tg_id || ""), "ru"));
    } else if (sort === "vk") {
      list = list.slice().sort((a, b) =>
        (b.has_vk - a.has_vk) ||
        String(a.vk_screen_name || a.vk_id || "").localeCompare(String(b.vk_screen_name || b.vk_id || ""), "ru"));
    }
    // recency — уже отсортировано сервером (в составе → свежие → давние)
    $("mr-list").innerHTML = list.map(cardHtml).join("");
    $("mr-empty").hidden = list.length > 0;
    const act = roster.filter(m => m.active).length;
    const unreg = roster.filter(m => !m.registered).length;
    $("mr-stats").innerHTML =
      `Показано <b>${list.length}</b> · в составе (сверка) <b>${act}</b> · ` +
      `не в реестре (из чата) <b>${unreg}</b> · всего помним <b>${roster.length}</b>`;
  }

  async function loadRoster() {
    $("mr-loading").hidden = false;
    try {
      const rd = $("mr-recent").value;
      const resp = await API.membersRestoreRoster(rd === "" ? null : rd);
      roster = (resp && resp.members) || [];
      asOf = (resp && resp.as_of) || "";
      isLive = !!(resp && resp.live);
      renderAsOf();
      render();
    } catch (e) {
      toast("Ошибка: " + (e.detail || e.message));
    } finally {
      $("mr-loading").hidden = true;
    }
  }

  async function loadSnaps() {
    try {
      const snaps = await API.membersSnapshots();
      $("mr-snaps").innerHTML = snaps.length
        ? snaps.map(s => `<button class="mr-snap" data-day="${esc(s.day)}">
            <span class="mr-snap-day">${fmtDay(s.day)}</span>
            <span class="mr-snap-cnt">${s.active_count} в чате · ${s.member_count} всего</span>
          </button>`).join("")
        : `<div class="hint">Снимков пока нет — появятся с ежедневным сбором (или нажми «Снять снимок сейчас»).</div>`;
      $("mr-snaps").querySelectorAll(".mr-snap").forEach(b =>
        b.addEventListener("click", () => showDay(b.dataset.day)));
    } catch (_) {}
  }

  async function showDay(day) {
    const ov = $("mr-day-modal");
    ov.innerHTML = `<div class="ce-box ce-box-wide"><div class="ce-h">Загрузка…</div></div>`;
    ov.hidden = false;
    ov.onclick = (e) => { if (e.target === ov) ov.hidden = true; };
    let list = [];
    try { list = await API.membersSnapshotByDay(day); } catch (_) {}
    const act = list.filter(m => m.is_active).length;
    const rows = list.map(m => {
      const L = m.links || {};
      const nicks = (m.game_nick || "").split(",").map(s => s.trim()).filter(Boolean);
      return `<tr>
        <td>${m.is_active ? "🟢" : "⚪"}</td>
        <td><b>${esc(nicks[0] || "—")}</b></td>
        <td>${esc(m.display_name || "")}</td>
        <td>${L.tg ? `<a href="${esc(L.tg)}" target="_blank" rel="noopener">TG</a>` : "—"}
            ${L.vk ? ` · <a href="${esc(L.vk)}" target="_blank" rel="noopener">VK</a>` : ""}</td>
      </tr>`;
    }).join("");
    ov.innerHTML = `<div class="ce-box ce-box-wide">
      <div class="ce-h">Состав на ${fmtDay(day)} — ${act} в чате из ${list.length}</div>
      <table class="ce-dep-table"><thead><tr><th></th><th>Ник</th><th>Имя</th><th>Ссылки</th></tr></thead>
        <tbody>${rows}</tbody></table>
      <div class="ce-btns"><button id="mr-day-close" class="ce-cancel">Закрыть</button></div>
    </div>`;
    ov.querySelector("#mr-day-close").onclick = () => { ov.hidden = true; };
  }

  // ─────────── Полная карточка TG/VK + копирование ───────────
  async function copyText(txt) {
    txt = String(txt == null ? "" : txt);
    try {
      await navigator.clipboard.writeText(txt);
    } catch (_) {
      const ta = document.createElement("textarea");
      ta.value = txt; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.focus(); ta.select();
      try { document.execCommand("copy"); } catch (e) {}
      ta.remove();
    }
    toast("Скопировано: " + (txt.length > 44 ? txt.slice(0, 44) + "…" : txt));
  }

  const tgFull = (m) => [m.tg_first_name, m.tg_last_name].filter(Boolean).join(" ").trim();
  const vkFull = (m) => [m.vk_first, m.vk_last].filter(Boolean).join(" ").trim();
  const tgU = (m) => (m.tg_username || "").replace(/^@/, "");

  function fieldRow(label, value, copyVal) {
    if (value == null || value === "") return "";
    const cv = copyVal != null ? copyVal : value;
    return `<div class="mrd-row"><span class="mrd-label">${esc(label)}</span>` +
      `<span class="mrd-val">${esc(value)}</span>` +
      `<button class="mrd-copy" data-copy="${esc(String(cv))}" title="Копировать">⧉</button></div>`;
  }
  function linkRow(label, url) {
    if (!url) return "";
    return `<div class="mrd-row"><span class="mrd-label">${esc(label)}</span>` +
      `<a class="mrd-val mrd-link" href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>` +
      `<button class="mrd-copy" data-copy="${esc(url)}" title="Копировать ссылку">⧉</button></div>`;
  }

  function detailText(m) {
    const nicks = (m.game_nick || "").split(",").map(s => s.trim()).filter(Boolean);
    const L = [`${nicks[0] || m.display_name || "—"}  (${m.display_name || ""})`];
    if (m.has_tg) {
      L.push("Telegram:");
      if (m.tg_id) L.push("  id: " + m.tg_id);
      if (tgU(m)) L.push("  @" + tgU(m));
      if (tgFull(m)) L.push("  имя: " + tgFull(m));
      if (tgU(m)) L.push("  https://t.me/" + tgU(m));
      if (m.tg_id) L.push("  tg://user?id=" + m.tg_id);
    }
    if (m.has_vk) {
      L.push("VK:");
      if (m.vk_id) L.push("  id: " + m.vk_id);
      if (m.vk_screen_name) L.push("  screen: " + m.vk_screen_name);
      if (vkFull(m) || m.vk_display) L.push("  имя: " + (vkFull(m) || m.vk_display));
      if (m.vk_screen_name) L.push("  https://vk.com/" + m.vk_screen_name);
      if (m.vk_id) L.push("  https://vk.com/id" + m.vk_id);
    }
    return L.join("\n");
  }

  function showDetail(key) {
    const m = roster.find(x => x.key === key);
    if (!m) return;
    const ov = $("mr-detail");
    const nicks = (m.game_nick || "").split(",").map(s => s.trim()).filter(Boolean);
    const tgSec = m.has_tg ? `<div class="mrd-sec"><div class="mrd-h">✈ Telegram</div>
        ${fieldRow("ID", m.tg_id)}
        ${fieldRow("Username", tgU(m) ? "@" + tgU(m) : "", tgU(m))}
        ${fieldRow("Имя", tgFull(m))}
        ${fieldRow("Отображаемое", m.tg_display)}
        ${tgU(m) ? linkRow("Ссылка", "https://t.me/" + tgU(m)) : ""}
        ${m.tg_id ? linkRow("По ID", "tg://user?id=" + m.tg_id) : ""}</div>` : "";
    const vkSec = m.has_vk ? `<div class="mrd-sec"><div class="mrd-h">🅅 VK</div>
        ${fieldRow("ID", m.vk_id)}
        ${fieldRow("Screen name", m.vk_screen_name)}
        ${fieldRow("Имя", vkFull(m))}
        ${fieldRow("Отображаемое", m.vk_display)}
        ${m.vk_screen_name ? linkRow("Ссылка", "https://vk.com/" + m.vk_screen_name) : ""}
        ${m.vk_id ? linkRow("По ID", "https://vk.com/id" + m.vk_id) : ""}</div>` : "";
    const genSec = `<div class="mrd-sec"><div class="mrd-h">Клан</div>
        ${nicks.length ? fieldRow("Игровой ник", nicks[0]) : ""}
        ${nicks.length > 1 ? fieldRow("Другие ники", nicks.slice(1).join(", ")) : ""}
        ${fieldRow("Статус", m.registered ? (m.active ? "в составе (по сверке)" : "вышел") : "не в реестре (из чата)")}
        ${m.last_active_day ? fieldRow(m.registered ? "Был в составе до" : "Писал до", fmtDay(m.last_active_day)) : ""}
        ${m.msgs != null ? fieldRow("Сообщений в чате", String(m.msgs)) : ""}</div>`;
    const ava = m.tg_avatar_url || m.vk_avatar_url;
    ov.innerHTML = `<div class="ce-box ce-box-wide mrd-box">
      <div class="mrd-head">
        ${ava ? `<img class="mr-ava" src="${esc(ava)}" alt="">` : `<div class="mr-ava mr-ava-ph">👤</div>`}
        <div><div class="ce-h" style="margin:0">${esc(nicks[0] || m.display_name || "—")}</div>
          <div class="mr-name">${esc(m.display_name || "")}</div></div>
      </div>
      ${tgSec}${vkSec}${genSec}
      <div class="ce-btns">
        <button id="mrd-copyall" class="ce-save">⧉ Скопировать весь профиль</button>
        <button id="mrd-close" class="ce-cancel">Закрыть</button>
      </div></div>`;
    ov.hidden = false;
    ov.onclick = (e) => { if (e.target === ov) ov.hidden = true; };
    ov.querySelector("#mrd-close").onclick = () => { ov.hidden = true; };
    ov.querySelector("#mrd-copyall").onclick = () => copyText(detailText(m));
    ov.querySelectorAll(".mrd-copy").forEach(b =>
      b.addEventListener("click", () => copyText(b.dataset.copy)));
  }

  $("mr-list").addEventListener("click", (e) => {
    const b = e.target.closest(".mr-detail-btn");
    if (b) showDetail(b.dataset.key);
  });
  $("mr-recent").addEventListener("change", loadRoster);
  $("mr-filter").addEventListener("input", render);
  $("mr-platform").addEventListener("change", render);
  $("mr-reg").addEventListener("change", render);
  $("mr-sort").addEventListener("change", render);
  $("mr-capture").addEventListener("click", async () => {
    $("mr-capture").disabled = true;
    try {
      const r = await API.membersSnapshotCapture();
      toast(`Снимок сделан: ${r.active} в чате из ${r.members}`);
      await loadRoster(); await loadSnaps();
    } catch (e) { toast("Ошибка: " + (e.detail || e.message)); }
    finally { $("mr-capture").disabled = false; }
  });

  await loadRoster();
  await loadSnaps();
})();
