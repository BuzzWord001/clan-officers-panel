/* Тайная комната — дверь в правом верхнем углу.
 *
 * Видна ВСЕМ ролям (гость/офицер/админ). Клик:
 *   admin  → переход в раздел «Курсы волшебства» (magic-courses.html)
 *   иначе  → мистическая всплывашка «Вход только для администрации».
 *
 * Самодостаточный модуль: инжектит стили + DOM, роль узнаёт через API.me()
 * (cookie/Bearer) с кэшем на время жизни страницы. Подключать ПОСЛЕ api.js.
 */
(function () {
  "use strict";
  if (window.__cosDoorInit) return;
  window.__cosDoorInit = true;

  var TARGET = "magic-courses.html";
  var N_SNAKES = 8;

  // ── SVG двери (оригинальная графика, без копирайта) ──────────────────
  function snakeBolts() {
    var g = "";
    for (var i = 0; i < N_SNAKES; i++) {
      var ang = (360 / N_SNAKES) * i;
      // змея-засов: S-образное тело от обода к центру + голова у центра
      g += '<g transform="rotate(' + ang + ' 50 50)">' +
        '<path class="cos-snake" d="M50 12 C46 22 56 28 50 38 C45 46 53 50 50 50" ' +
        'fill="none" stroke="url(#cosBrass)" stroke-width="4.6" ' +
        'stroke-linecap="round"/>' +
        '<path d="M50 12 C46 22 56 28 50 38 C45 46 53 50 50 50" fill="none" ' +
        'stroke="#1c130a" stroke-width="5.6" stroke-linecap="round" opacity=".35"/>' +
        '<path class="cos-snake" d="M50 12 C46 22 56 28 50 38 C45 46 53 50 50 50" ' +
        'fill="none" stroke="url(#cosBrass)" stroke-width="3.4" ' +
        'stroke-linecap="round"/>' +
        '<circle cx="50" cy="11" r="3.1" fill="url(#cosBrass)" ' +
        'stroke="#1c130a" stroke-width=".7"/>' +
        '<circle cx="48.7" cy="10.3" r=".7" fill="#0c3b2a"/>' +
        '</g>';
    }
    return g;
  }

  function sparks() {
    var pts = [[24,22],[78,30],[70,74],[30,72],[18,52],[82,55],[50,16],[50,84]];
    var s = "";
    for (var i = 0; i < pts.length; i++) {
      s += '<circle class="cos-spark" cx="' + pts[i][0] + '" cy="' + pts[i][1] +
        '" r="1.05" fill="#bff7e0" style="animation-delay:' +
        (i * 0.5).toFixed(2) + 's"/>';
    }
    return s;
  }

  function doorSVG() {
    return '' +
'<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
  '<defs>' +
    '<radialGradient id="cosStone" cx="42%" cy="38%" r="68%">' +
      '<stop offset="0%" stop-color="#4a5360"/>' +
      '<stop offset="55%" stop-color="#2b313c"/>' +
      '<stop offset="100%" stop-color="#11151c"/>' +
    '</radialGradient>' +
    '<radialGradient id="cosCore" cx="50%" cy="45%" r="60%">' +
      '<stop offset="0%" stop-color="#1a5b44"/>' +
      '<stop offset="60%" stop-color="#0c3526"/>' +
      '<stop offset="100%" stop-color="#06150f"/>' +
    '</radialGradient>' +
    '<linearGradient id="cosBrass" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0%" stop-color="#f4e2a8"/>' +
      '<stop offset="45%" stop-color="#c79a4e"/>' +
      '<stop offset="100%" stop-color="#7c5a22"/>' +
    '</linearGradient>' +
  '</defs>' +
  // каменный обод
  '<circle cx="50" cy="50" r="48" fill="url(#cosStone)" stroke="#0a0d12" stroke-width="2"/>' +
  '<circle cx="50" cy="50" r="44" fill="none" stroke="#5b6675" stroke-width="1.1" opacity=".5"/>' +
  '<circle cx="50" cy="50" r="40.5" fill="none" stroke="#0a0d12" stroke-width="1.4" opacity=".7"/>' +
  // заклёпки по ободу
  riveTs() +
  // вращающееся кольцо змей-засовов
  '<g class="cos-bolts">' + snakeBolts() + '</g>' +
  // центральный медальон со свернувшейся змеёй
  '<circle cx="50" cy="50" r="15.5" fill="url(#cosCore)" stroke="url(#cosBrass)" stroke-width="1.6"/>' +
  '<path class="cos-coil" d="M50 41 a9 9 0 1 1 -8.6 11.6 a6 6 0 1 1 11-2.4 a3 3 0 1 1 -4.2 2.1" ' +
    'fill="none" stroke="#3df5b0" stroke-width="1.7" stroke-linecap="round"/>' +
  '<circle cx="50" cy="41" r="1.7" fill="#3df5b0"/>' +
  // искры + мерцающий блик
  sparks() +
  '<circle class="cos-sheen" cx="50" cy="50" r="48"/>' +
'</svg>';
  }

  function riveTs() {
    var s = "", n = 16;
    for (var i = 0; i < n; i++) {
      var a = (Math.PI * 2 / n) * i;
      var x = 50 + Math.cos(a) * 45.5, y = 50 + Math.sin(a) * 45.5;
      s += '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) +
        '" r="1.15" fill="#7d8796"/>';
    }
    return s;
  }

  // ── Стили ────────────────────────────────────────────────────────────
  var CSS =
  '.cos-door{position:fixed;top:14px;right:14px;width:74px;height:74px;z-index:1200;' +
    'cursor:pointer;border:0;background:none;padding:0;filter:drop-shadow(0 4px 10px rgba(0,0,0,.6));' +
    'transition:transform .25s ease;-webkit-tap-highlight-color:transparent}' +
  '.cos-door:hover{transform:scale(1.09) rotate(-2deg)}' +
  '.cos-door:active{transform:scale(.97)}' +
  '.cos-door svg{width:100%;height:100%;display:block;animation:cosGlow 4.5s ease-in-out infinite}' +
  '.cos-door:hover svg{animation-duration:2.2s}' +
  '.cos-bolts{transform-origin:50px 50px;animation:cosSpin 60s linear infinite}' +
  '.cos-door:hover .cos-bolts{animation-duration:14s}' +
  '.cos-coil{filter:drop-shadow(0 0 2px #3df5b0)}' +
  '.cos-sheen{fill:none;stroke:rgba(191,247,224,.0);stroke-width:0;' +
    'transform-origin:50px 50px}' +
  '.cos-door svg{overflow:visible}' +
  '.cos-spark{opacity:0;animation:cosSpark 3.2s ease-in-out infinite}' +
  '@keyframes cosGlow{0%,100%{filter:drop-shadow(0 0 2px rgba(61,245,176,.35))}' +
    '50%{filter:drop-shadow(0 0 9px rgba(61,245,176,.85)) drop-shadow(0 0 2px #bff7e0)}}' +
  '@keyframes cosSpin{to{transform:rotate(360deg)}}' +
  '@keyframes cosSpark{0%,100%{opacity:0;transform:scale(.4)}' +
    '8%{opacity:1;transform:scale(1)}20%{opacity:0;transform:scale(.4)}}' +
  '.cos-label{position:fixed;top:92px;right:10px;z-index:1200;pointer-events:none;' +
    'font:600 11px/1 system-ui,sans-serif;letter-spacing:.06em;color:#cdeede;' +
    'background:rgba(8,18,14,.86);border:1px solid rgba(61,245,176,.4);' +
    'padding:5px 9px;border-radius:7px;opacity:0;transform:translateY(-4px);' +
    'transition:opacity .2s,transform .2s;white-space:nowrap;text-shadow:0 0 6px rgba(61,245,176,.6)}' +
  '.cos-door:hover + .cos-label{opacity:1;transform:translateY(0)}' +
  /* мистическая всплывашка для не-админа */
  '.cos-deny{position:fixed;inset:0;z-index:3000;display:flex;align-items:center;' +
    'justify-content:center;background:radial-gradient(circle at 50% 40%,' +
    'rgba(6,21,15,.72),rgba(0,0,0,.88));backdrop-filter:blur(3px);' +
    'animation:cosFade .35s ease both}' +
  '.cos-deny[hidden]{display:none}' +
  '.cos-deny-box{position:relative;max-width:340px;margin:0 24px;padding:26px 26px 22px;' +
    'text-align:center;color:#e6f6ee;background:linear-gradient(180deg,#16241d,#0b1611);' +
    'border:1px solid rgba(61,245,176,.45);border-radius:14px;' +
    'box-shadow:0 0 40px rgba(61,245,176,.25),inset 0 0 30px rgba(0,0,0,.5);' +
    'animation:cosRise .4s cubic-bezier(.2,.9,.3,1.2) both}' +
  '.cos-deny-ico{width:60px;height:60px;margin:0 auto 10px;filter:drop-shadow(0 0 8px rgba(61,245,176,.6))}' +
  '.cos-deny-t{font:700 18px/1.3 Georgia,serif;letter-spacing:.02em;margin:0 0 6px;' +
    'color:#9ff0cf;text-shadow:0 0 10px rgba(61,245,176,.55)}' +
  '.cos-deny-s{font:400 13px/1.5 system-ui,sans-serif;color:#bcd6c9;opacity:.92;margin:0 0 16px}' +
  '.cos-deny-btn{font:600 13px system-ui,sans-serif;color:#06150f;cursor:pointer;' +
    'background:linear-gradient(180deg,#5ff0c0,#23b487);border:0;border-radius:8px;' +
    'padding:8px 22px;box-shadow:0 3px 12px rgba(61,245,176,.4)}' +
  '.cos-deny-btn:hover{filter:brightness(1.08)}' +
  '@keyframes cosFade{from{opacity:0}to{opacity:1}}' +
  '@keyframes cosRise{from{opacity:0;transform:translateY(14px) scale(.94)}' +
    'to{opacity:1;transform:none}}' +
  '@media(max-width:560px){.cos-door{width:58px;height:58px;top:10px;right:10px}' +
    '.cos-label{display:none}}' +
  '@media(prefers-reduced-motion:reduce){.cos-door svg,.cos-bolts,.cos-spark{animation:none}}';

  var SERPENT_ICON =
'<svg class="cos-deny-ico" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">' +
  '<path d="M50 18 a14 14 0 1 1 -13 19 a9 9 0 1 1 17-4 a5 5 0 1 1 -7 3" fill="none" ' +
  'stroke="#3df5b0" stroke-width="3.2" stroke-linecap="round"/>' +
  '<circle cx="50" cy="18" r="3" fill="#3df5b0"/></svg>';

  // ── Логика роли + всплывашка ─────────────────────────────────────────
  var _meCache = null;
  function getRole() {
    // сначала из data-role (если страница уже определила), иначе спросим API
    var dr = document.body && document.body.getAttribute("data-role");
    if (dr) return Promise.resolve(dr);
    if (_meCache) return _meCache;
    _meCache = (window.API ? API.me() : Promise.reject())
      .then(function (m) { return (m && m.role) || ""; })
      .catch(function () { return ""; });
    return _meCache;
  }

  function showDeny() {
    var ov = document.createElement("div");
    ov.className = "cos-deny";
    ov.innerHTML =
      '<div class="cos-deny-box" role="alertdialog" aria-live="assertive">' +
        SERPENT_ICON +
        '<div class="cos-deny-t">Вход только для администрации</div>' +
        '<div class="cos-deny-s">Тайная комната запечатана. Открыть её ' +
        'может лишь хранитель ключа.</div>' +
        '<button type="button" class="cos-deny-btn">Понятно</button>' +
      '</div>';
    function close() { ov.remove(); document.removeEventListener("keydown", onKey); }
    function onKey(e) { if (e.key === "Escape") close(); }
    ov.addEventListener("click", function (e) {
      if (e.target === ov || e.target.classList.contains("cos-deny-btn")) close();
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(ov);
  }

  function onDoorClick() {
    getRole().then(function (role) {
      if (role === "admin") {
        window.location.href = TARGET;
      } else {
        showDeny();
      }
    });
  }

  // Группа вкладок «тайная комната» (admin-only, как группа «админ»):
  // инжектим во ВСЕ .tabs на странице, чтобы у админа был постоянный
  // подраздел-навигатор, не правя каждый HTML. .admin-only гейтит CSS.
  function injectTabs() {
    var bars = document.querySelectorAll(".tabs");
    var onPage = /magic-courses\.html$/.test(location.pathname);
    bars.forEach(function (bar) {
      if (bar.querySelector("[data-cos]")) return;
      var sep = document.createElement("div");
      sep.className = "tabs-sep admin-only";
      sep.setAttribute("data-cos", "1");
      sep.setAttribute("aria-hidden", "true");
      var grp = document.createElement("div");
      grp.className = "tabs-group admin-only";
      grp.setAttribute("data-cos", "1");
      grp.innerHTML =
        '<span class="tabs-group-label">тайная комната</span>' +
        '<div class="tabs-group-links"><a href="' + TARGET + '"' +
        (onPage ? ' class="active"' : '') + '>Курсы волшебства</a></div>';
      bar.appendChild(sep);
      bar.appendChild(grp);
    });
  }

  // ── Инициализация ────────────────────────────────────────────────────
  function init() {
    injectTabs();
    if (document.querySelector(".cos-door")) return;
    var style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cos-door";
    btn.setAttribute("aria-label", "Тайная комната");
    btn.innerHTML = doorSVG();
    btn.addEventListener("click", onDoorClick);

    var label = document.createElement("div");
    label.className = "cos-label";
    label.textContent = "Тайная комната";

    document.body.appendChild(btn);
    document.body.appendChild(label);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
