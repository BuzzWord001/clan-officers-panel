/* Единый вход на сайт SanTDeviL: игровой ник + личный пароль (свой или высланный),
   офицерский пароль, вход админа. Переиспользует эндпоинты /queue/* и /auth/*.
   На успехе — редирект в систему. Высланный пароль → предложить придумать свой. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var API = (window.OFFICERS_CONFIG && window.OFFICERS_CONFIG.API_URL) || "";

  var TOKEN_KEY = "officer_session_token";
  var DEVICE_KEY = "queue_device_token";
  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (_) { return ""; } }
  function setToken(t) { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch (_) {} }
  function getDev() { try { return localStorage.getItem(DEVICE_KEY) || ""; } catch (_) { return ""; } }
  function setDev(t) { try { if (t) localStorage.setItem(DEVICE_KEY, t); else localStorage.removeItem(DEVICE_KEY); } catch (_) {} }

  function api(method, path, body) {
    var headers = {};
    if (body) headers["Content-Type"] = "application/json";
    var tok = getToken(); if (tok) headers["Authorization"] = "Bearer " + tok;
    var dev = getDev(); if (dev) headers["X-Queue-Device"] = dev;
    return fetch(API + path, {
      method: method, credentials: "include", headers: headers,
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.detail || r.statusText); e.status = r.status; e.detail = j.detail; e.retry = j.retry_after; throw e; }
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
  var _isOfficerNick = false;
  function canonLike(a, b) {
    function c(s) { return (s || "").toString().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ""); }
    return c(a) === c(b);
  }

  // куда отправляем после входа
  // ВСЕ роли (участник/офицер/админ) после входа попадают на Таблицу доблести.
  function landing(role) { return "clan-valor.html"; }
  function go(url) { location.href = url; }

  function reveal() { document.documentElement.classList.remove("booting"); }
  function showAuth() { $("auth").hidden = false; goStep("nick"); reveal(); }
  function goStep(which) {
    $("step-nick").hidden = which !== "nick";
    $("step-register").hidden = which !== "register";
    $("step-login").hidden = which !== "login";
    $("step-officer").hidden = which !== "officer";
    var sr = $("step-recover"); if (sr) sr.hidden = which !== "recover";
    var so = $("step-officer-setup"); if (so) so.hidden = which !== "officer-setup";
    var sp = $("step-setpw"); if (sp) sp.hidden = which !== "setpw";
    err("");
    var sub = $("auth-sub");
    if (which === "nick") sub.textContent = "Выбери свой игровой ник, чтобы войти";
    else if (which === "register") sub.textContent = "Первый вход — создай личный пароль";
    else if (which === "officer") sub.textContent = "Это офицерский ник — нужен офицерский пароль";
    else if (which === "officer-setup") sub.textContent = "Создай личный пароль офицера";
    else if (which === "recover") sub.textContent = "Восстановление пароля";
    else if (which === "setpw") sub.textContent = "Придумай свой личный пароль";
    else sub.textContent = "С возвращением! Введи свой личный пароль";
  }
  function err(msg, ok) { var el = $("auth-err"); el.textContent = msg || ""; el.classList.toggle("q-ok", !!ok); }
  function rateLimited(e) {
    if (e && e.status === 429) {
      err("Слишком много попыток входа. Подожди " + (e.retry ? e.retry + " сек" : "немного") + " и попробуй снова.");
      return true;
    }
    return false;
  }

  // после входа обычного участника: высланный пароль → предложить придумать свой
  function finishMember(d) {
    // Сохраняем member-сессию токеном (фолбэк для встроенных браузеров TG/VK, режущих
    // cookie) — иначе /auth/me не увидит сессию и была бы петля login↔доблесть.
    if (d && d.token) setToken(d.token);
    if (d && d.account && d.account.pw_temp) {
      goStep("setpw");
      setTimeout(function () { $("q-setpw-pass").focus(); }, 40);
      return;
    }
    go(landing("member"));
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
  function pickSugg(i) { var p = suggItems[i]; if (!p) return; $("q-nick").value = p.nick; selectedNick = p.nick; hideSugg(); }
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
      if (!suggBox.classList.contains("show")) { if (e.key === "Enter") { e.preventDefault(); doNext(); } return; }
      if (e.key === "ArrowDown") { e.preventDefault(); suggActive = Math.min(suggActive + 1, suggItems.length - 1); paintActive(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); suggActive = Math.max(suggActive - 1, 0); paintActive(); }
      else if (e.key === "Enter") { e.preventDefault(); if (suggActive >= 0) pickSugg(suggActive); else doNext(); }
      else if (e.key === "Escape") { hideSugg(); }
    });
    suggBox.addEventListener("click", function (e) { var it = e.target.closest(".q-sugg-item"); if (it) pickSugg(+it.dataset.i); });
    document.addEventListener("click", function (e) { if (e.target !== input && !suggBox.contains(e.target)) hideSugg(); });
  }
  function paintActive() { [].forEach.call(suggBox.children, function (c, i) { c.classList.toggle("active", i === suggActive); }); }

  // ── шаг 1: проверить ник ──
  function doNext() {
    var nick = ($("q-nick").value || "").trim();
    if (!nick) { err("Введи или выбери свой ник."); return; }
    selectedNick = nick;
    var btn = $("btn-next"); btn.disabled = true; err("");
    api("POST", "/queue/check-nick", { nick: nick })
      .then(function (d) {
        btn.disabled = false;
        if (!d.ok) {
          if (d.reason === "not_in_clan")
            err("Этого ника нет в текущем составе клана (последний сбор доблести). Доступ на сайт — только у актуальных участников. Если это ошибка — напиши офицеру.");
          else
            err("Такой ник не найден в реестре и таблице клана. Проверь написание. Если ты админ — разверни «⚙ Вход для администратора» внизу.");
          var ad = $("q-admin-login"); if (ad && canonLike(nick, "Лирия!")) ad.open = true;
          return;
        }
        selectedNick = d.nick;
        $("q-nick").value = d.nick;
        _isOfficerNick = !!d.officer;
        goStep(d.registered ? "login" : "register");
        var rl = $("q-shared-lbl");
        var rh = $("q-reg-hint");
        if (d.officer) {
          if (rl) rl.textContent = "Офицерский пароль (из закрепа офицерского чата)";
          if (rh) rh.innerHTML = "✦ Это <b>офицерский ник</b>. Введи <b>офицерский пароль</b> — он в <b>закреплённом сообщении</b> офицерского чата ВК и Telegram, затем придумай личный.";
        } else {
          if (rl) rl.textContent = "Общий пароль клана (кнопка G)";
          if (rh) rh.innerHTML = "🔑 Введи <b>общий пароль клана</b> — он в <b>списке гильдии</b> (в игре кнопка <b>G</b>), внизу строка <b>«Пароль:»</b> (см. картинку), затем придумай свой личный.";
        }
        setTimeout(function () { $(d.registered ? "q-pass" : "q-shared").focus(); }, 30);
      })
      .catch(function (e) { btn.disabled = false; err("Ошибка проверки: " + (e.detail || e.message)); });
  }

  // ── регистрация (первый вход) ──
  function doRegister() {
    var btn = $("btn-register"); btn.disabled = true; err("");
    api("POST", "/queue/register", {
      nick: selectedNick, shared_password: $("q-shared").value,
      email: $("q-email").value.trim(), personal_password: $("q-newpass").value,
    }).then(function (d) {
      if (d.device_token) setDev(d.device_token);
      if (d.role === "officer") { setToken(d.token); go("clan-valor.html"); return; }
      finishMember(d);
    }).catch(function (e) {
      btn.disabled = false;
      if (rateLimited(e)) return;
      if (e.status === 403 && e.detail === "not_in_clan") { err("Этого ника нет в текущем составе клана. Доступ только у актуальных участников — напиши офицеру."); return; }
      if (e.detail === "need_officer_password") { err("Это офицерский ник — в поле пароля введи ОФИЦЕРСКИЙ пароль (из закрепа офицерского чата), затем придумай личный."); var rl = $("q-shared-lbl"); if (rl) rl.textContent = "Офицерский пароль (из закрепа офицерского чата)"; setTimeout(function () { $("q-shared").focus(); }, 30); }
      else if (e.detail === "personal_password_too_short") err("Придумай личный пароль — минимум 4 символа.");
      else if (e.status === 401) err(_isOfficerNick ? "Неверный офицерский пароль. Он в закрепе офицерского чата ВК/Telegram." : "Неверный пароль. Введи общий пароль клана из списка гильдии (кнопка G, строка «Пароль:»).");
      else if (e.status === 409) { err("На этот аккаунт пароль уже создан — входи по личному паролю."); goStep("login"); }
      else if (e.status === 503) err("Общий пароль клана ещё не задан. Напиши офицеру.");
      else if (e.detail === "nick_not_found") err("Ник не найден. Вернись и выбери из подсказок.");
      else err("Ошибка входа: " + (e.detail || e.message));
    });
  }

  // ── вход (уже есть личный пароль) ──
  function doLogin() {
    var btn = $("btn-login"); btn.disabled = true; err("");
    api("POST", "/queue/login", { nick: selectedNick, personal_password: $("q-pass").value })
      .then(function (d) {
        if (d.device_token) setDev(d.device_token);
        if (d.role === "officer") { setToken(d.token); go("clan-valor.html"); return; }
        finishMember(d);
      })
      .catch(function (e) {
        btn.disabled = false;
        if (rateLimited(e)) return;
        if (e.status === 403 && e.detail === "not_in_clan") { err("Этого ника нет в текущем составе клана. Доступ только у актуальных участников — напиши офицеру."); return; }
        if (e.detail === "need_officer_password") { err("Первый вход офицера — создай личный пароль (нужен офицерский пароль)."); goStep("register"); var rl = $("q-shared-lbl"); if (rl) rl.textContent = "Офицерский пароль (из закрепа офицерского чата)"; setTimeout(function () { $("q-shared").focus(); }, 30); return; }
        err(e.status === 401 ? "Неверный личный пароль." : ("Ошибка входа: " + (e.detail || e.message)));
      });
  }

  // ── вход офицером ──
  function doOfficerLogin() {
    var btn = $("btn-officer"); btn.disabled = true; err("");
    api("POST", "/queue/officer-login", { nick: selectedNick, password: $("q-off-pass").value })
      .then(function (d) { setToken(d && d.token); go("clan-valor.html"); })
      .catch(function (e) {
        btn.disabled = false;
        if (rateLimited(e)) return;
        err(e.status === 401 ? "Неверный офицерский пароль. Он в закреплённом сообщении офицерского чата ВК/Telegram." : ("Ошибка входа: " + (e.detail || e.message)));
      });
  }

  // ── восстановление пароля ──
  function openRecover() {
    err(""); goStep("recover");
    var hint = $("q-rec-hint"); hint.innerHTML = "Проверяю…";
    api("GET", "/queue/recover-hint?nick=" + encodeURIComponent(selectedNick)).then(function (d) {
      if (!d.registered) { hint.innerHTML = "На этот ник ещё нет аккаунта — вернись и <b>зарегистрируйся</b>."; return; }
      if (!d.has_email) {
        hint.innerHTML = "⚠ При регистрации ты <b>не указывал почту</b>, поэтому сам восстановить пароль не сможешь. Напиши <b>офицеру или админу</b> — они сбросят регистрацию.";
        $("q-rec-email").disabled = true; $("q-rec-newpass").disabled = true; $("btn-recover").disabled = true;
      } else {
        $("q-rec-email").disabled = false; $("q-rec-newpass").disabled = false; $("btn-recover").disabled = false;
        hint.innerHTML = "Введи <b>почту, которую указал при регистрации</b> (" + esc(d.email_mask) + ") и задай новый пароль.";
        setTimeout(function () { $("q-rec-email").focus(); }, 30);
      }
    }).catch(function () { hint.innerHTML = "Введи <b>почту с регистрации</b> и новый пароль."; });
  }
  function doRecover() {
    var btn = $("btn-recover"); btn.disabled = true; err("");
    api("POST", "/queue/recover", { nick: selectedNick, email: $("q-rec-email").value.trim(), new_password: $("q-rec-newpass").value })
      .then(function (d) {
        if (d.device_token) setDev(d.device_token);
        if (d.role === "officer") { setToken(d.token); go("clan-valor.html"); return; }
        finishMember(d);
      }).catch(function (e) {
        btn.disabled = false;
        if (e.detail === "email_mismatch") err("Почта не совпадает с той, что указана при регистрации.");
        else if (e.detail === "no_email_on_file") err("К этому аккаунту не привязана почта — попроси офицера/админа сбросить пароль.");
        else if (e.detail === "personal_password_too_short") err("Новый пароль — минимум 4 символа.");
        else if (e.status === 404) err("Аккаунт не найден.");
        else err("Не удалось восстановить: " + (e.detail || e.message));
      });
  }

  // ── офицер дозаполняет личный пароль ──
  function showOfficerSetup(name) {
    $("auth").hidden = false; reveal(); goStep("officer-setup");
    var nm = $("q-osetup-name"); if (nm) nm.textContent = name || "офицер";
    setTimeout(function () { $("q-osetup-pass").focus(); }, 40);
  }
  function doOfficerSetup() {
    var btn = $("btn-osetup"); btn.disabled = true; err("");
    api("POST", "/queue/officer-setup", { personal_password: $("q-osetup-pass").value, email: $("q-osetup-email").value.trim() })
      .then(function () { go("clan-valor.html"); })
      .catch(function (e) {
        btn.disabled = false;
        if (e.detail === "personal_password_too_short") err("Пароль — минимум 4 символа.");
        else if (e.status === 401) err("Сессия истекла — войди офицером заново.");
        else if (e.status === 409) err("Пароль уже создан — входи личным паролём.");
        else err("Не удалось сохранить: " + (e.detail || e.message));
      });
  }

  // ── придумать свой пароль после входа высланным ──
  function doSetPw() {
    var pw = $("q-setpw-pass").value || "";
    if (pw.length < 4) { err("Пароль — минимум 4 символа."); return; }
    var btn = $("btn-setpw"); btn.disabled = true; err("");
    api("POST", "/queue/change-password", { personal_password: pw })
      .then(function () { go(landing("member")); })
      .catch(function (e) { btn.disabled = false; err("Не удалось сохранить: " + (e.detail || e.message)); });
  }

  // ── вход администратора ──
  function doAdminLoginAuth() {
    var u = ($("q-adm-user").value || "").trim(), p = $("q-adm-pass").value || "";
    var e = $("q-adm-err"); e.textContent = "";
    if (!u || !p) { e.textContent = "Введи логин и пароль администратора."; return; }
    var btn = $("btn-adm-login"); btn.disabled = true;
    api("POST", "/auth/admin/login", { username: u, password: p })
      .then(function () { go("clan-valor.html"); })
      .catch(function (er) { btn.disabled = false; e.textContent = er.status === 401 ? "Неверный логин или пароль." : ("Ошибка: " + (er.detail || er.message)); });
  }

  function init() {
    wireSuggest();
    var pd = $("q-passdemo"), lb = $("q-lb");   // демо «где пароль» → лайтбокс
    if (pd && lb) {
      pd.addEventListener("click", function () { lb.classList.add("show"); });
      lb.addEventListener("click", function () { lb.classList.remove("show"); });
    }
    $("btn-next").addEventListener("click", doNext);
    $("btn-register").addEventListener("click", doRegister);
    $("btn-login").addEventListener("click", doLogin);
    $("btn-officer").addEventListener("click", doOfficerLogin);
    $("q-off-pass").addEventListener("keydown", function (e) { if (e.key === "Enter") doOfficerLogin(); });
    var bf = $("btn-forgot"); if (bf) bf.addEventListener("click", openRecover);
    var br = $("btn-recover"); if (br) br.addEventListener("click", doRecover);
    var rn = $("q-rec-newpass"); if (rn) rn.addEventListener("keydown", function (e) { if (e.key === "Enter") doRecover(); });
    var bos = $("btn-osetup"); if (bos) bos.addEventListener("click", doOfficerSetup);
    var osp = $("q-osetup-pass"); if (osp) osp.addEventListener("keydown", function (e) { if (e.key === "Enter") doOfficerSetup(); });
    var bsp = $("btn-setpw"); if (bsp) bsp.addEventListener("click", doSetPw);
    var bss = $("btn-setpw-skip"); if (bss) bss.addEventListener("click", function () { go(landing("member")); });
    var spp = $("q-setpw-pass"); if (spp) spp.addEventListener("keydown", function (e) { if (e.key === "Enter") doSetPw(); });
    var bal = $("btn-adm-login"); if (bal) bal.addEventListener("click", doAdminLoginAuth);
    var alp = $("q-adm-pass"); if (alp) alp.addEventListener("keydown", function (e) { if (e.key === "Enter") doAdminLoginAuth(); });
    [].forEach.call(document.querySelectorAll("[data-back]"), function (b) {
      b.addEventListener("click", function () { goStep("nick"); $("q-nick").focus(); });
    });
    $("q-newpass").addEventListener("keydown", function (e) { if (e.key === "Enter") doRegister(); });
    $("q-pass").addEventListener("keydown", function (e) { if (e.key === "Enter") doLogin(); });

    // страховка: если проверки зависнут — покажем окно через 4с
    setTimeout(function () { if (document.documentElement.classList.contains("booting")) showAuth(); }, 4000);

    // уже вошёл? → в систему, без окна
    Promise.all([
      api("GET", "/auth/me").catch(function () { return null; }),
      api("GET", "/queue/me").catch(function () { return null; })
    ]).then(function (r) {
      var me = r[0], q = r[1];
      // Устройство валидно, но сессия истекла → /queue/me переиздал member-сессию и вернул
      // токен: сохраняем (фолбэк для браузеров без cookie), чтобы не было петли.
      if (q && q.session_token) setToken(q.session_token);
      if (me && (me.role === "admin" || me.role === "officer")) {
        if (q && q.officer_needs_setup) { showOfficerSetup(me.name); return; }
        go("clan-valor.html"); return;
      }
      if (me && me.role === "member") { go(landing("member")); return; }
      if (q && q.account) { go(landing("member")); return; }
      showAuth(); setTimeout(function () { $("q-nick").focus(); }, 40);
    }).catch(function () { showAuth(); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
