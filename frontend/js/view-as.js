/* «Смотреть как» — панель предпросмотра ролей ДЛЯ АДМИНА (вверху справа).
 * Позволяет админу увидеть сайт и любую его страницу глазами Гостя, Офицера и
 * Админа, переключаясь на лету. Панель НЕ пропадает (fixed) и есть на всех
 * страницах — включая «Очередь».
 *
 * Как это работает: перехватываем window.fetch и, если РЕАЛЬНАЯ роль сессии =
 * admin, подменяем поле role в ответе /auth/me на выбранную роль. Так ВСЕ скрипты
 * (api.js, queue.js, clan-valor.js …) естественно рисуют интерфейс выбранной роли,
 * а бэкенд по-прежнему авторизует по настоящей сессии — это чисто визуальный
 * предпросмотр, данные не подделываются. Не-админ панель не видит и роль подменить
 * не может (проверка realRole==='admin').  Self-inject: работает без зависимостей. */
(function () {
  "use strict";
  var KEY = "santdevil_view_as";                 // sessionStorage: guest|officer|admin
  var VIEWS = [
    { role: "guest",   label: "Игрок",   icon: "👤", hint: "как видит обычный игрок / гость" },
    { role: "officer", label: "Офицер",  icon: "✦",  hint: "как видит офицер" },
    { role: "admin",   label: "Админ",   icon: "👑", hint: "полный доступ (ты)" }
  ];
  var realRole = null;                            // истинная роль сессии (узнаём из первого /auth/me)
  var barBuilt = false;

  function ov() { try { return sessionStorage.getItem(KEY) || ""; } catch (e) { return ""; } }
  function setOv(v) {
    try { if (v && v !== "admin") sessionStorage.setItem(KEY, v); else sessionStorage.removeItem(KEY); }
    catch (e) {}
  }

  // ── перехват /auth/me ──
  var _fetch = window.fetch ? window.fetch.bind(window) : null;
  if (_fetch) window.fetch = function (input, init) {
    var url = (typeof input === "string") ? input : (input && input.url) || "";
    var isMe = /\/auth\/me(\?|$)/.test(url);
    var pr = _fetch(input, init);
    if (!isMe) return pr;
    return pr.then(function (resp) {
      if (!resp || !resp.ok) return resp;
      return resp.clone().json().then(function (data) {
        if (!data || !data.role) return resp;
        if (realRole === null) { realRole = data.role; buildBar(); }   // первый ответ = настоящая роль
        var v = ov();
        if (realRole === "admin" && v && v !== data.role) {
          var faked = Object.assign({}, data, { role: v, _viewAs: v, _realRole: "admin" });
          return new Response(JSON.stringify(faked),
            { status: 200, statusText: "OK", headers: { "Content-Type": "application/json" } });
        }
        return resp;
      }).catch(function () { return resp; });
    });
  };

  // ── стили панели ──
  function injectStyle() {
    if (document.getElementById("va-style")) return;
    var st = document.createElement("style");
    st.id = "va-style";
    st.textContent =
      "#va-bar{position:fixed;top:8px;right:250px;z-index:2147483000;display:flex;align-items:center;gap:6px;" +
        "padding:5px 7px;border-radius:12px;font-family:system-ui,Segoe UI,Arial,sans-serif;" +
        "background:linear-gradient(180deg,rgba(30,20,9,.97),rgba(18,11,4,.97));" +
        "border:1px solid rgba(240,200,120,.5);box-shadow:0 8px 26px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,224,160,.14);" +
        "backdrop-filter:blur(4px)}" +
      "#va-bar.min{padding:4px 6px}" +
      "#va-lbl{font:800 9.5px/1 system-ui;letter-spacing:.4px;text-transform:uppercase;color:#caa66a;" +
        "padding:0 3px;white-space:nowrap}" +
      ".va-seg{display:flex;gap:3px;background:rgba(0,0,0,.3);border-radius:9px;padding:3px}" +
      ".va-btn{cursor:pointer;border:0;border-radius:7px;padding:6px 9px;font:700 11.5px system-ui;" +
        "color:#dcc9ad;background:transparent;display:flex;align-items:center;gap:5px;white-space:nowrap;line-height:1}" +
      ".va-btn:hover{color:#f6ecd6;background:rgba(224,162,74,.14)}" +
      ".va-btn.on{color:#1b1006;background:linear-gradient(180deg,#f3d489,#d09b2e);" +
        "box-shadow:0 2px 8px rgba(245,200,120,.4)}" +
      ".va-btn .va-i{font-size:13px}" +
      "#va-tag{position:fixed;top:52px;right:250px;z-index:2147482999;max-width:260px;" +
        "padding:7px 11px;border-radius:10px;font:600 12px system-ui;color:#1b1006;" +
        "background:linear-gradient(180deg,#ffd98a,#e7b45a);border:1px solid rgba(120,80,20,.5);" +
        "box-shadow:0 8px 24px rgba(0,0,0,.5)}" +
      "#va-tag b{font-weight:900}" +
      "#va-tag button{margin-left:8px;cursor:pointer;border:0;border-radius:6px;padding:3px 8px;" +
        "font:800 11px system-ui;color:#fff;background:#8a4a2a}" +
      "#va-min{cursor:pointer;border:0;background:none;color:#8a795a;font:800 14px system-ui;padding:0 2px;line-height:1}" +
      "#va-min:hover{color:#caa66a}" +
      "@media(max-width:1100px){#va-bar{right:150px}#va-tag{right:150px}}" +
      "@media(max-width:760px){#va-bar{right:8px;top:auto;bottom:10px}#va-tag{right:8px;top:auto;bottom:56px}}" +
      "@media(max-width:560px){#va-lbl{display:none}.va-btn span.va-t{display:none}.va-btn{padding:7px 9px}" +
        "#va-tag{max-width:200px;font-size:11px}}";
    document.head.appendChild(st);
  }

  function buildBar() {
    if (barBuilt || realRole !== "admin") return;
    barBuilt = true;
    injectStyle();
    var cur = ov() || "admin";
    var bar = document.createElement("div");
    bar.id = "va-bar";
    var seg = VIEWS.map(function (v) {
      return '<button class="va-btn' + (v.role === cur ? " on" : "") + '" data-role="' + v.role +
        '" title="' + v.hint + '"><span class="va-i">' + v.icon + '</span>' +
        '<span class="va-t">' + v.label + "</span></button>";
    }).join("");
    bar.innerHTML = '<span id="va-lbl">Смотреть<br>как</span><div class="va-seg">' + seg +
      '</div><button id="va-min" title="свернуть">–</button>';
    document.body.appendChild(bar);

    bar.addEventListener("click", function (ev) {
      var b = ev.target.closest(".va-btn");
      if (b) {
        var role = b.getAttribute("data-role");
        if (role === (ov() || "admin")) return;
        setOv(role);
        location.reload();
        return;
      }
      if (ev.target.id === "va-min") toggleMin(bar);
    });

    // жёлтая плашка-напоминание, когда предпросмотр НЕ админский
    if (cur !== "admin") {
      var lbl = VIEWS.filter(function (v) { return v.role === cur; })[0];
      var tag = document.createElement("div");
      tag.id = "va-tag";
      tag.innerHTML = "👁 Предпросмотр: <b>" + (lbl ? lbl.label : cur) +
        "</b> · интерфейс показан как для этой роли " +
        '<button id="va-back">Я админ</button>';
      document.body.appendChild(tag);
      tag.querySelector("#va-back").addEventListener("click", function () {
        setOv(""); location.reload();
      });
    }
  }

  function toggleMin(bar) {
    var seg = bar.querySelector(".va-seg"), lbl = bar.querySelector("#va-lbl"),
      mn = bar.querySelector("#va-min");
    var hidden = seg.style.display === "none";
    seg.style.display = hidden ? "" : "none";
    if (lbl) lbl.style.display = hidden ? "" : "none";
    bar.classList.toggle("min", !hidden);
    mn.textContent = hidden ? "–" : "👁";
    mn.title = hidden ? "свернуть" : "развернуть «Смотреть как»";
  }

  // страховка: если /auth/me долго не дёргается (некоторые страницы), спросим сами
  function probe() {
    if (realRole !== null || !_fetch) return;
    _fetch("/auth/me", { headers: { "Accept": "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.role) { realRole = d.role; buildBar(); } })
      .catch(function () {});
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", function () { setTimeout(probe, 400); });
  else setTimeout(probe, 400);
})();
