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
    registry:          { label: "Реестр",            cls: "gs-reg",  page: "index.html", focus: true },
    chat:              { label: "Чаты",              cls: "gs-chat", page: "chat-members.html", focus: true },
    chat_left:         { label: "Вышел из чата",     cls: "gs-dep",  page: "chat-members.html", focus: true },
    departed:          { label: "Покинул клан",      cls: "gs-dep",  page: "clan-valor.html", focus: true },
    force_archived:    { label: "Кикнут",            cls: "gs-kick", page: "clan-valor.html", focus: true },
    valor_ever:        { label: "Доблесть · был",    cls: "gs-ever", page: "clan-valor.html", focus: true },
    registry_archived: { label: "Реестр · архив",    cls: "gs-rega", page: "index.html", focus: true },
  };
  const ROLES = {
    elite:   { label: "Элита",   icon: "⚔", cls: "gs-r-elite" },
    veteran: { label: "Ветеран", icon: "★", cls: "gs-r-vet" },
    officer: { label: "Офицер",  icon: "✦", cls: "gs-r-off" },
  };

  // Самодостаточные стили выпадашки — инжектим из JS (id-специфичность,
  // гарантированно применяются). Дропдаун лежит в <body>, поэтому НЕ полагаемся
  // на внешний styles.css (у части браузеров он кэшировался/не доезжал → окно
  // рисовалось без фона, крупным текстом и под линией). Здесь фон, z-index и
  // размеры зашиты жёстко.
  function injectStyle() {
    if (document.getElementById("gs-drop-style")) return;
    const st = document.createElement("style");
    st.id = "gs-drop-style";
    st.textContent =
      '#gs-drop{position:fixed;max-height:66vh;overflow-y:auto;background:#17100a;' +
        'border:1px solid rgba(224,162,74,.45);border-radius:10px;' +
        'box-shadow:0 16px 46px rgba(0,0,0,.72);padding:5px;z-index:5000;' +
        'font-family:system-ui,Segoe UI,Arial,sans-serif}' +
      '#gs-drop[hidden]{display:none}' +
      '#gs-drop .gs-head{font-size:11px;color:#a58c68;padding:4px 8px 6px}' +
      '#gs-drop .gs-head b{color:#ffd24a}' +
      '#gs-drop .gs-empty{font-size:12px;color:#a58c68;padding:10px;text-align:center}' +
      '#gs-drop .gs-row{padding:8px;border-radius:7px;border-bottom:1px solid rgba(224,162,74,.10)}' +
      '#gs-drop .gs-row:last-child{border-bottom:none}' +
      '#gs-drop .gs-row:hover{background:rgba(224,162,74,.07)}' +
      '#gs-drop .gs-nick{font-size:14px;font-weight:700;color:#f6ead2;margin-bottom:2px}' +
      '#gs-drop .gs-line{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin:5px 0 2px}' +
      '#gs-drop .gs-cap{font-size:9.5px;font-weight:700;letter-spacing:.4px;' +
        'text-transform:uppercase;color:#9a8360}' +
      '#gs-drop .gs-secs{display:flex;flex-wrap:wrap;gap:5px}' +
      '#gs-drop .gs-nosec{font-size:11px;color:#7a6a4a;font-style:italic}' +
      '#gs-drop .gs-sec{font-size:11px;font-weight:600;text-decoration:none;padding:3px 9px;' +
        'border-radius:11px;white-space:nowrap;border:1px solid currentColor;opacity:.95}' +
      '#gs-drop .gs-sec:hover{opacity:1;box-shadow:0 0 8px -1px currentColor}' +
      '#gs-drop .gs-role{font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:9px;' +
        'border:1px solid currentColor}' +
      '#gs-drop .gs-cur{color:#66d47f;background:rgba(80,220,120,.14)}' +
      '#gs-drop .gs-reg{color:#ffcf6a;background:rgba(255,200,90,.14)}' +
      '#gs-drop .gs-chat{color:#6fb0e6;background:rgba(90,150,220,.14)}' +
      '#gs-drop .gs-dep{color:#e0a0a0;background:rgba(220,120,120,.12)}' +
      '#gs-drop .gs-kick{color:#ff8a8a;background:rgba(255,90,90,.14)}' +
      '#gs-drop .gs-ever{color:#b39a6a;background:rgba(180,150,90,.10)}' +
      '#gs-drop .gs-rega{color:#c8a86a;background:rgba(200,160,90,.10)}' +
      '#gs-drop .gs-r-elite{color:#ff8a94;background:rgba(255,90,106,.16)}' +
      '#gs-drop .gs-r-vet{color:#ffd24a;background:rgba(255,200,80,.16)}' +
      '#gs-drop .gs-r-off{color:#ff9a44;background:rgba(255,150,70,.14)}' +
      // Кнопка-иконка поиска — видна ТОЛЬКО на телефоне (десктоп показывает строку целиком).
      '#gs-wrap .gs-toggle{display:none;align-items:center;justify-content:center;width:38px;height:38px;' +
        'flex:0 0 auto;border-radius:9px;border:1px solid rgba(224,162,74,.42);background:rgba(20,13,7,.72);' +
        'color:#e0a24a;font-size:16px;line-height:1;cursor:pointer;padding:0}' +
      '#gs-wrap .gs-toggle:active{background:rgba(28,18,9,.92)}' +
      // Телефон: строка поиска НЕ занимает место в шапке (не толкает таблицу вниз).
      // Свёрнута в иконку; по тапу поле разворачивается как плавающая строка (position:fixed из JS).
      '@media (max-width:720px){' +
        '#gs-wrap{order:2;flex:0 0 auto;width:auto;min-width:0;margin:0 6px 0 auto;position:static}' +
        '#gs-wrap .gs-ic{display:none}' +
        '#gs-wrap .gs-toggle{display:inline-flex}' +
        '#gs-wrap>#gs-input{display:none}' +
        '#gs-wrap.gs-open>#gs-input{display:block}' +
      '}';
    document.head.appendChild(st);
  }

  function inject() {
    const bar = document.querySelector(".topbar");
    if (!bar || document.getElementById("gs-wrap")) return;
    injectStyle();
    const wrap = document.createElement("div");
    wrap.id = "gs-wrap";
    wrap.className = "gs-wrap";
    wrap.innerHTML =
      '<button id="gs-toggle" class="gs-toggle" type="button" aria-label="Поиск по сайту">🔍</button>' +
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
    const toggle = wrap.querySelector("#gs-toggle");
    let timer = null, lastQ = "";

    function isMobile() { return window.matchMedia("(max-width:720px)").matches; }
    // На телефоне развёрнутое поле — плавающая строка ПОД шапкой (position:fixed),
    // чтобы не занимать место в шапке и не толкать таблицу вниз.
    function placeInput() {
      if (isMobile() && wrap.classList.contains("gs-open")) {
        const bar = document.querySelector(".topbar");
        const top = bar ? bar.getBoundingClientRect().bottom + 6 : 56;
        input.style.cssText = "display:block;position:fixed;top:" + Math.round(top) +
          "px;left:8px;right:8px;width:auto;z-index:5001;font-size:16px;padding:11px 12px 11px 14px";
      } else {
        input.style.cssText = "";   // десктоп/свёрнуто — по внешним стилям
      }
    }

    // Дропдаун в <body> и position:fixed — считаем позицию под строкой поиска.
    function place() {
      const r = input.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const w = isMobile() ? (vw - 16) : Math.min(440, vw * 0.88);
      let left = isMobile() ? 8 : r.left;
      if (left + w > vw - 8) left = Math.max(8, vw - 8 - w);
      drop.style.position = "fixed";
      drop.style.top = Math.round(r.bottom + 6) + "px";
      drop.style.left = Math.round(left) + "px";
      drop.style.width = Math.round(w) + "px";
      drop.style.right = "auto";
    }
    function open() { place(); drop.hidden = false; }
    function close() { drop.hidden = true; }
    function collapse() { wrap.classList.remove("gs-open"); close(); placeInput(); }

    if (toggle) toggle.addEventListener("click", function () {
      if (wrap.classList.contains("gs-open")) { collapse(); return; }
      wrap.classList.add("gs-open"); placeInput();
      input.focus();
      if (input.value.trim().length >= 2 && drop.innerHTML) open();
    });

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
            return '<a class="gs-sec ' + m.cls + '" href="' + href + '">' + esc(m.label) + " ›</a>";
          }).join("");
          // Явно разделяем: имя → роли (что за человек) → разделы (куда нажать,
          // чтобы открыть его карточку). Раньше роли и разделы сливались в кашу.
          return '<div class="gs-row">' +
                   '<div class="gs-nick">' + esc(r.nick) + '</div>' +
                   (roles ? '<div class="gs-line"><span class="gs-cap">Роли:</span>' + roles + '</div>' : '') +
                   '<div class="gs-line"><span class="gs-cap">Открыть карточку в разделе:</span></div>' +
                   '<div class="gs-secs">' +
                     (secs || '<span class="gs-nosec">пока нет ни в одном разделе</span>') +
                   '</div>' +
                 '</div>';
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
      if (e.key === "Escape") { collapse(); input.blur(); }
    });
    // дропдаун теперь в <body> — клик по нему НЕ должен считаться «вне» (иначе
    // закрывался бы до перехода по ссылке-результату). На телефоне клик вне
    // сворачивает плавающее поле обратно в иконку.
    document.addEventListener("click", (e) => {
      if (!wrap.contains(e.target) && !drop.contains(e.target)) {
        if (isMobile() && wrap.classList.contains("gs-open")) collapse(); else close();
      }
    });
    // position:fixed — держим под строкой при прокрутке/изменении размера окна.
    window.addEventListener("scroll", () => { placeInput(); if (!drop.hidden) place(); }, true);
    window.addEventListener("resize", () => {
      if (!isMobile()) wrap.classList.remove("gs-open");   // перешли на десктоп — строка снова целиком
      placeInput();
      if (!drop.hidden) place();
    });
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
