/* Раздел «Очередь за ресурсами с КХ» — вход/регистрация (Фаза 1).
   Свои эндпоинты /queue/* (same-origin), НЕ трогает офицерскую авторизацию. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var API = (window.OFFICERS_CONFIG && window.OFFICERS_CONFIG.API_URL) || "";

  // Токен офицерской сессии — фолбэк для браузеров, режущих cookie (Firefox ETP,
  // встроенные браузеры TG/VK и т.п.). Тот же ключ, что у основного api.js.
  var TOKEN_KEY = "officer_session_token";
  // Токен устройства игрока — фолбэк, когда браузер режет cookie (встроенные браузеры
  // TG/VK, Firefox ETP). Без него игрок попадал в петлю «войди заново».
  var DEVICE_KEY = "queue_device_token";
  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (_) { return ""; } }
  function setToken(t) { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch (_) {} }
  function getDev() { try { return localStorage.getItem(DEVICE_KEY) || ""; } catch (_) { return ""; } }
  function setDev(t) { try { if (t) localStorage.setItem(DEVICE_KEY, t); else localStorage.removeItem(DEVICE_KEY); } catch (_) {} }

  function api(method, path, body) {
    var headers = {};
    if (body) headers["Content-Type"] = "application/json";
    var tok = getToken();
    if (tok) headers["Authorization"] = "Bearer " + tok;   // если cookie не доехала
    var dev = getDev();
    if (dev) headers["X-Queue-Device"] = dev;              // фолбэк device-аутентификации игрока
    return fetch(API + path, {
      method: method,
      credentials: "include",
      headers: headers,
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.detail || r.statusText); e.status = r.status; e.detail = j.detail; throw e; }
        return j;
      });
    });
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  var selectedNick = "";

  // ── переключение экранов ──
  // Монтирует красивый таймер обратного отсчёта до авто-открытия раздела в контейнер.
  // Когда время настанет — перезагружает страницу, чтобы раздел открылся автоматически.
  function mountOpenTimer(host, opts) {
    if (!host || !window.QueueOpen || window.QueueOpen.isOpen()) return;
    if (host.querySelector(".qopen-timer")) return;   // уже смонтирован
    var wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;justify-content:center;margin:" + ((opts && opts.margin) || "0 0 18px");
    wrap.appendChild(window.QueueOpen.mount({
      big: !!(opts && opts.big), label: "До открытия раздела",
      onOpen: function () { location.reload(); }        // настало время — открываем автоматически
    }));
    if (opts && opts.prepend && host.firstChild) host.insertBefore(wrap, host.firstChild);
    else host.appendChild(wrap);
  }

  function showAuth() {
    $("auth").hidden = false; $("section").hidden = true; goStep("nick");
    var box = document.querySelector("#auth .q-auth");
    mountOpenTimer(box, { prepend: true, margin: "0 0 16px" });
  }
  function showSection(acc) {
    $("auth").hidden = true; $("section").hidden = false;
    $("who").textContent = (acc && (acc.main_nick || acc.reg_nick)) || "игрок";
    if (window.QueueScene) window.QueueScene.enter(acc);
  }
  function goStep(which) {
    $("step-nick").hidden = which !== "nick";
    $("step-register").hidden = which !== "register";
    $("step-login").hidden = which !== "login";
    $("step-officer").hidden = which !== "officer";
    err("");
    var sub = $("auth-sub");
    if (which === "nick") sub.textContent = "Выбери свой игровой ник, чтобы войти";
    else if (which === "register") sub.textContent = "Первый вход — создай личный пароль";
    else if (which === "officer") sub.textContent = "Это офицерский ник — нужен офицерский пароль";
    else sub.textContent = "С возвращением! Введи свой личный пароль";
  }
  function err(msg, ok) {
    var el = $("auth-err"); el.textContent = msg || "";
    el.classList.toggle("q-ok", !!ok);
  }

  // ── автоподсказки ников ──
  var suggBox = null, suggTimer = null, suggActive = -1, suggItems = [];
  function renderSugg(list) {
    suggItems = list || []; suggActive = -1;
    if (!suggItems.length) {
      suggBox.innerHTML = '<div class="q-sugg-empty">ник не найден в реестре и таблице</div>';
      suggBox.classList.add("show"); return;
    }
    suggBox.innerHTML = suggItems.map(function (p, i) {
      var meta = [];
      if (p.cls) meta.push(esc(p.cls));
      if (p.is_twin) meta.push('<span class="q-sugg-twin">твин · мэйн ' + esc(p.main_nick) + "</span>");
      else meta.push("мэйн-аккаунт");
      if (p.officer) meta.push('<span class="q-sugg-off">✦ офицер</span>');
      return '<div class="q-sugg-item" data-i="' + i + '">' +
        '<div class="q-sugg-nick">' + esc(p.nick) + (p.officer ? ' <span class="q-sugg-off">✦</span>' : "") + "</div>" +
        '<div class="q-sugg-meta">' + meta.join(" · ") + "</div></div>";
    }).join("");
    suggBox.classList.add("show");
  }
  function hideSugg() { if (suggBox) { suggBox.classList.remove("show"); suggBox.innerHTML = ""; } }
  function pickSugg(i) {
    var p = suggItems[i]; if (!p) return;
    $("q-nick").value = p.nick; selectedNick = p.nick; hideSugg();
  }

  function wireSuggest() {
    var input = $("q-nick");
    suggBox = $("q-sugg");
    input.addEventListener("input", function () {
      selectedNick = input.value.trim();
      var q = input.value.trim();
      if (suggTimer) clearTimeout(suggTimer);
      if (q.length < 1) { hideSugg(); return; }
      suggTimer = setTimeout(function () {
        api("GET", "/queue/nick-suggest?q=" + encodeURIComponent(q))
          .then(function (d) { renderSugg(d.results); })
          .catch(function () { hideSugg(); });
      }, 180);
    });
    input.addEventListener("keydown", function (e) {
      if (!suggBox.classList.contains("show")) {
        if (e.key === "Enter") { e.preventDefault(); doNext(); }
        return;
      }
      if (e.key === "ArrowDown") { e.preventDefault(); suggActive = Math.min(suggActive + 1, suggItems.length - 1); paintActive(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); suggActive = Math.max(suggActive - 1, 0); paintActive(); }
      else if (e.key === "Enter") { e.preventDefault(); if (suggActive >= 0) pickSugg(suggActive); else doNext(); }
      else if (e.key === "Escape") { hideSugg(); }
    });
    suggBox.addEventListener("click", function (e) {
      var it = e.target.closest(".q-sugg-item"); if (it) pickSugg(+it.dataset.i);
    });
    document.addEventListener("click", function (e) {
      if (e.target !== input && !suggBox.contains(e.target)) hideSugg();
    });
  }
  function paintActive() {
    [].forEach.call(suggBox.children, function (c, i) {
      c.classList.toggle("active", i === suggActive);
    });
  }

  // ── шаг 1: проверить ник ──
  function doNext() {
    var nick = ($("q-nick").value || "").trim();
    if (!nick) { err("Введи или выбери свой ник."); return; }
    selectedNick = nick;
    var btn = $("btn-next"); btn.disabled = true; err("");
    api("POST", "/queue/check-nick", { nick: nick })
      .then(function (d) {
        btn.disabled = false;
        if (!d.ok) { err("Такой ник не найден в реестре и таблице клана. Проверь написание."); return; }
        selectedNick = d.nick;
        $("q-nick").value = d.nick;
        // Офицерский ник → шаг с офицерским паролем (обычный/личный пароль не подойдёт).
        if (d.officer) { goStep("officer"); setTimeout(function () { $("q-off-pass").focus(); }, 30); return; }
        goStep(d.registered ? "login" : "register");
        setTimeout(function () { $(d.registered ? "q-pass" : "q-shared").focus(); }, 30);
      })
      .catch(function (e) { btn.disabled = false; err("Ошибка проверки: " + (e.detail || e.message)); });
  }

  // ── регистрация ──
  function doRegister() {
    var btn = $("btn-register"); btn.disabled = true; err("");
    api("POST", "/queue/register", {
      nick: selectedNick,
      shared_password: $("q-shared").value,
      email: $("q-email").value.trim(),
      personal_password: $("q-newpass").value,
    }).then(function (d) {
      if (d.role === "officer") { setToken(d.token); location.reload(); return; }   // ввёл офиц. пароль → входит офицером
      if (d.device_token) setDev(d.device_token);          // сохранить токен устройства (фолбэк к cookie)
      showSection(d.account);
    }).catch(function (e) {
      btn.disabled = false;
      if (e.detail === "need_officer_password") { err("Это офицерский ник — нужен офицерский пароль."); goStep("officer"); setTimeout(function () { $("q-off-pass").focus(); }, 30); }
      else if (e.detail === "personal_password_too_short") err("Придумай личный пароль — минимум 4 символа.");
      else if (e.status === 401) err("Неверный пароль. Подойдёт общий пароль гильдии (в игре, кнопка G) или офицерский пароль.");
      else if (e.status === 409) { err("На этот аккаунт пароль уже создан — входи по личному паролю."); goStep("login"); }
      else if (e.status === 503) err("Общий пароль ещё не задан админом. Напиши офицеру.");
      else if (e.detail === "nick_not_found") err("Ник не найден. Вернись и выбери из подсказок.");
      else err("Ошибка регистрации: " + (e.detail || e.message));
    });
  }

  // ── вход ──
  function doLogin() {
    var btn = $("btn-login"); btn.disabled = true; err("");
    api("POST", "/queue/login", { nick: selectedNick, personal_password: $("q-pass").value })
      .then(function (d) { if (d.device_token) setDev(d.device_token); showSection(d.account); })
      .catch(function (e) {
        btn.disabled = false;
        if (e.detail === "need_officer_password") { err("Это офицерский ник — нужен офицерский пароль."); goStep("officer"); setTimeout(function () { $("q-off-pass").focus(); }, 30); return; }
        err(e.status === 401 ? "Неверный личный пароль." : ("Ошибка входа: " + (e.detail || e.message)));
      });
  }

  // ── вход офицером (выбран офицерский ник) ──
  function doOfficerLogin() {
    var btn = $("btn-officer"); btn.disabled = true; err("");
    api("POST", "/queue/officer-login", { nick: selectedNick, password: $("q-off-pass").value })
      .then(function (d) { setToken(d && d.token); location.reload(); })   // офицерская сессия → офицерская панель
      .catch(function (e) {
        btn.disabled = false;
        err(e.status === 401 ? "Неверный офицерский пароль. Он в закрепе чата гильдии TG/VK." : ("Ошибка входа: " + (e.detail || e.message)));
      });
  }

  function doLogout() {
    setToken(""); setDev("");   // чистим и офицерский токен, и device-токен игрока, и сессию
    Promise.all([
      api("POST", "/queue/logout").catch(function () {}),
      api("POST", "/auth/logout").catch(function () {})
    ]).then(showAuth, showAuth);
  }

  function init() {
    document.documentElement.classList.remove("booting");
    wireSuggest();
    $("btn-next").addEventListener("click", doNext);
    $("btn-register").addEventListener("click", doRegister);
    $("btn-login").addEventListener("click", doLogin);
    $("btn-officer").addEventListener("click", doOfficerLogin);
    $("q-off-pass").addEventListener("keydown", function (e) { if (e.key === "Enter") doOfficerLogin(); });
    $("btn-logout").addEventListener("click", doLogout);
    [].forEach.call(document.querySelectorAll("[data-back]"), function (b) {
      b.addEventListener("click", function () { goStep("nick"); $("q-nick").focus(); });
    });
    // enter в полях
    $("q-newpass").addEventListener("keydown", function (e) { if (e.key === "Enter") doRegister(); });
    $("q-pass").addEventListener("keydown", function (e) { if (e.key === "Enter") doLogin(); });

    wireDevAdmin();
    // Раздел открыт/закрыт админом (config queue_open). Закрыт → все кроме админа видят
    // табличку «в разработке». Админ входит всегда (по админ-паролю).
    Promise.all([
      api("GET", "/queue/config").catch(function () { return { config: {} }; }),
      api("GET", "/auth/me").catch(function () { return null; })
    ]).then(function (r) {
      // Раздел открыт, если админ открыл (queue_open=1) ЛИБО настало время авто-открытия.
      var open = ((r[0] && r[0].config) || {})["queue_open"] === "1" ||
                 !!(window.QueueOpen && window.QueueOpen.isOpen());
      var m = r[1], isAdmin = m && m.role === "admin";
      if (isAdmin) {
        $("auth").hidden = true; $("dev").hidden = true; $("section").hidden = false;
        $("who").textContent = (m.name || "админ") + (open ? "" : " · разработка");
        if (window.QueueScene) window.QueueScene.enter(null);
        return;
      }
      // АДМИН в режиме «Смотреть как» (view-as помечает ответ _realRole=admin) может
      // обойти заглушку закрытого раздела галочкой — увидеть его глазами офицера/игрока.
      var realAdmin = !!(m && m._realRole === "admin");
      if (!open && !(realAdmin && bypassOn())) { showDev(realAdmin, m && m.role); return; }
      // раздел ОТКРЫТ (или админ-предпросмотр с обходом) — вход по роли.
      api("GET", "/queue/me").then(function (d) {
        // ОФИЦЕР (по офицерской сессии) — приоритет над возможным старым queue-аккаунтом:
        // он должен видеть офицерскую панель, а не игрока.
        if (m && m.role === "officer") {
          $("auth").hidden = true; $("dev").hidden = true; $("section").hidden = false;
          $("who").textContent = (m.name || "офицер") + " · офицер";
          if (window.QueueScene) window.QueueScene.enter(null);
          return;
        }
        if (d.account) { showSection(d.account); return; }
        if (realAdmin && !open) {                    // админ-предпросмотр закрытого раздела
          $("auth").hidden = true; $("dev").hidden = true; $("section").hidden = false;
          $("who").textContent = (m && m.name || "предпросмотр") + " · предпросмотр (раздел закрыт)";
          if (window.QueueScene) window.QueueScene.enter(null);
        } else { showAuth(); setTimeout(function () { $("q-nick").focus(); }, 40); }
      }).catch(function () { showAuth(); });
    });
  }

  var BYPASS_KEY = "queue_preview_bypass";
  function bypassOn() { try { return sessionStorage.getItem(BYPASS_KEY) === "1"; } catch (e) { return false; } }
  var ROLE_RU = { officer: "офицера", guest: "обычного игрока", user: "обычного игрока", "": "обычного игрока" };
  function showDev(realAdmin, role) {
    $("auth").hidden = true; $("section").hidden = true; $("dev").hidden = false;
    // крупный таймер обратного отсчёта до авто-открытия — под бейджем «в разработке»
    var badge = $("dev") && $("dev").querySelector(".q-dev-badge");
    if (badge && window.QueueOpen && !window.QueueOpen.isOpen() && !$("dev").querySelector(".qopen-timer")) {
      var box = document.createElement("div");
      box.style.cssText = "display:flex;justify-content:center;margin:6px 0 16px";
      box.appendChild(window.QueueOpen.mount({ big: true, label: "До открытия раздела",
        onOpen: function () { location.reload(); } }));
      badge.parentNode.insertBefore(box, badge.nextSibling);
    }
    var wrap = $("dev-bypass"); if (!wrap) return;
    // Галочка обхода — ТОЛЬКО когда настоящий админ смотрит раздел «как офицер/игрок».
    if (realAdmin) {
      wrap.hidden = false;
      var rl = $("dev-bypass-role"); if (rl) rl.textContent = ROLE_RU[role] || "выбранной роли";
      var cb = $("dev-bypass-cb"); if (cb) {
        cb.checked = bypassOn();
        cb.onchange = function () {
          try { if (cb.checked) sessionStorage.setItem(BYPASS_KEY, "1"); else sessionStorage.removeItem(BYPASS_KEY); } catch (e) {}
          location.reload();
        };
      }
    } else { wrap.hidden = true; }
  }
  function wireDevAdmin() {
    var btn = $("dev-admin-btn"); if (!btn) return;
    function tryAdmin() {
      var u = ($("dev-admin-user").value || "").trim(), p = $("dev-admin-pass").value || "";
      var e = $("dev-admin-err");
      if (!u || !p) { e.textContent = "Введи логин и пароль администратора."; return; }
      btn.disabled = true; e.textContent = "";
      api("POST", "/auth/admin/login", { username: u, password: p })
        .then(function () { location.reload(); })
        .catch(function (er) {
          btn.disabled = false;
          e.textContent = er.status === 401 ? "Неверный логин или пароль." : ("Ошибка: " + (er.detail || er.message));
        });
    }
    btn.addEventListener("click", tryAdmin);
    $("dev-admin-pass").addEventListener("keydown", function (ev) { if (ev.key === "Enter") tryAdmin(); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
