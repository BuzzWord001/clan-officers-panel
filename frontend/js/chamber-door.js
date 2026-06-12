/* Тайная комната — дверь Выручай-комнаты в правом верхнем углу.
 *
 * Видна ВСЕМ ролям (гость/офицер/админ), посажена НИЖЕ верхних надписей и
 * чуть левее правого края, чтобы их не перекрывать. Клик:
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

  // ── SVG двери Выручай-комнаты (оригинальная графика, без копирайта) ───
  function woodPlanks() {
    var xs = [22, 28, 34, 50, 56, 62], s = "";
    for (var i = 0; i < xs.length; i++)
      s += '<line x1="' + xs[i] + '" y1="44" x2="' + xs[i] + '" y2="107" ' +
        'stroke="#1b1006" stroke-width="0.7" opacity=".55"/>';
    return s;
  }

  function ironStraps() {
    var ys = [52, 72, 92], s = "";
    for (var i = 0; i < ys.length; i++) {
      var y = ys[i];
      s += '<rect x="15" y="' + (y - 3) + '" width="54" height="6" rx="1.6" ' +
        'fill="url(#cosIron)" stroke="#0a0c10" stroke-width=".6"/>' +
        '<circle cx="17.5" cy="' + y + '" r="2.6" fill="url(#cosIron)" stroke="#0a0c10" stroke-width=".5"/>' +
        '<circle cx="66.5" cy="' + y + '" r="2.6" fill="url(#cosIron)" stroke="#0a0c10" stroke-width=".5"/>' +
        '<circle cx="22" cy="' + y + '" r=".85" fill="#0a0c10"/>' +
        '<circle cx="62" cy="' + y + '" r=".85" fill="#0a0c10"/>';
    }
    return s;
  }

  function sparks() {
    var pts = [[20,30],[64,34],[14,68],[70,74],[42,7],[26,102],[58,102],[42,58]];
    var s = "";
    for (var i = 0; i < pts.length; i++)
      s += '<circle class="cos-spark" cx="' + pts[i][0] + '" cy="' + pts[i][1] +
        '" r="1" fill="#ffe6ad" style="animation-delay:' + (i * 0.45).toFixed(2) + 's"/>';
    return s;
  }

  function doorSVG() {
    return '' +
'<svg viewBox="0 0 84 118" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
  '<defs>' +
    '<radialGradient id="cosGlow" cx="50%" cy="55%" r="60%">' +
      '<stop offset="0%" stop-color="#ffcf7a" stop-opacity=".9"/>' +
      '<stop offset="55%" stop-color="#c8821f" stop-opacity=".35"/>' +
      '<stop offset="100%" stop-color="#c8821f" stop-opacity="0"/>' +
    '</radialGradient>' +
    '<radialGradient id="cosStone" cx="42%" cy="32%" r="80%">' +
      '<stop offset="0%" stop-color="#525a66"/>' +
      '<stop offset="60%" stop-color="#363c47"/>' +
      '<stop offset="100%" stop-color="#181c24"/>' +
    '</radialGradient>' +
    '<linearGradient id="cosWoodL" x1="0" y1="0" x2="1" y2="0">' +
      '<stop offset="0%" stop-color="#23150a"/>' +
      '<stop offset="55%" stop-color="#5a3a1f"/>' +
      '<stop offset="100%" stop-color="#3a2412"/>' +
    '</linearGradient>' +
    '<linearGradient id="cosWoodR" x1="1" y1="0" x2="0" y2="0">' +
      '<stop offset="0%" stop-color="#23150a"/>' +
      '<stop offset="55%" stop-color="#5a3a1f"/>' +
      '<stop offset="100%" stop-color="#3a2412"/>' +
    '</linearGradient>' +
    '<linearGradient id="cosIron" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#5c636e"/>' +
      '<stop offset="50%" stop-color="#2b2f37"/>' +
      '<stop offset="100%" stop-color="#13161c"/>' +
    '</linearGradient>' +
    '<linearGradient id="cosBrass" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0%" stop-color="#f6e3a6"/>' +
      '<stop offset="50%" stop-color="#caa052"/>' +
      '<stop offset="100%" stop-color="#7c5a22"/>' +
    '</linearGradient>' +
  '</defs>' +
  // тёплое магическое свечение-ореол
  '<ellipse class="cos-aura" cx="42" cy="64" rx="42" ry="56" fill="url(#cosGlow)"/>' +
  // каменная арка-рама
  '<path d="M8,114 L8,40 A34,34 0 0 1 76,40 L76,114 Z" fill="url(#cosStone)" ' +
    'stroke="#0a0d12" stroke-width="2"/>' +
  '<path d="M8,40 A34,34 0 0 1 76,40" fill="none" stroke="#5b6675" stroke-width="1" opacity=".4"/>' +
  // тёмная ниша
  '<path d="M15,110 L15,40 A27,27 0 0 1 69,40 L69,110 Z" fill="#150c06"/>' +
  // две деревянные створки
  '<path d="M15,110 L15,40 A27,27 0 0 1 42,13 L42,110 Z" fill="url(#cosWoodL)"/>' +
  '<path d="M42,110 L42,13 A27,27 0 0 1 69,40 L69,110 Z" fill="url(#cosWoodR)"/>' +
  woodPlanks() +
  // резной арочный кант
  '<path d="M15,40 A27,27 0 0 1 69,40" fill="none" stroke="#1b1006" stroke-width="1.3" opacity=".6"/>' +
  '<path d="M19,40 A23,23 0 0 1 65,40" fill="none" stroke="url(#cosBrass)" stroke-width=".8" opacity=".55"/>' +
  // кованые полосы
  ironStraps() +
  // центральный шов + накладка
  '<rect x="40.4" y="13" width="3.2" height="97" fill="url(#cosIron)" stroke="#0a0c10" stroke-width=".4"/>' +
  // светящаяся щель — магия из комнаты
  '<rect class="cos-seam" x="41.3" y="15" width="1.4" height="93" fill="#ffd98a"/>' +
  // кольца-ручки
  '<circle cx="36.5" cy="74" r="3.3" fill="none" stroke="url(#cosBrass)" stroke-width="1.5"/>' +
  '<circle cx="47.5" cy="74" r="3.3" fill="none" stroke="url(#cosBrass)" stroke-width="1.5"/>' +
  '<circle cx="36.5" cy="70.6" r=".9" fill="url(#cosBrass)"/>' +
  '<circle cx="47.5" cy="70.6" r=".9" fill="url(#cosBrass)"/>' +
  // замковый камень с руной-звездой
  '<circle cx="42" cy="22" r="5" fill="#241a12" stroke="url(#cosBrass)" stroke-width="1.2"/>' +
  '<path class="cos-rune" d="M42 18 v8 M38 22 h8 M39.2 19.2 l5.6 5.6 M44.8 19.2 l-5.6 5.6" ' +
    'stroke="#ffe6ad" stroke-width="1" stroke-linecap="round"/>' +
  sparks() +
'</svg>';
  }

  // ── Стили ────────────────────────────────────────────────────────────
  var CSS =
  /* НИЖЕ верхних надписей (top:66) и ЛЕВЕЕ края (right:34) */
  '.cos-door{position:fixed;top:66px;right:34px;width:60px;height:90px;z-index:1100;' +
    'cursor:pointer;border:0;background:none;padding:0;' +
    'filter:drop-shadow(0 5px 12px rgba(0,0,0,.6));transition:transform .25s ease;' +
    '-webkit-tap-highlight-color:transparent}' +
  '.cos-door:hover{transform:scale(1.07) translateY(-1px)}' +
  '.cos-door:active{transform:scale(.97)}' +
  '.cos-door svg{width:100%;height:100%;display:block;overflow:visible;' +
    'animation:cosGlow 5s ease-in-out infinite}' +
  '.cos-door:hover svg{animation-duration:2.4s}' +
  '.cos-aura{opacity:.55;transform-origin:42px 64px;animation:cosAura 5s ease-in-out infinite}' +
  '.cos-seam{filter:drop-shadow(0 0 2px #ffd98a);animation:cosSeam 3.4s ease-in-out infinite}' +
  '.cos-rune{filter:drop-shadow(0 0 2px #ffe6ad)}' +
  '.cos-spark{opacity:0;animation:cosSpark 3.4s ease-in-out infinite}' +
  '@keyframes cosGlow{0%,100%{filter:drop-shadow(0 0 2px rgba(245,200,120,.35))}' +
    '50%{filter:drop-shadow(0 0 10px rgba(245,200,120,.8)) drop-shadow(0 0 3px #ffe6ad)}}' +
  '@keyframes cosAura{0%,100%{opacity:.4;transform:scale(.97)}50%{opacity:.7;transform:scale(1.04)}}' +
  '@keyframes cosSeam{0%,100%{opacity:.5}50%{opacity:1}}' +
  '@keyframes cosSpark{0%,100%{opacity:0;transform:scale(.4)}' +
    '8%{opacity:1;transform:scale(1)}22%{opacity:0;transform:scale(.4)}}' +
  '.cos-label{position:fixed;top:160px;right:24px;z-index:1100;pointer-events:none;' +
    'font:600 11px/1 system-ui,sans-serif;letter-spacing:.05em;color:#f3e4c2;' +
    'background:rgba(28,18,8,.88);border:1px solid rgba(224,162,74,.45);' +
    'padding:5px 9px;border-radius:7px;opacity:0;transform:translateY(-4px);' +
    'transition:opacity .2s,transform .2s;white-space:nowrap;' +
    'text-shadow:0 0 6px rgba(245,200,120,.6)}' +
  '.cos-door:hover + .cos-label{opacity:1;transform:translateY(0)}' +
  /* мистическая всплывашка для не-админа */
  '.cos-deny{position:fixed;inset:0;z-index:3000;display:flex;align-items:center;' +
    'justify-content:center;background:radial-gradient(circle at 50% 40%,' +
    'rgba(28,18,8,.7),rgba(0,0,0,.88));backdrop-filter:blur(3px);' +
    'animation:cosFade .35s ease both}' +
  '.cos-deny[hidden]{display:none}' +
  '.cos-deny-box{position:relative;max-width:350px;margin:0 24px;padding:26px 26px 22px;' +
    'text-align:center;color:#f3e8d6;background:linear-gradient(180deg,#2a1d0f,#160d06);' +
    'border:1px solid rgba(224,162,74,.5);border-radius:14px;' +
    'box-shadow:0 0 40px rgba(245,200,120,.22),inset 0 0 30px rgba(0,0,0,.5);' +
    'animation:cosRise .4s cubic-bezier(.2,.9,.3,1.2) both}' +
  '.cos-deny-ico{width:58px;height:58px;margin:0 auto 10px;display:block;' +
    'filter:drop-shadow(0 0 8px rgba(245,200,120,.6))}' +
  '.cos-deny-t{font:700 18px/1.3 Georgia,serif;letter-spacing:.02em;margin:0 0 6px;' +
    'color:#f0c878;text-shadow:0 0 10px rgba(245,200,120,.5)}' +
  '.cos-deny-s{font:400 13px/1.5 system-ui,sans-serif;color:#dcc9ad;opacity:.92;margin:0 0 16px}' +
  '.cos-deny-btn{font:600 13px system-ui,sans-serif;color:#1b1006;cursor:pointer;' +
    'background:linear-gradient(180deg,#f3d489,#d09b2e);border:0;border-radius:8px;' +
    'padding:8px 22px;box-shadow:0 3px 12px rgba(245,200,120,.4)}' +
  '.cos-deny-btn:hover{filter:brightness(1.07)}' +
  '@keyframes cosFade{from{opacity:0}to{opacity:1}}' +
  '@keyframes cosRise{from{opacity:0;transform:translateY(14px) scale(.94)}to{opacity:1;transform:none}}' +
  '@media(max-width:560px){.cos-door{width:46px;height:70px;top:56px;right:16px}' +
    '.cos-label{display:none}}' +
  '@media(prefers-reduced-motion:reduce){.cos-door svg,.cos-aura,.cos-seam,.cos-spark{animation:none}}';

  // иконка для всплывашки — арочная дверь, светящаяся янтарём
  var DOOR_ICON =
'<svg class="cos-deny-ico" viewBox="0 0 60 64" xmlns="http://www.w3.org/2000/svg">' +
  '<path d="M12,58 L12,26 A18,18 0 0 1 48,26 L48,58 Z" fill="none" stroke="#f0c878" ' +
  'stroke-width="3" stroke-linejoin="round"/>' +
  '<line x1="30" y1="9" x2="30" y2="58" stroke="#f0c878" stroke-width="2"/>' +
  '<circle cx="24" cy="36" r="2.2" fill="none" stroke="#f0c878" stroke-width="1.6"/>' +
  '<circle cx="36" cy="36" r="2.2" fill="none" stroke="#f0c878" stroke-width="1.6"/></svg>';

  // ── Логика роли + всплывашка ─────────────────────────────────────────
  var _meCache = null;
  function getRole() {
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
        DOOR_ICON +
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
      if (role === "admin") window.location.href = TARGET;
      else showDeny();
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

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", init);
  else init();
})();
