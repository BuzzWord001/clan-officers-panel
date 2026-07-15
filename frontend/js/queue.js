/* Раздел «Очередь за ресурсами с КХ» — вход/регистрация (Фаза 1).
   Свои эндпоинты /queue/* (same-origin), НЕ трогает офицерскую авторизацию. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var API = (window.OFFICERS_CONFIG && window.OFFICERS_CONFIG.API_URL) || "";

  function api(method, path, body) {
    return fetch(API + path, {
      method: method,
      credentials: "include",
      headers: body ? { "Content-Type": "application/json" } : undefined,
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
  function showAuth() { $("auth").hidden = false; $("section").hidden = true; goStep("nick"); }
  function showSection(acc) {
    $("auth").hidden = true; $("section").hidden = false;
    $("who").textContent = (acc && (acc.main_nick || acc.reg_nick)) || "игрок";
    if (window.QueueScene) window.QueueScene.enter(acc);
  }
  function goStep(which) {
    $("step-nick").hidden = which !== "nick";
    $("step-register").hidden = which !== "register";
    $("step-login").hidden = which !== "login";
    err("");
    var sub = $("auth-sub");
    if (which === "nick") sub.textContent = "Выбери свой игровой ник, чтобы войти";
    else if (which === "register") sub.textContent = "Первый вход — создай личный пароль";
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
      return '<div class="q-sugg-item" data-i="' + i + '">' +
        '<div class="q-sugg-nick">' + esc(p.nick) + "</div>" +
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
      showSection(d.account);
    }).catch(function (e) {
      btn.disabled = false;
      if (e.status === 401) err("Неверный общий пароль (посмотри в игре, кнопка G, внизу окна гильдии).");
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
      .then(function (d) { showSection(d.account); })
      .catch(function (e) {
        btn.disabled = false;
        err(e.status === 401 ? "Неверный личный пароль." : ("Ошибка входа: " + (e.detail || e.message)));
      });
  }

  function doLogout() {
    api("POST", "/queue/logout").then(showAuth).catch(showAuth);
  }

  function init() {
    document.documentElement.classList.remove("booting");
    wireSuggest();
    $("btn-next").addEventListener("click", doNext);
    $("btn-register").addEventListener("click", doRegister);
    $("btn-login").addEventListener("click", doLogin);
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
      var open = ((r[0] && r[0].config) || {})["queue_open"] === "1";
      var m = r[1], isAdmin = m && m.role === "admin";
      if (isAdmin) {
        $("auth").hidden = true; $("dev").hidden = true; $("section").hidden = false;
        $("who").textContent = (m.name || "админ") + (open ? "" : " · разработка");
        if (window.QueueScene) window.QueueScene.enter(null);
        return;
      }
      if (!open) { showDev(); return; }
      // раздел ОТКРЫТ — обычный вход
      api("GET", "/queue/me").then(function (d) {
        if (d.account) { showSection(d.account); return; }
        if (m && m.role === "officer") {
          $("auth").hidden = true; $("dev").hidden = true; $("section").hidden = false;
          $("who").textContent = (m.name || "офицер") + " · просмотр";
          if (window.QueueScene) window.QueueScene.enter(null);
        } else { showAuth(); setTimeout(function () { $("q-nick").focus(); }, 40); }
      }).catch(function () { showAuth(); });
    });
  }

  function showDev() { $("auth").hidden = true; $("section").hidden = true; $("dev").hidden = false; }
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
