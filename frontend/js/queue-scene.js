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
  // ВАЖНО: \W в JS удаляет кириллицу — поэтому берём «не буква/цифра» через
  // юникод-свойства (кириллица сохраняется). Иначе canon("Карася")→"" и модель не находилась.
  function canon(s) { return (s || "").toString().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ""); }

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
    // персональная модель ищется и по нику-твину, и по мэйну (файл назван по нику)
    var keys = [canon(e.nick), canon(e.main_nick)];
    for (var i = 0; i < keys.length; i++) {
      if (keys[i] && PERSONAL[keys[i]]) { var f = PERSONAL[keys[i]];
        return { url: "assets/queue/personal/" + f, key: "personal/" + f }; }
    }
    var set = CLASS_MODEL[(e.cls || "").toLowerCase()];
    if (set) {
      var g = (e.gender === "f" || e.gender === "m") ? e.gender : genderOf(e.cls, e.true_name);
      var fn = set[g] || set.m || set.f;
      return { url: "assets/queue/class/" + fn, key: "class/" + fn };
    }
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

  // Координаты под РЕАЛЬНУЮ картинку scene-bg (день/ночь). % от сцены.
  // Подписи будок ВПЕЧАТАНЫ в картинку — их не дублируем; сверху только счётчик+кнопка.
  // path — путь очереди: t=1 у будки (перёд), t=0 хвост (глубже в площадь).
  var BOOTHS = [
    { q: 0, title: "Обычные", accent: "#7ec46a", bx: 50, by: 26, ui: { x: 49, y: 40 }, item: { x: 60, y: 27 },
      path: [{ x: 45, y: 60 }, { x: 47, y: 51 }, { x: 48, y: 43 }, { x: 49, y: 35 }] },
    { q: 1, title: "Редкие (R)", accent: "#e0a24a", bx: 65, by: 62, ui: { x: 61, y: 74 }, item: { x: 73, y: 64 },
      path: [{ x: 37, y: 80 }, { x: 45, y: 76 }, { x: 53, y: 72 }, { x: 60, y: 69 }] },
    { q: 2, title: "Легендарные (S)", accent: "#c07be0", bx: 80, by: 74, ui: { x: 78, y: 88 }, item: { x: 89, y: 80 },
      path: [{ x: 53, y: 88 }, { x: 61, y: 85 }, { x: 68, y: 83 }, { x: 74, y: 81 }] }
  ];
  // ресурсы за каждой будкой (файлы assets/queue/scene/item/*.png)
  var BOOTH_ITEMS = [
    ["kamen-doblesti", "meteorit", "zhemchuzhina", "znak-edinstva", "koloda-kart", "kamen-bessmertnyh", "pilyulya"],
    ["gramota", "prikaz-feniksa"],
    ["drakonya-cheshuya", "sushchnost-karty", "vysshiy-kamen"]
  ];
  // ночь: 20:00–07:00 по МСК (МСК = UTC+3), иначе день
  function isNight() { var h = (new Date().getUTCHours() + 3) % 24; return h >= 20 || h < 7; }

  // анимированные факелы (дефолт-позиции, можно двигать в режиме расстановки)
  var TORCHES = [{ x: 57, y: 44 }, { x: 72, y: 79 }, { x: 87, y: 81 }];
  var PLACEMENTS = {};     // key ('item:...'/'mount'/'torch:N') -> {x,y} ручная расстановка
  var _placeMode = false;  // режим ручной расстановки (админ)
  function placedPos(key, dx, dy) {
    var p = PLACEMENTS[key];
    return p ? { x: p.x, y: p.y } : { x: dx, y: dy };
  }
  function makeDraggable(el, pkey) {
    el.style.pointerEvents = "auto"; el.style.cursor = "grab";
    function start(moveEvt, endEvt) {
      var stage = el.closest(".qs-stage"); if (!stage) return;
      var rect = stage.getBoundingClientRect(), lx = null, ly = null;
      function move(e) {
        var pt = e.touches ? e.touches[0] : e;
        lx = Math.max(0, Math.min(100, ((pt.clientX - rect.left) / rect.width) * 100));
        ly = Math.max(0, Math.min(100, ((pt.clientY - rect.top) / rect.height) * 100));
        el.style.left = lx.toFixed(2) + "%"; el.style.top = ly.toFixed(2) + "%";
        el.style.zIndex = Math.round(ly * 12);
      }
      function end() {
        document.removeEventListener(moveEvt, move); document.removeEventListener(endEvt, end);
        if (lx != null) {
          PLACEMENTS[pkey] = { x: lx, y: ly };
          q("POST", "/queue/admin/placement", { key: pkey, x: lx, y: ly }).catch(function () {});
        }
      }
      document.addEventListener(moveEvt, move); document.addEventListener(endEvt, end);
    }
    el.addEventListener("mousedown", function (e) { e.preventDefault(); start("mousemove", "mouseup"); });
    el.addEventListener("touchstart", function () { start("touchmove", "touchend"); }, { passive: true });
  }
  function pathPoint(path, t) {
    t = Math.max(0, Math.min(1, t));
    var seg = t * (path.length - 1), i = Math.floor(seg), f = seg - i;
    if (i >= path.length - 1) return path[path.length - 1];
    var a = path[i], b = path[i + 1];
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
  }

  var TREE = '<svg viewBox="0 0 60 80" xmlns="http://www.w3.org/2000/svg"><path d="M30 78 L27 55 h6 L30 78Z" fill="#5a3a1f"/><circle cx="30" cy="34" r="22" fill="#3f7a3a"/><circle cx="18" cy="42" r="15" fill="#356b31"/><circle cx="43" cy="42" r="15" fill="#356b31"/><circle cx="30" cy="24" r="16" fill="#4a8a44"/></svg>';
  var BUSH = '<svg viewBox="0 0 50 30" xmlns="http://www.w3.org/2000/svg"><circle cx="14" cy="20" r="12" fill="#356b31"/><circle cx="30" cy="16" r="14" fill="#3f7a3a"/><circle cx="42" cy="22" r="10" fill="#356b31"/></svg>';
  // силуэт-заглушка (когда для класса ещё нет модели и нет персональной)
  var PH_FIGURE = '<svg viewBox="0 0 44 80" width="44" height="80" xmlns="http://www.w3.org/2000/svg">' +
    '<ellipse cx="22" cy="76" rx="13" ry="3.5" fill="rgba(0,0,0,.22)"/>' +
    '<path d="M22 22 C9 22 8 44 9 66 L35 66 C36 44 35 22 22 22Z" fill="#3b2c1a"/>' +
    '<path d="M22 22 C13 22 12 34 12 44 L32 44 C32 34 31 22 22 22Z" fill="#4a3927"/>' +
    '<circle cx="22" cy="16" r="10.5" fill="#5a4630"/><circle cx="22" cy="17" r="7" fill="#241a10"/></svg>';

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
    ".q-char-ph{margin:0 auto;text-align:center;filter:drop-shadow(0 4px 5px rgba(0,0,0,.4))}" +
    ".q-char-ph svg{display:block;margin:0 auto}" +
    ".q-ph-cls{display:inline-block;font-size:9px;color:#2a1d0c;background:rgba(255,240,200,.7);" +
      "border-radius:5px;padding:0 5px;margin-top:1px;font-weight:700}" +
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
    ".q-gearbar{display:flex;justify-content:flex-end;margin:0 0 10px}" +
    ".q-gear{cursor:pointer;display:inline-flex;align-items:center;gap:7px;font:700 13px system-ui;" +
      "color:#f0c878;background:linear-gradient(180deg,#2a1d0f,#160d06);border:1px solid rgba(224,162,74,.55);" +
      "border-radius:10px;padding:9px 15px;box-shadow:0 3px 10px rgba(0,0,0,.4)}" +
    ".q-gear:hover{filter:brightness(1.12)}" +
    ".q-modal{position:fixed;inset:0;z-index:6000;display:flex;align-items:flex-start;justify-content:center;" +
      "background:rgba(8,5,2,.74);backdrop-filter:blur(3px);overflow:auto;padding:28px 12px}" +
    ".q-modal-box{width:min(780px,96vw);margin:auto;background:linear-gradient(180deg,#241608,#150d06);" +
      "border:1px solid rgba(224,162,74,.45);border-radius:16px;padding:16px 18px 22px;box-shadow:0 22px 64px rgba(0,0,0,.6)}" +
    ".q-modal-head{display:flex;align-items:center;margin:0 0 8px}" +
    ".q-modal-head h3{margin:0;font:800 17px Georgia,serif;color:#f0c878}" +
    ".q-modal-x{margin-left:auto;cursor:pointer;background:none;border:0;color:#caa66a;font-size:26px;line-height:1}" +
    ".q-modal-x:hover{color:#f0c878}" +
    ".q-mcard input[type=range]{accent-color:#e0a24a}" +
    /* ── сцена-стейдж 16:9 в деревянной рамке (Heroes-style) ── */
    ".qs-wrap{max-width:1120px;margin:14px auto 60px;padding:0 12px}" +
    ".qs-frame{position:relative;width:100%;aspect-ratio:16/9}" +
    ".qs-stage{position:absolute;inset:0;overflow:hidden;border-radius:8px;" +
      "background-size:100% 100%;background-repeat:no-repeat;box-shadow:inset 0 0 44px rgba(0,0,0,.35)}" +
    ".qs-stage.day{background-image:url('assets/queue/scene/scene-bg-day.jpg')}" +
    ".qs-stage.night{background-image:url('assets/queue/scene/scene-bg-night.jpg')}" +
    /* рамка ПОВЕРХ сцены (передний план, центр прозрачный) — ровно закрывает края */
    ".qs-frame-ovl{position:absolute;inset:0;pointer-events:none;z-index:9500;" +
      "background:url('assets/queue/scene/scene-frame.png') center/100% 100% no-repeat}" +
    /* анимированные факелы (спрайт 6 кадров 200x196) */
    ".qs-torch{position:absolute;transform:translate(-50%,-100%);pointer-events:none;width:64px;height:63px;" +
      "background:url('assets/queue/scene/flame.png') 0 0/384px 63px no-repeat;" +
      "animation:qsTorch .72s steps(6) infinite;filter:drop-shadow(0 0 8px rgba(255,150,40,.5))}" +
    "@keyframes qsTorch{to{background-position-x:-384px}}" +
    ".qs-stage.place .qs-item,.qs-stage.place .qs-mount,.qs-stage.place .qs-torch{" +
      "outline:2px dashed rgba(245,200,120,.95);outline-offset:2px;cursor:grab}" +
    ".qs-glow{position:absolute;width:22%;height:32%;transform:translate(-50%,-55%);pointer-events:none;" +
      "background:radial-gradient(ellipse at center,var(--gc),transparent 66%);filter:blur(7px);" +
      "opacity:.5;animation:qsGlow 3.2s ease-in-out infinite}" +
    "@keyframes qsGlow{0%,100%{opacity:.35;transform:translate(-50%,-55%) scale(.95)}" +
      "50%{opacity:.65;transform:translate(-50%,-55%) scale(1.06)}}" +
    ".qs-booth{position:absolute;transform:translate(-50%,-50%);text-align:center;z-index:9000}" +
    ".qs-cnt-line{margin:0 0 4px}" +
    ".qs-cnt{display:inline-block;padding:2px 9px;border-radius:8px;font:700 11px system-ui;color:#fff;" +
      "background:rgba(20,13,7,.82);border:1px solid var(--gc);text-shadow:0 1px 2px #000}" +
    ".qs-item{position:absolute;height:7%;width:auto;transform:translate(-50%,-100%);pointer-events:none;" +
      "filter:drop-shadow(0 3px 4px rgba(0,0,0,.4))}" +
    ".qs-mount{position:absolute;height:22%;width:auto;transform:translate(-50%,-100%);pointer-events:none;" +
      "filter:drop-shadow(0 6px 8px rgba(0,0,0,.5));animation:qsBob 3.4s ease-in-out infinite}" +
    ".qs-join{display:block;margin:6px auto 0;cursor:pointer;font:700 12px system-ui;color:#1b1006;" +
      "border:0;border-radius:9px;padding:7px 12px;background:linear-gradient(180deg,#f3d489,#d09b2e);" +
      "box-shadow:0 3px 10px rgba(245,200,120,.4)}" +
    ".qs-join.leave{background:linear-gradient(180deg,#d7a89a,#a5776b)}" +
    ".qs-join:hover{filter:brightness(1.07)}" +
    ".qs-char{position:absolute;height:16%;transform-origin:bottom center;text-align:center}" +
    ".qs-char .q-char-name{position:absolute;bottom:100%;left:50%;transform:translateX(-50%);margin-bottom:2px}" +
    ".qs-char-inner{height:100%;display:flex;align-items:flex-end;justify-content:center;" +
      "animation:qsBob 2.6s ease-in-out infinite}" +
    ".qs-char-inner img{height:100%;width:auto;filter:drop-shadow(0 5px 5px rgba(0,0,0,.45))}" +
    ".qs-char-inner .q-char-ph{height:100%}" +
    "@keyframes qsBob{0%,100%{transform:translateY(0)}50%{transform:translateY(-4%)}}" +
    ".qs-stage.admin .q-char-x,.qs-stage.admin .q-char-mv{display:flex}" +
    "@media(max-width:640px){.qs-sign{font-size:10px;padding:3px 8px}.qs-join{font-size:11px;padding:5px 9px}" +
      ".q-char-name{font-size:9px}}";
    document.head.appendChild(st);
  }

  // ── одна моделька на сцене: позиция %, масштаб по глубине (ниже=крупнее), y-сортировка ──
  function renderChar(e, p, meCanon, boothQ, idx) {
    var scale = 0.5 + (p.y / 100) * 0.62;         // ниже на экране = ближе = крупнее
    var mi = modelInfo(e);
    var mine = canon(e.main_nick) === meCanon;
    var body = mi
      ? '<img class="q-char-img" src="' + esc(mi.url) + '" data-mkey="' + esc(mi.key) +
          '" style="transform:' + transformStr(MODEL_SETTINGS[mi.key]) + '" alt="" loading="lazy">'
      : '<div class="q-char-ph">' + PH_FIGURE + '<span class="q-ph-cls">' +
          esc((e.cls || "класс?").slice(0, 12)) + "</span></div>";
    var el = document.createElement("div");
    el.className = "qs-char" + (mine ? " q-char-me" : "");
    el.dataset.id = e.id || "";
    el.style.cssText = "left:" + p.x.toFixed(2) + "%;top:" + p.y.toFixed(2) + "%;" +
      "transform:translate(-50%,-100%) scale(" + scale.toFixed(3) + ");z-index:" + Math.round(p.y * 12) + ";";
    el.innerHTML =
      (_isAdmin ? '<button class="q-char-x" title="Убрать">✕</button>' : "") +
      '<div class="q-char-name">' + esc(e.nick) + "</div>" +
      '<div class="qs-char-inner">' + body + "</div>" +
      (_isAdmin ? '<div class="q-char-mv"><button data-mv="-1" title="ближе к будке">◀</button>' +
        '<button data-mv="1" title="назад">▶</button></div>' : "");
    if (_isAdmin) {
      var id = +el.dataset.id;
      var x = el.querySelector(".q-char-x");
      if (x) x.addEventListener("click", function () {
        q("POST", "/queue/admin/remove", { entry_id: id }).then(refresh).catch(admErr);
      });
      el.querySelectorAll("[data-mv]").forEach(function (b) {
        b.addEventListener("click", function () {
          var target = idx + (+b.dataset.mv === -1 ? -1 : 1);
          q("POST", "/queue/admin/move", { entry_id: id, queue: boothQ, position: Math.max(0, target) })
            .then(refresh).catch(admErr);
        });
      });
    }
    return el;
  }

  // ── сцена: рамка + фон день/ночь + будки (свечение, предметы, счётчик, кнопка) + модельки ──
  function renderStage(state) {
    var frame = document.createElement("div");
    frame.className = "qs-frame";
    var stage = document.createElement("div");
    stage.className = "qs-stage " + (isNight() ? "night" : "day") + (_isAdmin ? " admin" : "") + (_placeMode ? " place" : "");
    var meCanon = _meAcc ? canon(_meAcc.main_nick) : "";

    BOOTHS.forEach(function (b) {
      var entries = state.queues[b.q] || [];
      // свечение будки
      var glow = document.createElement("div");
      glow.className = "qs-glow";
      glow.style.cssText = "left:" + b.bx + "%;top:" + b.by + "%;--gc:" + b.accent;
      stage.appendChild(glow);
      // ресурсы за будкой (кучкой)
      (BOOTH_ITEMS[b.q] || []).forEach(function (it, k) {
        var pos = placedPos("item:" + it, b.item.x + (k % 3) * 3.4, b.item.y + Math.floor(k / 3) * 4.6);
        var img = document.createElement("img");
        img.className = "qs-item"; img.alt = "";
        img.src = "assets/queue/scene/item/" + it + ".png";
        img.style.cssText = "left:" + pos.x.toFixed(2) + "%;top:" + pos.y.toFixed(2) +
          "%;z-index:" + Math.round(pos.y * 12);
        if (_placeMode) makeDraggable(img, "item:" + it);
        stage.appendChild(img);
      });
      // персонажи по пути (первый — у будки)
      entries.forEach(function (e, i) {
        stage.appendChild(renderChar(e, pathPoint(b.path, 1 - i * 0.11), meCanon, b.q, i));
      });
      // UI: счётчик + кнопка
      var iAmIn = entries.some(function (e) { return canon(e.main_nick) === meCanon; });
      var ui = document.createElement("div");
      ui.className = "qs-booth";
      ui.style.cssText = "left:" + b.ui.x + "%;top:" + b.ui.y + "%";
      ui.innerHTML =
        '<div class="qs-cnt-line"><span class="qs-cnt" style="--gc:' + b.accent + '">' +
          entries.length + " в очереди</span></div>" +
        (_meAcc ? '<button class="qs-join' + (iAmIn ? " leave" : "") + '" data-act="' +
          (iAmIn ? "leave" : "join") + '">' + (iAmIn ? "Выйти" : "Встать") + "</button>" : "");
      stage.appendChild(ui);
      var jb = ui.querySelector(".qs-join");
      if (jb) jb.addEventListener("click", function () {
        jb.disabled = true;
        q("POST", "/queue/" + jb.dataset.act, { queue: b.q }).then(refresh).catch(function (e2) {
          jb.disabled = false;
          alert(e2.status === 409 ? "Ты уже стоишь в этой очереди." :
                e2.status === 401 ? "Сессия истекла, войди заново." : ("Ошибка: " + (e2.detail || e2.message)));
        });
      });
    });
    // ездовой питомец «Огненный цилинь» — крупная награда у легендарной будки
    var mpos = placedPos("mount", 85, 70);
    var mount = document.createElement("img");
    mount.className = "qs-mount"; mount.alt = "";
    mount.src = "assets/queue/scene/item/mount-cilin.png";
    mount.style.cssText = "left:" + mpos.x.toFixed(2) + "%;top:" + mpos.y.toFixed(2) +
      "%;z-index:" + Math.round(mpos.y * 12);
    if (_placeMode) makeDraggable(mount, "mount");
    stage.appendChild(mount);

    // анимированные факелы
    TORCHES.forEach(function (d, i) {
      var pos = placedPos("torch:" + i, d.x, d.y);
      var tr = document.createElement("div");
      tr.className = "qs-torch";
      tr.style.cssText = "left:" + pos.x.toFixed(2) + "%;top:" + pos.y.toFixed(2) +
        "%;z-index:" + Math.round(pos.y * 12);
      if (_placeMode) makeDraggable(tr, "torch:" + i);
      stage.appendChild(tr);
    });

    frame.appendChild(stage);
    // рамка ПОВЕРХ сцены (передний план) — центр прозрачный
    var ovl = document.createElement("div");
    ovl.className = "qs-frame-ovl";
    frame.appendChild(ovl);
    return frame;
  }

  function admErr(e) { alert("Ошибка (нужны права админа?): " + (e.detail || e.message)); }

  var _roster = [], _isAdmin = false, _meAcc = null, _lastState = { queues: [[], [], []] };

  function render(state) {
    _lastState = state;
    var host = document.getElementById("scene");
    host.innerHTML = "";
    var wrap = document.createElement("div");
    wrap.className = "qs-wrap";
    if (_isAdmin) wrap.appendChild(gearBar());
    var banner = document.createElement("div");
    banner.className = "q-banner";
    banner.innerHTML = _placeMode
      ? "🎯 <b>Режим расстановки.</b> Тащи мышкой предметы, питомца и факелы — позиции сразу сохраняются. Выключить — кнопкой в панели ниже."
      : "🏰 <b>Очередь за ресурсами с КХ.</b> Встань в любую из 3 очередей — можно во все сразу. " +
        "В одну очередь дважды нельзя: снова встанешь, когда дойдёт очередь и заберёшь свой ресурс.";
    wrap.appendChild(banner);
    wrap.appendChild(renderStage(state));
    if (_isAdmin) wrap.appendChild(adminPanel(state));
    host.appendChild(wrap);
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
      '<div class="q-admin-row">' +
        '<button class="sec" id="qa-place">🎯 Ручная расстановка предметов/факелов: ' +
          (_placeMode ? "ВКЛ — тащи мышкой, сохраняется" : "выкл") + "</button>" +
      "</div>" +
      '<div class="q-admin-row">' +
        '<span style="font-size:12.5px;color:#caa66a">Пол игрока (для модели):</span>' +
        '<input id="qa-gnick" list="qa-roster-dl" placeholder="ник игрока…" autocomplete="off" style="min-width:150px">' +
        '<datalist id="qa-roster-dl"></datalist>' +
        '<button class="sec" id="qa-gm">♂ Мужской</button>' +
        '<button class="sec" id="qa-gf">♀ Женский</button>' +
        '<button class="sec" id="qa-gr">Сброс (по имени)</button>' +
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

    // пол игрока (подбор модели по полу)
    var dl = box.querySelector("#qa-roster-dl");
    dl.innerHTML = _roster.slice(0, 600).map(function (p) { return '<option value="' + esc(p.nick) + '">'; }).join("");
    function setGender(g) {
      var n = box.querySelector("#qa-gnick").value.trim();
      if (!n) { st("Укажи ник, чтобы задать пол."); return; }
      q("POST", "/queue/admin/gender", { nick: n, gender: g })
        .then(function () {
          st("✓ Пол сохранён: " + n + " → " + (g === "m" ? "мужской" : g === "f" ? "женский" : "по имени"), true);
          refresh();
        })
        .catch(function (e) { st(e.status === 404 ? "Ник не найден." : ("Ошибка: " + (e.detail || e.message))); });
    }
    box.querySelector("#qa-gm").addEventListener("click", function () { setGender("m"); });
    box.querySelector("#qa-gf").addEventListener("click", function () { setGender("f"); });
    box.querySelector("#qa-gr").addEventListener("click", function () { setGender(""); });
    box.querySelector("#qa-place").addEventListener("click", function () {
      _placeMode = !_placeMode;
      render(_lastState);
    });
    return box;
  }

  // ── кнопка «⚙️ Настройки моделей» (открывает модалку с поворотом/зеркалом) ──
  function gearBar() {
    var bar = document.createElement("div");
    bar.className = "q-gearbar";
    var b = document.createElement("button");
    b.className = "q-gear";
    b.innerHTML = "⚙️ Настройки моделей";
    b.title = "Поворот и зеркало моделей";
    b.addEventListener("click", openOrientModal);
    bar.appendChild(b);
    return bar;
  }

  function openOrientModal() {
    if (document.getElementById("q-orient-modal")) return;
    var ov = document.createElement("div");
    ov.className = "q-modal"; ov.id = "q-orient-modal";
    var box = document.createElement("div");
    box.className = "q-modal-box";
    var head = document.createElement("div");
    head.className = "q-modal-head";
    head.innerHTML = "<h3>🔄 Поворот и зеркало моделей</h3>";
    var x = document.createElement("button");
    x.className = "q-modal-x"; x.innerHTML = "&times;"; x.title = "Закрыть";
    function close() { ov.remove(); document.removeEventListener("keydown", onKey); }
    function onKey(e) { if (e.key === "Escape") close(); }
    x.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    head.appendChild(x);
    box.appendChild(head);
    box.appendChild(buildOrientSection());
    ov.appendChild(box);
    document.body.appendChild(ov);
  }

  // ── грид поворота/зеркала (best practice: тумблер зеркала + ползунок поворота, живое превью) ──
  function buildOrientSection() {
    var wrap = document.createElement("div");
    wrap.innerHTML =
      '<div style="font-size:12.5px;color:#c9b48f;margin:2px 0 14px">Персонажи идут к будке (вправо). ' +
      'Если модель смотрит не туда — включи «Зеркало». Ползунок — поворот. Меняется у всех персонажей ' +
      'с этой моделью сразу и автоматически сохраняется.</div>';
    var grid = document.createElement("div");
    grid.style.cssText = "display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px";
    ALL_MODELS.forEach(function (m) {
      var s = Object.assign({ flip: 0, rotate: 0 }, MODEL_SETTINGS[m.key] || {});
      MODEL_SETTINGS[m.key] = s;
      var card = document.createElement("div");
      card.className = "q-mcard";
      card.style.cssText = "background:rgba(0,0,0,.3);border:1px solid rgba(224,162,74,.3);border-radius:12px;padding:10px;text-align:center";
      var img = document.createElement("img");
      img.src = "assets/queue/" + m.key;
      img.style.cssText = "height:96px;width:auto;max-width:100%;object-fit:contain;background:linear-gradient(180deg,#bfe0ea,#8fc36a);border-radius:8px;padding:4px";
      function applyPreview() { img.style.transform = transformStr(s); }
      applyPreview();
      var lbl = document.createElement("div");
      lbl.textContent = m.label;
      lbl.style.cssText = "font-size:12px;color:#f6ead2;margin:6px 0;font-weight:700";
      function applyScene() {
        [].forEach.call(document.querySelectorAll('.q-char-img[data-mkey="' + m.key.replace(/"/g, '\\"') + '"]'),
          function (el) { el.style.transform = transformStr(s); });
      }
      var saveT;
      function save() {
        applyPreview(); applyScene();
        clearTimeout(saveT);
        saveT = setTimeout(function () {
          q("POST", "/queue/admin/model", { key: m.key, flip: s.flip, rotate: s.rotate })
            .catch(function (e) { alert("Не сохранилось (нужен вход админом): " + (e.detail || e.message)); });
        }, 300);
      }
      var mir = document.createElement("button");
      function paintMir() { mir.textContent = s.flip ? "⇋ Зеркало: вкл" : "⇋ Зеркало: выкл"; mir.style.opacity = s.flip ? "1" : ".7"; }
      mir.style.cssText = "cursor:pointer;width:100%;margin:0 0 8px;border:1px solid rgba(224,162,74,.5);background:rgba(20,13,7,.7);color:#f0c878;border-radius:8px;padding:7px;font-size:12px;font-weight:700";
      paintMir();
      mir.addEventListener("click", function () { s.flip = s.flip ? 0 : 1; paintMir(); save(); });
      var rd = document.createElement("div");
      rd.style.cssText = "font-size:11px;color:#a58c68;margin-bottom:2px";
      rd.textContent = "поворот: " + (s.rotate || 0) + "°";
      var rng = document.createElement("input");
      rng.type = "range"; rng.min = "-180"; rng.max = "180"; rng.step = "5"; rng.value = String(s.rotate || 0);
      rng.style.width = "100%";
      rng.addEventListener("input", function () { s.rotate = +rng.value; rd.textContent = "поворот: " + s.rotate + "°"; save(); });
      var rst = document.createElement("button");
      rst.textContent = "⟲ Сброс"; rst.title = "Без зеркала и поворота";
      rst.style.cssText = "cursor:pointer;margin-top:8px;border:1px solid rgba(224,162,74,.4);background:none;color:#caa66a;border-radius:8px;padding:5px 10px;font-size:12px";
      rst.addEventListener("click", function () { s.flip = 0; s.rotate = 0; paintMir(); rd.textContent = "поворот: 0°"; rng.value = "0"; save(); });
      card.appendChild(img); card.appendChild(lbl); card.appendChild(mir);
      card.appendChild(rd); card.appendChild(rng); card.appendChild(rst);
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
        q("GET", "/queue/placements").then(function (d) { PLACEMENTS = d.placements || {}; }).catch(function () { PLACEMENTS = {}; }),
        q("GET", "/auth/me").then(function (m) { _isAdmin = m && (m.role === "admin"); }).catch(function () { _isAdmin = false; })
      ]).then(refresh);
    }
  };
})();
