/* Сцена очередей за ресурсами с КХ (Фаза 2). 2D-вид: 3 параллельные очереди,
   человечки по классу/полу (персональные модели — если есть), ник над головой,
   будки в конце, окружение с деревьями. Плюс админ-управление и лог.
   Стили инжектим из JS (чтобы не зависеть от внешнего CSS). */
(function () {
  "use strict";
  var API = (window.OFFICERS_CONFIG && window.OFFICERS_CONFIG.API_URL) || "";
  function q(m, p, b) {
    return fetch(API + p, { method: m, credentials: "include",
      headers: b ? { "Content-Type": "application/json" } : undefined,
      body: b ? JSON.stringify(b) : undefined
    }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) {
      if (!r.ok) { var e = new Error(j.detail || r.statusText); e.status = r.status; e.detail = j.detail; throw e; } return j; }); });
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function canon(s) { return (s || "").toString().toLowerCase().replace(/[\s\W_]+/gu, ""); }

  // ── модели ──
  var CLASS_MODEL = {
    "воин": { m: "Воин(м).png", f: "Воин(ж).png" },
    "жрец": { m: "Жрец (м).png", f: "Жрец (ж).png" },
    "маг": { f: "Маг (ж).png", m: "Маг (ж).png" },
    "друид": { f: "Друид.png" },
    "стрелок": { f: "Стрелок.png" },
    "оборотень": { m: "Оборотень.png" },
    "странник": { m: "Странник.png" }
  };
  var PERSONAL = { "naomi": "_Naomi.png", "карася": "Карася.png", "кэя": "Кэя.png",
    "лирия": "Лирия!.png", "химеко": "Химеко.png" };
  var FEMALE_ONLY = ["друид", "стрелок"], MALE_ONLY = ["оборотень", "странник"];
  function genderOf(cls, trueName) {
    var c = (cls || "").toLowerCase();
    if (FEMALE_ONLY.indexOf(c) >= 0) return "f";
    if (MALE_ONLY.indexOf(c) >= 0) return "m";
    var name = (trueName || "").trim().split(/\s+/)[0] || "";
    if (/[аяьи]$/i.test(name)) return "f";
    return "m";
  }
  function modelInfo(e) {
    var pc = canon(e.main_nick || e.nick);
    if (PERSONAL[pc]) { var f = PERSONAL[pc]; return { url: "assets/queue/personal/" + f, key: "personal/" + f }; }
    var set = CLASS_MODEL[(e.cls || "").toLowerCase()];
    if (set) { var g = genderOf(e.cls, e.true_name); var fn = set[g] || set.m || set.f;
      return { url: "assets/queue/class/" + fn, key: "class/" + fn }; }
    return null;
  }
  function modelUrl(e) { var m = modelInfo(e); return m ? m.url : null; }

  // все модели (для админ-настройки поворота/зеркала)
  var ALL_MODELS = [
    { key: "class/Воин(м).png", label: "Воин (м)" }, { key: "class/Воин(ж).png", label: "Воин (ж)" },
    { key: "class/Жрец (м).png", label: "Жрец (м)" }, { key: "class/Жрец (ж).png", label: "Жрец (ж)" },
    { key: "class/Маг (ж).png", label: "Маг (ж)" }, { key: "class/Друид.png", label: "Друид" },
    { key: "class/Стрелок.png", label: "Стрелок" }, { key: "class/Оборотень.png", label: "Оборотень" },
    { key: "class/Странник.png", label: "Странник" },
    { key: "personal/_Naomi.png", label: "Naomi (личн.)" }, { key: "personal/Карася.png", label: "Карася (личн.)" },
    { key: "personal/Кэя.png", label: "Кэя (личн.)" }, { key: "personal/Лирия!.png", label: "Лирия! (личн.)" },
    { key: "personal/Химеко.png", label: "Химеко (личн.)" }
  ];
  var MODEL_SETTINGS = {};   // key -> {flip, rotate}
  function transformStr(s) {
    if (!s) return "";
    return (s.flip ? "scaleX(-1) " : "") + (s.rotate ? ("rotate(" + s.rotate + "deg)") : "");
  }

  var LANES = [
    { q: 0, title: "Обычные ресурсы", tag: "очередь 1", booth: "booth-common.png",
      accent: "#7ec46a", need: "нужно ≥ 60 доблести" },
    { q: 1, title: "Редкие ресурсы (R)", tag: "очередь 2", booth: "booth-rare.png",
      accent: "#e0a24a", need: "нужно ≥ 100 доблести" },
    { q: 2, title: "Легендарные (S)", tag: "очередь 3", booth: "booth-elite.png",
      accent: "#c07be0", need: "нужно ≥ 100 доблести" }
  ];

  var TREE = '<svg viewBox="0 0 60 80" xmlns="http://www.w3.org/2000/svg"><path d="M30 78 L27 55 h6 L30 78Z" fill="#5a3a1f"/><circle cx="30" cy="34" r="22" fill="#3f7a3a"/><circle cx="18" cy="42" r="15" fill="#356b31"/><circle cx="43" cy="42" r="15" fill="#356b31"/><circle cx="30" cy="24" r="16" fill="#4a8a44"/></svg>';
  var BUSH = '<svg viewBox="0 0 50 30" xmlns="http://www.w3.org/2000/svg"><circle cx="14" cy="20" r="12" fill="#356b31"/><circle cx="30" cy="16" r="14" fill="#3f7a3a"/><circle cx="42" cy="22" r="10" fill="#356b31"/></svg>';

  function injectStyle() {
    if (document.getElementById("q-scene-style")) return;
    var st = document.createElement("style");
    st.id = "q-scene-style";
    st.textContent =
    ".q-scene{max-width:1100px;margin:14px auto 60px;padding:0 12px}" +
    ".q-banner{margin:0 0 14px;padding:10px 14px;border-radius:12px;font-size:13px;" +
      "background:rgba(224,162,74,.12);border:1px solid rgba(224,162,74,.35);color:#ecdcbe}" +
    ".q-banner b{color:#f0c878}" +
    ".q-lane{position:relative;margin:0 0 18px;border-radius:16px;overflow:hidden;" +
      "border:1px solid rgba(224,162,74,.3);box-shadow:0 6px 22px rgba(0,0,0,.4)}" +
    ".q-lane-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:9px 14px;" +
      "background:linear-gradient(180deg,#241708,#180e06);border-bottom:1px solid rgba(224,162,74,.25)}" +
    ".q-lane-dot{width:12px;height:12px;border-radius:50%}" +
    ".q-lane-title{font:800 15px/1 Georgia,serif}" +
    ".q-lane-tag{font-size:11px;color:#a58c68}" +
    ".q-lane-need{font-size:11px;color:#c9b48f;margin-left:2px}" +
    ".q-lane-count{font-size:12px;color:#dcc9ad;margin-left:auto}" +
    ".q-join{cursor:pointer;font:700 12.5px system-ui;color:#1b1006;border:0;border-radius:9px;" +
      "padding:8px 14px;background:linear-gradient(180deg,#f3d489,#d09b2e);box-shadow:0 3px 10px rgba(245,200,120,.35)}" +
    ".q-join:hover{filter:brightness(1.07)}" +
    ".q-join.leave{background:linear-gradient(180deg,#caa,#a77);color:#1b1006}" +
    ".q-world{position:relative;height:190px;overflow:hidden;" +
      "background:linear-gradient(180deg,#9fc7e8 0%,#bfe0ea 42%,#cfeaa8 55%,#8fc36a 70%,#6fae4e 100%)}" +
    ".q-sun{position:absolute;top:14px;left:26px;width:34px;height:34px;border-radius:50%;" +
      "background:radial-gradient(circle,#fff6cf,#ffe487);box-shadow:0 0 26px #ffe487}" +
    ".q-trees{position:absolute;left:0;right:0;bottom:56px;height:80px;pointer-events:none;opacity:.95}" +
    ".q-trees .t{position:absolute;bottom:0}" +
    ".q-ground{position:absolute;left:0;right:0;bottom:0;height:64px;" +
      "background:linear-gradient(180deg,#7bb054,#5e8c3f);border-top:2px solid rgba(255,255,255,.12)}" +
    ".q-path{position:absolute;left:0;right:130px;bottom:14px;height:26px;border-radius:14px;" +
      "background:linear-gradient(180deg,#caa06a,#a97e46);opacity:.55}" +
    ".q-booth{position:absolute;right:6px;bottom:8px;height:150px;width:auto;z-index:5;" +
      "filter:drop-shadow(0 6px 12px rgba(0,0,0,.45))}" +
    ".q-booth-name{position:absolute;right:8px;bottom:160px;font:800 12px Georgia,serif;color:#fff;" +
      "text-shadow:0 1px 3px #000,0 0 8px rgba(0,0,0,.6);z-index:6}" +
    ".q-track{position:absolute;left:8px;right:130px;bottom:22px;top:14px}" +
    ".q-char{position:absolute;bottom:0;transform:translateX(-50%);text-align:center;" +
      "animation:qBob 2.4s ease-in-out infinite}" +
    ".q-char-name{font:700 11px system-ui;color:#fff;white-space:nowrap;margin:0 auto 2px;" +
      "padding:1px 6px;border-radius:7px;background:rgba(20,13,7,.72);border:1px solid rgba(224,162,74,.4);" +
      "text-shadow:0 1px 2px #000;display:inline-block;max-width:110px;overflow:hidden;text-overflow:ellipsis}" +
    ".q-char-img{height:96px;width:auto;display:block;margin:0 auto;" +
      "filter:drop-shadow(0 4px 5px rgba(0,0,0,.4))}" +
    ".q-char-ph{width:46px;height:82px;margin:0 auto;border-radius:10px 10px 8px 8px;" +
      "background:linear-gradient(180deg,#4a3a26,#2b2013);border:1px solid rgba(224,162,74,.4);" +
      "display:flex;align-items:flex-start;justify-content:center;color:#caa66a;font-size:11px;padding-top:6px}" +
    ".q-char-me .q-char-name{background:linear-gradient(180deg,#3a2a12,#241809);" +
      "border-color:#f0c878;color:#ffe6ad;box-shadow:0 0 10px rgba(245,200,120,.4)}" +
    ".q-char-x{position:absolute;top:-4px;right:-6px;width:20px;height:20px;border-radius:50%;" +
      "background:#a33;color:#fff;border:0;cursor:pointer;font-size:12px;line-height:1;z-index:8;display:none}" +
    ".q-char-mv{position:absolute;bottom:-2px;display:none;gap:2px;left:50%;transform:translateX(-50%);z-index:8}" +
    ".q-char-mv button{width:20px;height:18px;border:0;border-radius:5px;cursor:pointer;" +
      "background:rgba(20,13,7,.85);color:#f0c878;font-size:11px;line-height:1}" +
    ".q-lane.admin .q-char-x,.q-lane.admin .q-char-mv{display:flex}" +
    ".q-empty-note{position:absolute;left:14px;top:14px;font-size:12px;color:#20140a;font-weight:700;" +
      "background:rgba(255,255,255,.6);padding:3px 9px;border-radius:8px}" +
    ".q-demo .q-char{opacity:.82}" +
    "@keyframes qBob{0%,100%{transform:translateX(-50%) translateY(0)}50%{transform:translateX(-50%) translateY(-4px)}}" +
    /* админ-панель */
    ".q-admin{margin:20px 0 0;padding:14px 16px;border-radius:14px;background:linear-gradient(180deg,#1c1207,#140c05);" +
      "border:1px solid rgba(224,162,74,.35)}" +
    ".q-admin h3{margin:0 0 10px;font:800 15px Georgia,serif;color:#f0c878}" +
    ".q-admin-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 10px}" +
    ".q-admin input,.q-admin select{padding:8px 10px;font-size:13px;color:#f5ecda;background:rgba(0,0,0,.35);" +
      "border:1px solid rgba(224,162,74,.35);border-radius:8px;outline:none}" +
    ".q-admin input:focus,.q-admin select:focus{border-color:#e0a24a}" +
    ".q-admin button{cursor:pointer;font:700 12.5px system-ui;color:#1b1006;border:0;border-radius:8px;" +
      "padding:8px 12px;background:linear-gradient(180deg,#f3d489,#d09b2e)}" +
    ".q-admin button.sec{background:none;border:1px solid rgba(224,162,74,.5);color:#caa66a}" +
    ".q-admin button.danger{background:linear-gradient(180deg,#e07a6a,#b0453a);color:#fff}" +
    ".q-adm-sugg{position:relative}" +
    ".q-adm-list{position:absolute;left:0;top:calc(100% + 3px);z-index:30;max-height:220px;overflow:auto;" +
      "min-width:220px;background:#1a1109;border:1px solid rgba(224,162,74,.4);border-radius:9px;padding:4px;display:none}" +
    ".q-adm-list.show{display:block}" +
    ".q-adm-item{padding:7px 9px;border-radius:6px;cursor:pointer;font-size:13px}" +
    ".q-adm-item:hover,.q-adm-item.active{background:rgba(224,162,74,.14)}" +
    ".q-adm-status{font-size:12.5px;margin-top:6px;min-height:16px}" +
    ".q-log{margin-top:12px;max-height:260px;overflow:auto;border:1px solid rgba(224,162,74,.25);border-radius:10px}" +
    ".q-log table{width:100%;border-collapse:collapse;font-size:11.5px}" +
    ".q-log th,.q-log td{padding:5px 8px;border-bottom:1px solid rgba(224,162,74,.12);text-align:left;white-space:nowrap}" +
    ".q-log th{color:#a58c68;position:sticky;top:0;background:#1a1109}" +
    "@media(max-width:640px){.q-world{height:160px}.q-char-img{height:74px}.q-booth{height:118px}}";
    document.head.appendChild(st);
  }

  // ── рендер одной дорожки ──
  function renderLane(lane, entries, meAcc, isAdmin, isDemo) {
    var el = document.createElement("div");
    el.className = "q-lane" + (isAdmin ? " admin" : "") + (isDemo ? " demo" : "");
    el.dataset.q = lane.q;
    var meCanon = meAcc ? canon(meAcc.main_nick) : "";
    var iAmIn = entries.some(function (e) { return canon(e.main_nick) === meCanon; }) && !isDemo;

    var trees = "";
    for (var t = 0; t < 6; t++) {
      var lft = 4 + t * 15 + (t % 2 ? 4 : 0);
      var scale = t % 2 ? 0.8 : 1.05;
      trees += '<div class="t" style="left:' + lft + '%;transform:scale(' + scale + ')">' +
        (t % 3 === 2 ? BUSH : TREE) + "</div>";
    }

    var chars = entries.map(function (e, i) {
      var n = entries.length;
      var leftPct = n <= 1 ? 12 : (8 + (i / Math.max(1, n - 1)) * 74); // слева-направо к будке
      var zig = (i % 2 ? 10 : 0); // лёгкий зигзаг
      var mi = modelInfo(e);
      var mine = !isDemo && canon(e.main_nick) === meCanon;
      var body = mi
        ? '<img class="q-char-img" src="' + esc(mi.url) + '" alt="" loading="lazy" data-mkey="' +
            esc(mi.key) + '" style="transform:' + transformStr(MODEL_SETTINGS[mi.key]) + '">'
        : '<div class="q-char-ph">' + esc((e.cls || "?").slice(0, 8)) + "</div>";
      return '<div class="q-char' + (mine ? " q-char-me" : "") + '" data-id="' + (e.id || "") +
        '" data-i="' + i + '" style="left:' + leftPct + "%;bottom:" + zig + 'px;animation-delay:' + (i * 0.2) + 's">' +
        (isAdmin && !isDemo ? '<button class="q-char-x" title="Убрать из очереди">✕</button>' : "") +
        '<div class="q-char-name">' + esc(e.nick) + "</div>" + body +
        (isAdmin && !isDemo ? '<div class="q-char-mv"><button data-mv="-1" title="ближе к будке">◀</button><button data-mv="1" title="в конец">▶</button></div>' : "") +
        "</div>";
    }).join("");

    el.innerHTML =
      '<div class="q-lane-bar">' +
        '<span class="q-lane-dot" style="background:' + lane.accent + '"></span>' +
        '<span class="q-lane-title" style="color:' + lane.accent + '">' + esc(lane.title) + "</span>" +
        '<span class="q-lane-tag">· ' + esc(lane.tag) + "</span>" +
        '<span class="q-lane-need">· ' + esc(lane.need) + "</span>" +
        '<span class="q-lane-count">' + (isDemo ? "пример" : entries.length + " чел.") + "</span>" +
        (meAcc ? '<button class="q-join' + (iAmIn ? " leave" : "") + '" data-act="' + (iAmIn ? "leave" : "join") +
          '">' + (iAmIn ? "Выйти из очереди" : "Встать в очередь") + "</button>" : "") +
      "</div>" +
      '<div class="q-world">' +
        '<div class="q-sun"></div>' +
        '<div class="q-trees">' + trees + "</div>" +
        '<div class="q-ground"></div><div class="q-path"></div>' +
        (isDemo ? '<div class="q-empty-note">пример — тут пусто, нажми «Встать в очередь»</div>' : "") +
        '<div class="q-track">' + chars + "</div>" +
        '<div class="q-booth-name">' + esc(lane.title) + "</div>" +
        '<img class="q-booth" src="assets/queue/' + lane.booth + '" alt="">' +
      "</div>";

    // события
    var joinBtn = el.querySelector(".q-join");
    if (joinBtn) joinBtn.addEventListener("click", function () {
      var act = joinBtn.dataset.act;
      joinBtn.disabled = true;
      q("POST", "/queue/" + act, { queue: lane.q }).then(refresh).catch(function (e) {
        joinBtn.disabled = false;
        alert(e.status === 409 ? "Ты уже стоишь в этой очереди." :
              e.status === 401 ? "Сессия истекла, войди заново." : ("Ошибка: " + (e.detail || e.message)));
      });
    });
    if (isAdmin && !isDemo) {
      el.querySelectorAll(".q-char").forEach(function (c) {
        var id = +c.dataset.id, i = +c.dataset.i;
        var x = c.querySelector(".q-char-x");
        if (x) x.addEventListener("click", function () {
          q("POST", "/queue/admin/remove", { entry_id: id }).then(refresh).catch(admErr); });
        c.querySelectorAll("[data-mv]").forEach(function (b) {
          b.addEventListener("click", function () {
            var target = i + (+b.dataset.mv === -1 ? -1 : 2); // -1 ближе к началу; +2 т.к. индекс сдвигается
            q("POST", "/queue/admin/move", { entry_id: id, queue: lane.q, position: Math.max(0, target) })
              .then(refresh).catch(admErr);
          });
        });
      });
    }
    return el;
  }

  function admErr(e) { alert("Ошибка (нужны права админа?): " + (e.detail || e.message)); }

  // ── демо-население (пример) из ростера ──
  function demoFor(lane, roster) {
    var withModel = roster.filter(function (p) { return modelUrl(p); });
    var pool = withModel.length >= 4 ? withModel : roster;
    var start = lane.q * 4;
    var out = [];
    for (var i = 0; i < 5 && pool.length; i++) out.push(pool[(start + i * 3) % pool.length]);
    return out;
  }

  var _roster = [], _isAdmin = false, _meAcc = null;

  function render(state) {
    var host = document.getElementById("scene");
    host.innerHTML = "";
    var scene = document.createElement("div");
    scene.className = "q-scene";
    var anyReal = state.queues.some(function (qq) { return qq.length; });
    var banner = document.createElement("div");
    banner.className = "q-banner";
    banner.innerHTML = anyReal
      ? "🏰 <b>Очередь за ресурсами с КХ.</b> Встань в любую из 3 очередей (можно во все сразу). В одну очередь — только один раз, пока не заберёшь ресурс."
      : "🏰 <b>Так будет выглядеть очередь.</b> Сейчас показан <b>пример</b> с моделями по классам. Нажми «Встать в очередь» — и встанешь по-настоящему.";
    scene.appendChild(banner);

    LANES.forEach(function (lane) {
      var real = state.queues[lane.q] || [];
      var isDemo = real.length === 0;
      var entries = isDemo ? demoFor(lane, _roster) : real;
      scene.appendChild(renderLane(lane, entries, _meAcc, _isAdmin, isDemo));
    });

    if (_isAdmin) scene.appendChild(adminPanel(state));
    host.appendChild(scene);
  }

  // ── админ-панель ──
  function adminPanel(state) {
    var box = document.createElement("div");
    box.className = "q-admin";
    box.innerHTML =
      "<h3>⚙️ Управление очередью (админ)</h3>" +
      '<div class="q-admin-row q-adm-sugg">' +
        '<input id="qa-nick" placeholder="ник игрока…" autocomplete="off" style="min-width:170px">' +
        '<div class="q-adm-list" id="qa-list"></div>' +
        '<select id="qa-queue"><option value="0">Очередь 1 (обычные)</option>' +
          '<option value="1">Очередь 2 (редкие R)</option><option value="2">Очередь 3 (легенд. S)</option></select>' +
        '<input id="qa-pos" type="number" min="0" placeholder="место (пусто = в конец)" style="width:170px">' +
        '<button id="qa-add">Добавить в очередь</button>' +
      "</div>" +
      '<div class="q-admin-row">' +
        '<button class="sec" data-clear="0">Очистить оч.1</button>' +
        '<button class="sec" data-clear="1">Очистить оч.2</button>' +
        '<button class="sec" data-clear="2">Очистить оч.3</button>' +
        '<button class="danger" data-clear="all">Очистить ВСЕ</button>' +
        '<button class="sec" id="qa-log-btn">Показать лог и входы</button>' +
      "</div>" +
      '<div class="q-adm-status" id="qa-status"></div>' +
      '<div class="q-log" id="qa-log" hidden></div>';

    var nick = box.querySelector("#qa-nick"), list = box.querySelector("#qa-list");
    var chosen = "";
    var timer;
    nick.addEventListener("input", function () {
      chosen = nick.value.trim();
      clearTimeout(timer);
      var v = nick.value.trim().toLowerCase();
      if (!v) { list.classList.remove("show"); return; }
      timer = setTimeout(function () {
        var m = _roster.filter(function (p) { return p.nick.toLowerCase().indexOf(v) >= 0; }).slice(0, 12);
        list.innerHTML = m.map(function (p) {
          return '<div class="q-adm-item" data-n="' + esc(p.nick) + '">' + esc(p.nick) +
            (p.is_twin ? ' <span style="color:#e0a86a">(твин · ' + esc(p.main_nick) + ")</span>" : "") +
            (p.cls ? ' <span style="color:#a58c68">· ' + esc(p.cls) + "</span>" : "") + "</div>";
        }).join("") || '<div class="q-adm-item">никого</div>';
        list.classList.add("show");
      }, 140);
    });
    list.addEventListener("click", function (e) {
      var it = e.target.closest("[data-n]"); if (it) { nick.value = it.dataset.n; chosen = it.dataset.n; list.classList.remove("show"); }
    });
    document.addEventListener("click", function (e) { if (e.target !== nick && !list.contains(e.target)) list.classList.remove("show"); });

    var status = box.querySelector("#qa-status");
    function st(msg, ok) { status.textContent = msg; status.style.color = ok ? "#9fe0a0" : "#e0a86a"; }

    box.querySelector("#qa-add").addEventListener("click", function () {
      var n = (chosen || nick.value).trim();
      if (!n) { st("Укажи ник."); return; }
      var Q = +box.querySelector("#qa-queue").value;
      var posV = box.querySelector("#qa-pos").value;
      var pos = posV === "" ? 9999 : Math.max(0, +posV);
      q("POST", "/queue/admin/add", { queue: Q, nick: n, position: pos })
        .then(function () { st("✓ Добавлен: " + n, true); nick.value = ""; chosen = ""; refresh(); })
        .catch(function (e) { st(e.status === 404 ? "Ник не найден в реестре/таблице." : ("Ошибка: " + (e.detail || e.message))); });
    });
    box.querySelectorAll("[data-clear]").forEach(function (b) {
      b.addEventListener("click", function () {
        var c = b.dataset.clear;
        if (!confirm(c === "all" ? "Очистить ВСЕ очереди?" : "Очистить очередь " + (+c + 1) + "?")) return;
        q("POST", "/queue/admin/clear", c === "all" ? {} : { queue: +c })
          .then(function () { st("✓ Очищено", true); refresh(); }).catch(function (e) { st("Ошибка: " + (e.detail || e.message)); });
      });
    });
    box.querySelector("#qa-log-btn").addEventListener("click", function () {
      var logEl = box.querySelector("#qa-log");
      q("GET", "/queue/admin/log").then(function (d) {
        logEl.hidden = false;
        var rows = (d.log || []).map(function (r) {
          return "<tr><td>" + esc((r.at || "").replace("T", " ").slice(0, 16)) + "</td><td>" + esc(r.kind) +
            "</td><td>" + esc(r.nick || r.actor) + "</td><td>" + (r.queue == null ? "" : (+r.queue + 1)) +
            "</td><td>" + esc(r.ip || "") + "</td><td>" + esc(r.detail || "") + "</td></tr>";
        }).join("");
        var accs = (d.accounts || []).map(function (a) {
          return "<tr><td>" + esc(a.main_nick) + "</td><td>" + esc(a.email || "—") + "</td><td>" +
            esc((a.created_at || "").slice(0, 10)) + "</td><td>" + esc((a.last_login_at || "").replace("T", " ").slice(0, 16)) + "</td></tr>";
        }).join("");
        logEl.innerHTML =
          '<table><thead><tr><th>время</th><th>событие</th><th>ник</th><th>оч.</th><th>IP</th><th>детали</th></tr></thead><tbody>' +
          (rows || '<tr><td colspan="6">пусто</td></tr>') + "</tbody></table>" +
          '<table style="margin-top:8px"><thead><tr><th>аккаунт (мэйн)</th><th>почта</th><th>создан</th><th>последний вход</th></tr></thead><tbody>' +
          (accs || '<tr><td colspan="4">аккаунтов нет</td></tr>') + "</tbody></table>";
      }).catch(function (e) { st("Лог доступен только админу: " + (e.detail || e.message)); });
    });
    box.appendChild(buildOrientSection());
    return box;
  }

  // ── админ: поворот/зеркало каждой модели ──
  function buildOrientSection() {
    var wrap = document.createElement("div");
    wrap.style.marginTop = "16px";
    wrap.innerHTML =
      '<h3 style="margin:0 0 6px;font:800 14px Georgia,serif;color:#f0c878">🔄 Поворот и зеркало моделей</h3>' +
      '<div style="font-size:12px;color:#c9b48f;margin-bottom:10px">Персонажи идут к будке (вправо). ' +
      'Если модель смотрит не туда — «⇋ Зеркало». «↺/↻» — поворот на 15°. Применяется ко ВСЕМ с этой ' +
      'моделью и сразу сохраняется.</div>';
    var grid = document.createElement("div");
    grid.style.cssText = "display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px";
    ALL_MODELS.forEach(function (m) {
      var s = Object.assign({ flip: 0, rotate: 0 }, MODEL_SETTINGS[m.key] || {});
      MODEL_SETTINGS[m.key] = s;
      var card = document.createElement("div");
      card.style.cssText = "background:rgba(0,0,0,.3);border:1px solid rgba(224,162,74,.3);border-radius:10px;padding:8px;text-align:center";
      var img = document.createElement("img");
      img.src = "assets/queue/" + m.key;
      img.style.cssText = "height:82px;width:auto;max-width:100%;object-fit:contain;background:linear-gradient(180deg,#bfe0ea,#8fc36a);border-radius:8px;padding:3px";
      function applyPreview() { img.style.transform = transformStr(s); }
      applyPreview();
      var lbl = document.createElement("div");
      lbl.textContent = m.label + (s.flip || s.rotate ? "" : "");
      lbl.style.cssText = "font-size:11.5px;color:#f6ead2;margin:5px 0 6px;font-weight:700";
      var row = document.createElement("div");
      row.style.cssText = "display:flex;gap:4px;justify-content:center;flex-wrap:wrap";
      function applyScene() {
        var sel = document.querySelectorAll('.q-char-img[data-mkey="' + m.key.replace(/"/g, '\\"') + '"]');
        [].forEach.call(sel, function (el) { el.style.transform = transformStr(s); });
      }
      var saveT;
      function save() {
        applyPreview(); applyScene();
        clearTimeout(saveT);
        saveT = setTimeout(function () {
          q("POST", "/queue/admin/model", { key: m.key, flip: s.flip, rotate: s.rotate })
            .catch(function (e) { alert("Не сохранилось (нужен вход админом): " + (e.detail || e.message)); });
        }, 250);
      }
      function mk(txt, title, fn) {
        var b = document.createElement("button");
        b.textContent = txt; b.title = title;
        b.style.cssText = "cursor:pointer;border:1px solid rgba(224,162,74,.5);background:rgba(20,13,7,.7);color:#f0c878;border-radius:6px;padding:5px 8px;font-size:13px";
        b.addEventListener("click", fn); return b;
      }
      row.appendChild(mk("⇋", "Отзеркалить", function () { s.flip = s.flip ? 0 : 1; save(); }));
      row.appendChild(mk("↺", "−15°", function () { s.rotate = (s.rotate || 0) - 15; save(); }));
      row.appendChild(mk("↻", "+15°", function () { s.rotate = (s.rotate || 0) + 15; save(); }));
      row.appendChild(mk("⟲", "Сброс", function () { s.flip = 0; s.rotate = 0; save(); }));
      card.appendChild(img); card.appendChild(lbl); card.appendChild(row);
      grid.appendChild(card);
    });
    wrap.appendChild(grid);
    return wrap;
  }

  function refresh() {
    return q("GET", "/queue/state").then(render).catch(function (e) {
      var host = document.getElementById("scene");
      if (host) host.innerHTML = '<div class="q-banner">Не удалось загрузить очередь: ' + esc(e.detail || e.message) + "</div>";
    });
  }

  // ── вход в сцену (вызывается из queue.js после авторизации) ──
  window.QueueScene = {
    enter: function (acc) {
      injectStyle();
      _meAcc = acc || null;
      Promise.all([
        q("GET", "/queue/roster").then(function (d) { _roster = d.roster || []; }).catch(function () { _roster = []; }),
        q("GET", "/queue/models").then(function (d) { MODEL_SETTINGS = d.settings || {}; }).catch(function () { MODEL_SETTINGS = {}; }),
        q("GET", "/auth/me").then(function (m) { _isAdmin = m && (m.role === "admin"); }).catch(function () { _isAdmin = false; })
      ]).then(refresh);
    }
  };
})();
