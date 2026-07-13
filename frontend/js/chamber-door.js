/* «Офицерский вход» — светящаяся дверца в правом верхнем углу.
 *
 * Видна ТОЛЬКО гостю (офицер/админ уже вошли — дверца скрыта). Клик →
 * компактная панель входа: ник + пароль. Офицерский пароль → офицер;
 * админский логин+пароль в той же панели → админ (отдельного окна нет).
 *
 * Отдельно, как и раньше, инжектит admin-only вкладку «тайная комната»
 * (раздел «Курсы волшебства») во все .tabs — её видит только админ.
 *
 * Самодостаточный модуль: инжектит стили + DOM, роль узнаёт через API.me().
 * Подключать ПОСЛЕ api.js.
 */
(function () {
  "use strict";
  if (window.__cosDoorInit) return;
  window.__cosDoorInit = true;

  var TARGET = "magic-courses.html";   // раздел тайной комнаты (вкладка админа)

  // ── SVG двери (оригинальная графика) ─────────────────────────────────
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
  '<ellipse class="cos-aura" cx="42" cy="64" rx="42" ry="56" fill="url(#cosGlow)"/>' +
  '<path d="M8,114 L8,40 A34,34 0 0 1 76,40 L76,114 Z" fill="url(#cosStone)" stroke="#0a0d12" stroke-width="2"/>' +
  '<path d="M8,40 A34,34 0 0 1 76,40" fill="none" stroke="#5b6675" stroke-width="1" opacity=".4"/>' +
  '<path d="M15,110 L15,40 A27,27 0 0 1 69,40 L69,110 Z" fill="#150c06"/>' +
  '<path d="M15,110 L15,40 A27,27 0 0 1 42,13 L42,110 Z" fill="url(#cosWoodL)"/>' +
  '<path d="M42,110 L42,13 A27,27 0 0 1 69,40 L69,110 Z" fill="url(#cosWoodR)"/>' +
  woodPlanks() +
  '<path d="M15,40 A27,27 0 0 1 69,40" fill="none" stroke="#1b1006" stroke-width="1.3" opacity=".6"/>' +
  '<path d="M19,40 A23,23 0 0 1 65,40" fill="none" stroke="url(#cosBrass)" stroke-width=".8" opacity=".55"/>' +
  ironStraps() +
  '<rect x="40.4" y="13" width="3.2" height="97" fill="url(#cosIron)" stroke="#0a0c10" stroke-width=".4"/>' +
  '<rect class="cos-seam" x="41.3" y="15" width="1.4" height="93" fill="#ffd98a"/>' +
  '<circle cx="36.5" cy="74" r="3.3" fill="none" stroke="url(#cosBrass)" stroke-width="1.5"/>' +
  '<circle cx="47.5" cy="74" r="3.3" fill="none" stroke="url(#cosBrass)" stroke-width="1.5"/>' +
  '<circle cx="36.5" cy="70.6" r=".9" fill="url(#cosBrass)"/>' +
  '<circle cx="47.5" cy="70.6" r=".9" fill="url(#cosBrass)"/>' +
  '<circle cx="42" cy="22" r="5" fill="#241a12" stroke="url(#cosBrass)" stroke-width="1.2"/>' +
  '<path class="cos-rune" d="M42 18 v8 M38 22 h8 M39.2 19.2 l5.6 5.6 M44.8 19.2 l-5.6 5.6" stroke="#ffe6ad" stroke-width="1" stroke-linecap="round"/>' +
  sparks() +
'</svg>';
  }

  // ── Стили ────────────────────────────────────────────────────────────
  var CSS =
  '.cos-door{position:absolute;top:62px;right:34px;width:60px;height:90px;z-index:1100;' +
    'cursor:pointer;border:0;background:transparent;box-shadow:none;outline:none;padding:0;' +
    'filter:drop-shadow(0 5px 12px rgba(0,0,0,.6));transition:transform .25s ease;' +
    '-webkit-tap-highlight-color:transparent}' +
  '.cos-door[hidden]{display:none}' +
  '.cos-door:hover,.cos-door:focus,.cos-door:focus-visible,.cos-door:active{' +
    'background:transparent!important;box-shadow:none!important;outline:none!important}' +
  '.cos-door::before{content:"";position:absolute;left:50%;top:54%;width:170%;height:128%;' +
    'transform:translate(-50%,-50%) scale(.55);border-radius:50%;pointer-events:none;z-index:-1;' +
    'background:radial-gradient(ellipse at center,rgba(255,216,142,.62),' +
    'rgba(245,182,92,.3) 44%,rgba(245,182,92,0) 72%);filter:blur(7px);' +
    'opacity:0;transition:opacity .45s ease,transform .45s ease}' +
  '.cos-door:hover::before{opacity:1;transform:translate(-50%,-50%) scale(1.05)}' +
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
  /* ПОСТОЯННАЯ подпись под дверцей */
  '.cos-label{position:absolute;top:156px;right:19px;width:90px;z-index:1100;' +
    'pointer-events:none;text-align:center;' +
    'font:700 11px/1.2 Georgia,serif;letter-spacing:.02em;color:#f3d489;' +
    'text-shadow:0 0 9px rgba(245,200,120,.75),0 1px 2px #000;' +
    'transition:filter .25s,transform .25s}' +
  '.cos-label[hidden]{display:none}' +
  '.cos-door:hover + .cos-label{filter:brightness(1.12);transform:translateY(1px) scale(1.04)}' +
  /* ── Панель входа ── */
  '.cos-login{position:fixed;inset:0;z-index:3000;display:flex;align-items:center;' +
    'justify-content:center;background:radial-gradient(circle at 50% 40%,' +
    'rgba(28,18,8,.72),rgba(0,0,0,.9));backdrop-filter:blur(3px);animation:cosFade .3s ease both}' +
  '.cos-login[hidden]{display:none}' +
  '.cos-login-box{position:relative;width:320px;max-width:calc(100vw - 36px);' +
    'margin:0 18px;padding:24px 24px 20px;color:#f3e8d6;' +
    'background:linear-gradient(180deg,#2a1d0f,#160d06);' +
    'border:1px solid rgba(224,162,74,.5);border-radius:14px;' +
    'box-shadow:0 0 44px rgba(245,200,120,.22),inset 0 0 30px rgba(0,0,0,.5);' +
    'animation:cosRise .4s cubic-bezier(.2,.9,.3,1.2) both}' +
  '.cos-login-x{position:absolute;top:8px;right:10px;width:28px;height:28px;border:0;' +
    'background:transparent;color:#caa66a;font-size:20px;line-height:1;cursor:pointer}' +
  '.cos-login-x:hover{color:#f3d489}' +
  '.cos-login-ic{width:48px;height:48px;margin:0 auto 8px;display:block;' +
    'filter:drop-shadow(0 0 8px rgba(245,200,120,.6))}' +
  '.cos-login-t{font:700 18px/1.3 Georgia,serif;text-align:center;margin:0 0 4px;' +
    'color:#f0c878;text-shadow:0 0 10px rgba(245,200,120,.5)}' +
  '.cos-login-s{font:400 12px/1.5 system-ui,sans-serif;text-align:center;' +
    'color:#dcc9ad;opacity:.9;margin:0 0 16px}' +
  '.cos-login label{display:block;font:600 11px system-ui,sans-serif;letter-spacing:1px;' +
    'text-transform:uppercase;color:#caa66a;margin:0 0 5px}' +
  '.cos-login input{width:100%;box-sizing:border-box;margin:0 0 13px;padding:10px 12px;' +
    'font:400 14px system-ui,sans-serif;color:#f5ecda;background:rgba(0,0,0,.35);' +
    'border:1px solid rgba(224,162,74,.35);border-radius:9px;outline:none}' +
  '.cos-login input:focus{border-color:#e0a24a;box-shadow:0 0 0 2px rgba(224,162,74,.25)}' +
  '.cos-login input::placeholder{color:#9a8a70;opacity:.85}' +
  '.cos-login-hint{margin:-4px 0 15px;padding:9px 11px;border-radius:9px;' +
    'font:400 11.5px/1.5 system-ui,sans-serif;color:#ecdcbe;' +
    'background:rgba(224,162,74,.1);border:1px solid rgba(224,162,74,.28)}' +
  '.cos-login-hint b{color:#f0c878;font-weight:700}' +
  '.cos-login-btn{width:100%;margin-top:2px;padding:11px;cursor:pointer;' +
    'font:700 14px system-ui,sans-serif;color:#1b1006;' +
    'background:linear-gradient(180deg,#f3d489,#d09b2e);border:0;border-radius:9px;' +
    'box-shadow:0 4px 14px rgba(245,200,120,.4)}' +
  '.cos-login-btn:hover{filter:brightness(1.06)}' +
  '.cos-login-btn:disabled{opacity:.6;cursor:default}' +
  '.cos-login-err{min-height:16px;margin:10px 0 0;font:400 12.5px system-ui,sans-serif;' +
    'text-align:center;color:#ff8a7a}' +
  '@keyframes cosFade{from{opacity:0}to{opacity:1}}' +
  '@keyframes cosRise{from{opacity:0;transform:translateY(14px) scale(.94)}to{opacity:1;transform:none}}' +
  '@media(max-width:560px){.cos-door{width:46px;height:70px;top:54px;right:14px}' +
    '.cos-label{top:128px;right:0;width:74px;font-size:10px}}' +
  '@media(prefers-reduced-motion:reduce){.cos-door svg,.cos-aura,.cos-seam,.cos-spark{animation:none}}';

  var KEY_ICON =
'<svg class="cos-login-ic" viewBox="0 0 60 64" xmlns="http://www.w3.org/2000/svg">' +
  '<path d="M12,58 L12,26 A18,18 0 0 1 48,26 L48,58 Z" fill="none" stroke="#f0c878" stroke-width="3" stroke-linejoin="round"/>' +
  '<line x1="30" y1="9" x2="30" y2="58" stroke="#f0c878" stroke-width="2"/>' +
  '<circle cx="24" cy="36" r="2.2" fill="none" stroke="#f0c878" stroke-width="1.6"/>' +
  '<circle cx="36" cy="36" r="2.2" fill="none" stroke="#f0c878" stroke-width="1.6"/></svg>';

  // ── Роль ─────────────────────────────────────────────────────────────
  var _meCache = null;
  function getRole() {
    var dr = document.body && document.body.getAttribute("data-role");
    if (dr) return Promise.resolve(dr);
    if (document.body && document.body.classList.contains("guest-mode"))
      return Promise.resolve("guest");
    if (_meCache) return _meCache;
    _meCache = (window.API ? API.me() : Promise.reject())
      .then(function (m) { return (m && m.role) || ""; })
      .catch(function () { return ""; });
    return _meCache;
  }

  // ── Панель входа (офицер ИЛИ админ — одна форма) ─────────────────────
  function showLoginPanel() {
    if (document.querySelector(".cos-login")) return;
    var ov = document.createElement("div");
    ov.className = "cos-login";
    ov.innerHTML =
      '<div class="cos-login-box" role="dialog" aria-modal="true" aria-label="Офицерский вход">' +
        '<button type="button" class="cos-login-x" aria-label="Закрыть">&times;</button>' +
        KEY_ICON +
        '<div class="cos-login-t">Офицерский вход</div>' +
        '<form class="cos-login-form">' +
          '<label for="cos-nick">Введите ваш игровой ник</label>' +
          '<input id="cos-nick" type="text" autocomplete="username" maxlength="64" autofocus>' +
          '<label for="cos-pwd">Офицерский пароль</label>' +
          '<input id="cos-pwd" type="password" autocomplete="current-password" maxlength="200" ' +
                 'placeholder="Введите офицерский пароль">' +
          '<div class="cos-login-hint">🔒 Пароль есть в <b>закреплённом сообщении</b> ' +
            'офицерского чата ВК или Telegram</div>' +
          '<button type="submit" class="cos-login-btn">Войти</button>' +
          '<div class="cos-login-err" role="alert"></div>' +
        '</form>' +
      '</div>';

    function close() {
      ov.remove();
      document.removeEventListener("keydown", onKey);
    }
    function onKey(e) { if (e.key === "Escape") close(); }
    // Закрываем ТОЛЬКО по крестику или Esc. НЕ по клику на фон/оверлей — раньше
    // окно исчезало при промахе мимо поля или при выделении текста мышью, когда
    // mouseup оказывался вне бокса (target === ov). Ввод не должен внезапно пропадать.
    ov.addEventListener("click", function (e) {
      if (e.target.closest(".cos-login-x")) close();
    });
    document.addEventListener("keydown", onKey);

    var form = ov.querySelector(".cos-login-form");
    var nickEl = ov.querySelector("#cos-nick");
    var pwdEl = ov.querySelector("#cos-pwd");
    var btn = ov.querySelector(".cos-login-btn");
    var err = ov.querySelector(".cos-login-err");

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var nick = (nickEl.value || "").trim();
      var pwd = pwdEl.value || "";
      if (!nick || !pwd) { err.textContent = "Введите ник и пароль."; return; }
      err.textContent = "";
      btn.disabled = true;
      var lbl = btn.textContent;
      btn.textContent = "Проверка…";
      // Сначала пробуем как офицерский пароль; если не подошёл (401) —
      // пробуем те же данные как админский логин+пароль.
      API.loginOfficer(nick, pwd).then(function () {
        location.reload();
      }).catch(function (e1) {
        if (e1 && e1.status === 422) {
          err.textContent = "Ник в неправильном формате.";
          reset(); return;
        }
        if (!e1 || e1.status !== 401) {
          err.textContent = (e1 && (e1.detail || e1.message)) || "Ошибка входа.";
          reset(); return;
        }
        // не офицерский пароль → пробуем админа
        API.loginAdmin(nick, pwd).then(function () {
          location.reload();
        }).catch(function (e2) {
          err.textContent = (e2 && e2.status === 401)
            ? "Неверный ник или пароль."
            : ((e2 && (e2.detail || e2.message)) || "Ошибка входа.");
          reset();
        });
      });
      function reset() { btn.disabled = false; btn.textContent = lbl; }
    });

    document.body.appendChild(ov);
    nickEl.focus();
  }

  // ── Вкладка «тайная комната» (admin-only) во все .tabs ───────────────
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
    btn.hidden = true;              // покажем только гостю (см. getRole ниже)
    btn.setAttribute("aria-label", "Офицерский вход");
    btn.innerHTML = doorSVG();
    btn.addEventListener("click", showLoginPanel);

    var label = document.createElement("div");
    label.className = "cos-label";
    label.hidden = true;
    label.textContent = "Офицерский вход";

    document.body.appendChild(btn);
    document.body.appendChild(label);

    // Дверца — только для гостя (или когда роль ещё не офицер/админ).
    getRole().then(function (role) {
      var show = (role !== "officer" && role !== "admin");
      btn.hidden = !show;
      label.hidden = !show;
    });
  }

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", init);
  else init();
})();
