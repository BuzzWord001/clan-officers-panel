/* Глобальный поиск по ВСЕМ разделам сайта (вверху слева в шапке).
 * Показывает, есть ли человек на сайте вообще и в каких он разделах сейчас:
 * Реестр, Доблесть (сейчас/был), Покинул клан, Кикнут, Чаты — плюс его роли.
 * Self-inject: подключается на любой странице с .topbar. Требует api.js (API). */
(function () {
  "use strict";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // Раздел → подпись, цвет-класс, страница (focus=canon где поддерживается).
  const SECTIONS = {
    valor_current:     { label: "Доблесть · сейчас", cls: "gs-cur",  page: "clan-valor.html", focus: true },
    registry:          { label: "Реестр",            cls: "gs-reg",  page: "index.html" },
    chat:              { label: "Чаты",              cls: "gs-chat", page: "chat-members.html" },
    departed:          { label: "Покинул клан",      cls: "gs-dep",  page: "clan-valor.html", focus: true },
    force_archived:    { label: "Кикнут",            cls: "gs-kick", page: "clan-valor.html", focus: true },
    valor_ever:        { label: "Доблесть · был",    cls: "gs-ever", page: "clan-valor.html", focus: true },
    registry_archived: { label: "Реестр · архив",    cls: "gs-rega", page: "index.html" },
  };
  const ROLES = {
    elite:   { label: "Элита",   icon: "⚔", cls: "gs-r-elite" },
    veteran: { label: "Ветеран", icon: "★", cls: "gs-r-vet" },
    officer: { label: "Офицер",  icon: "✦", cls: "gs-r-off" },
  };

  function inject() {
    const bar = document.querySelector(".topbar");
    if (!bar || document.getElementById("gs-wrap")) return;
    const wrap = document.createElement("div");
    wrap.id = "gs-wrap";
    wrap.className = "gs-wrap";
    wrap.innerHTML =
      '<span class="gs-ic" aria-hidden="true">🔍</span>' +
      '<input id="gs-input" class="gs-input" type="text" autocomplete="off" ' +
      'placeholder="Поиск ника по сайту">' +
      '<div id="gs-drop" class="gs-drop" hidden></div>';
    const brand = bar.querySelector(".brand");
    if (brand && brand.nextSibling) bar.insertBefore(wrap, brand.nextSibling);
    else bar.appendChild(wrap);
    wire(wrap);
  }

  function wire(wrap) {
    const input = wrap.querySelector("#gs-input");
    const drop = wrap.querySelector("#gs-drop");
    let timer = null, lastQ = "";

    function close() { drop.hidden = true; }

    function render(results, q) {
      if (!results.length) {
        drop.innerHTML = '<div class="gs-empty">Никого не нашлось по «' + esc(q) + '»</div>';
        drop.hidden = false;
        return;
      }
      drop.innerHTML =
        '<div class="gs-head">Найдено: <b>' + results.length + '</b></div>' +
        results.map((r) => {
          const roles = (r.roles || []).filter((t) => ROLES[t]).map((t) => {
            const m = ROLES[t];
            return '<span class="gs-role ' + m.cls + '">' + m.icon + " " + esc(m.label) + "</span>";
          }).join("");
          const secs = (r.sections || []).map((s) => {
            const m = SECTIONS[s];
            if (!m) return "";
            const href = m.page + (m.focus ? "?focus=" + encodeURIComponent(r.canon) : "");
            return '<a class="gs-sec ' + m.cls + '" href="' + href + '">' + esc(m.label) + "</a>";
          }).join("");
          return '<div class="gs-row"><div class="gs-nick">' + esc(r.nick) + " " + roles + "</div>" +
                 '<div class="gs-secs">' + (secs || '<span class="gs-nosec">нет в разделах</span>') + "</div></div>";
        }).join("");
      drop.hidden = false;
    }

    async function run(q) {
      try {
        const data = await API.globalSearch(q);
        if (q !== lastQ) return;                 // пришёл устаревший ответ
        render((data && data.results) || [], q);
      } catch (e) {
        if (e && e.status === 403) { close(); return; }   // гость — тихо прячем
        drop.innerHTML = '<div class="gs-empty">Поиск временно недоступен</div>';
        drop.hidden = false;
      }
    }

    input.addEventListener("input", () => {
      const q = input.value.trim();
      lastQ = q;
      if (timer) clearTimeout(timer);
      if (q.length < 2) { close(); return; }
      drop.innerHTML = '<div class="gs-empty">Ищу…</div>';
      drop.hidden = false;
      timer = setTimeout(() => run(q), 220);
    });
    input.addEventListener("focus", () => {
      if (input.value.trim().length >= 2 && drop.innerHTML) drop.hidden = false;
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { close(); input.blur(); }
    });
    document.addEventListener("click", (e) => { if (!wrap.contains(e.target)) close(); });
  }

  // Роль — как в chamber-door.js: сначала data-role/guest-mode на body, иначе API.me().
  function getRole() {
    var dr = document.body && document.body.getAttribute("data-role");
    if (dr) return Promise.resolve(dr);
    if (document.body && document.body.classList.contains("guest-mode"))
      return Promise.resolve("guest");
    return (window.API ? API.me() : Promise.reject())
      .then(function (m) { return (m && m.role) || ""; })
      .catch(function () { return ""; });
  }

  // Поиск виден ТОЛЬКО офицеру/админу — гостю бар не инжектим вовсе.
  function start() {
    getRole().then(function (role) {
      if (role === "officer" || role === "admin") inject();
    });
  }

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", start);
  else start();
})();
