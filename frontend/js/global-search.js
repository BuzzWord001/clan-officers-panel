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
      'placeholder="Поиск ника по сайту">';
    const brand = bar.querySelector(".brand");
    if (brand && brand.nextSibling) bar.insertBefore(wrap, brand.nextSibling);
    else bar.appendChild(wrap);
    // Выпадашку кладём в <body>, а НЕ внутрь .topbar: обёртка .shell (z-index:2)
    // создаёт контекст наложения, который «топит» дропдаун под декоративным
    // #magic-social (z-index:40) — иконка Telegram и золотая линия перекрывали
    // результаты. В <body> дропдаун в корневом контексте, его z-index честно
    // побеждает; позиционируем его position:fixed под строкой поиска.
    const drop = document.createElement("div");
    drop.id = "gs-drop";
    drop.className = "gs-drop";
    drop.hidden = true;
    document.body.appendChild(drop);
    wire(wrap, drop);
  }

  function wire(wrap, drop) {
    const input = wrap.querySelector("#gs-input");
    let timer = null, lastQ = "";

    // Дропдаун в <body> и position:fixed — считаем позицию под строкой поиска.
    function place() {
      const r = input.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const w = Math.min(440, vw * 0.88);
      let left = r.left;
      if (left + w > vw - 8) left = Math.max(8, vw - 8 - w);
      drop.style.position = "fixed";
      drop.style.top = Math.round(r.bottom + 6) + "px";
      drop.style.left = Math.round(left) + "px";
      drop.style.width = Math.round(w) + "px";
      drop.style.right = "auto";
    }
    function open() { place(); drop.hidden = false; }
    function close() { drop.hidden = true; }

    function render(results, q) {
      if (!results.length) {
        drop.innerHTML = '<div class="gs-empty">Никого не нашлось по «' + esc(q) + '»</div>';
        open();
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
      open();
    }

    async function run(q) {
      try {
        const data = await API.globalSearch(q);
        if (q !== lastQ) return;                 // пришёл устаревший ответ
        render((data && data.results) || [], q);
      } catch (e) {
        if (e && e.status === 403) { close(); return; }   // гость — тихо прячем
        drop.innerHTML = '<div class="gs-empty">Поиск временно недоступен</div>';
        open();
      }
    }

    input.addEventListener("input", () => {
      const q = input.value.trim();
      lastQ = q;
      if (timer) clearTimeout(timer);
      if (q.length < 2) { close(); return; }
      drop.innerHTML = '<div class="gs-empty">Ищу…</div>';
      open();
      timer = setTimeout(() => run(q), 220);
    });
    input.addEventListener("focus", () => {
      if (input.value.trim().length >= 2 && drop.innerHTML) open();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { close(); input.blur(); }
    });
    // дропдаун теперь в <body> — клик по нему НЕ должен считаться «вне» (иначе
    // закрывался бы до перехода по ссылке-результату).
    document.addEventListener("click", (e) => {
      if (!wrap.contains(e.target) && !drop.contains(e.target)) close();
    });
    // position:fixed — держим под строкой при прокрутке/изменении размера окна.
    window.addEventListener("scroll", () => { if (!drop.hidden) place(); }, true);
    window.addEventListener("resize", () => { if (!drop.hidden) place(); });
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
