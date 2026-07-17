/* Сцена очередей за ресурсами с КХ (Фаза 2). 2D-вид: 3 параллельные очереди,
   человечки по классу/полу (персональные модели — если есть), ник над головой,
   будки в конце, окружение с деревьями. Плюс админ-управление и лог.
   Стили инжектим из JS (чтобы не зависеть от внешнего CSS). */
(function () {
  "use strict";
  var API = (window.OFFICERS_CONFIG && window.OFFICERS_CONFIG.API_URL) || "";
  var ADMIN_NICK = "Лирия!";   // от чьего имени админ тестирует очередь (это аккаунт Лира)
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
  // латиница + ГРЕЧЕСКИЕ двойники → кириллица: ники PW часто мешают шрифты
  // «Xимеко», «Aпельсин», «Βαζυλυκ»(Базилик), «Τοмατ»(Томат), «Φασολь»(Фасоль)…
  var FOLD = {
    a: "а", b: "в", c: "с", e: "е", h: "н", k: "к", m: "м", o: "о", p: "р", t: "т", x: "х", y: "у",
    "α": "а", "β": "б", "γ": "г", "δ": "д", "ε": "е", "ζ": "з", "η": "н", "θ": "о", "ι": "и", "κ": "к",
    "λ": "л", "μ": "м", "ν": "н", "ο": "о", "π": "п", "ρ": "р", "σ": "с", "ς": "с", "τ": "т", "υ": "и",
    "φ": "ф", "χ": "х", "ω": "о"
  };
  function canon(s) {
    return (s || "").toString().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")
      .split("").map(function (ch) { return FOLD[ch] || ch; }).join("");
  }

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
  // ключи строим через canon(имя) — чтобы совпадали при латинице/кириллице в никах
  var PERSONAL_SRC = { "Naomi": "_Naomi.png", "Карася": "Карася.png", "Кэя": "Кэя.png",
    "Лирия": "Лирия!.png", "Химеко": "Химеко.png" };
  var PERSONAL = {};
  Object.keys(PERSONAL_SRC).forEach(function (k) { PERSONAL[canon(k)] = PERSONAL_SRC[k]; });
  var FEMALE_ONLY = ["друид", "стрелок"], MALE_ONLY = ["оборотень", "странник"];
  function genderOf(cls, trueName) {
    var c = (cls || "").toLowerCase();
    if (FEMALE_ONLY.indexOf(c) >= 0) return "f";
    if (MALE_ONLY.indexOf(c) >= 0) return "m";
    var name = (trueName || "").trim().split(/\s+/)[0] || "";
    if (/[аяьи]$/i.test(name)) return "f";
    return "m";
  }
  // key остаётся с .png (логический id для настроек поворота), а файл — .webp
  function webpUrl(rel) { return "assets/queue/" + rel.replace(/\.png$/i, ".webp"); }

  // ── авто-центровка модели: обрезаем прозрачные поля и ставим симметричный отступ,
  //    чтобы контент был ровно по центру. Работает для любых картинок (в т.ч. загруженных),
  //    результат кэшируется по URL; зеркало/поворот/масштаб применяются поверх уже центрованной.
  var _cropCache = {};
  function autoCropImg(img) {
    if (!img) return;
    var key = img.getAttribute("src");
    if (!key || key.indexOf("data:") === 0) return;
    if (_cropCache[key]) { if (img.src !== _cropCache[key]) img.src = _cropCache[key]; return; }
    function run() {
      if (_cropCache[key]) { img.src = _cropCache[key]; return; }
      var w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h) return;
      try {
        var cv = document.createElement("canvas"); cv.width = w; cv.height = h;
        var ctx = cv.getContext("2d"); ctx.drawImage(img, 0, 0);
        var d = ctx.getImageData(0, 0, w, h).data;
        var minX = w, minY = h, maxX = -1, maxY = -1;
        for (var y = 0; y < h; y++) {
          var rw = y * w;
          for (var x = 0; x < w; x++) {
            if (d[(rw + x) * 4 + 3] > 18) {
              if (x < minX) minX = x; if (x > maxX) maxX = x;
              if (y < minY) minY = y; if (y > maxY) maxY = y;
            }
          }
        }
        if (maxX < 0) return;                          // всё прозрачное
        var cw = maxX - minX + 1, ch = maxY - minY + 1;
        var pad = Math.round(Math.max(cw, ch) * 0.03); // лёгкий симметричный отступ
        var out = document.createElement("canvas");
        out.width = cw + pad * 2; out.height = ch + pad * 2;
        out.getContext("2d").drawImage(cv, minX, minY, cw, ch, pad, pad, cw, ch);
        var url = out.toDataURL("image/png");
        _cropCache[key] = url; img.src = url;
      } catch (e) { /* CORS/иное — оставляем как есть */ }
    }
    if (img.complete && img.naturalWidth) run();
    else img.addEventListener("load", run, { once: true });
  }
  // применить авто-центровку ко всем модель-картинкам внутри контейнера
  function autoCropAll(root, selector) {
    if (!root) return;
    [].forEach.call(root.querySelectorAll(selector), autoCropImg);
  }
  var UPLOADED = {};   // ключ (person-<canon> | class-<Класс>-<m|f>) -> mtime (загружено админом)
  var REWARDS_META = {};   // ключ ресурса -> {mode,unit,threshold,total,text} (движок распределения)
  var SPOUSES = {};        // бэк-канон мэйна -> ник получателя (как хранит сервер)
  var SPOUSE_BY_NICK = {}; // фронт-канон ника -> получатель (для префилла: каноны сторон могут расходиться)
  function applySpouses(d) {
    SPOUSES = (d && d.links) || {};
    SPOUSE_BY_NICK = {};
    ((d && d.items) || []).forEach(function (it) { if (it.nick) SPOUSE_BY_NICK[canon(it.nick)] = it.recipient; });
  }
  function uploadedUrl(key) {
    return UPLOADED[key] ? (API + "/queue/model-img/" + encodeURIComponent(key) + "?v=" + UPLOADED[key]) : null;
  }
  function modelInfo(e) {
    var keys = [canon(e.main_nick), canon(e.nick)];   // мэйн приоритетнее (твин наследует)
    // 1) ЗАГРУЖЕННАЯ админом персональная модель
    for (var i = 0; i < keys.length; i++) {
      var pu = keys[i] && uploadedUrl("person-" + keys[i]);
      if (pu) return { url: pu, key: "person-" + keys[i], uploaded: true };
    }
    // 2) статическая персональная (файл в assets)
    for (var j = 0; j < keys.length; j++) {
      if (keys[j] && PERSONAL[keys[j]]) { var f = PERSONAL[keys[j]];
        return { url: webpUrl("personal/" + f), key: "personal/" + f }; }
    }
    // 3) КЛАССОВАЯ по полу
    var g = (e.gender === "f" || e.gender === "m") ? e.gender : genderOf(e.cls, e.true_name);
    var cu = uploadedUrl("class-" + e.cls + "-" + g) ||
             uploadedUrl("class-" + e.cls + "-m") || uploadedUrl("class-" + e.cls + "-f");
    if (cu) return { url: cu, key: "class-" + e.cls + "-" + g, uploaded: true };
    var set = CLASS_MODEL[(e.cls || "").toLowerCase()];
    if (set) {
      var fn = set[g] || set.m || set.f;
      return { url: webpUrl("class/" + fn), key: "class/" + fn };
    }
    // ВРЕМЕННО: для класса, которому ещё не сделали ИИ-модель → жрец по полу
    // (женский — жрица, мужской — жрец). Потом заменим на настоящие модели классов.
    var pf = g === "f" ? "Жрец (ж).png" : "Жрец (м).png";
    return { url: webpUrl("class/" + pf), key: "class/" + pf };
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
    { key: "personal/Химеко.png", label: "Химеко (личн.)" },
    { key: "scene/merchant-0.png", label: "Торговец: обычные" },
    { key: "scene/merchant-1.png", label: "Торговец: редкие" },
    { key: "scene/merchant-2.png", label: "Торговец: легендарные" },
    { key: "class/_placeholder.png", label: "Заглушка «нет модели»" }
  ];
  var MODEL_SETTINGS = {};   // key -> {flip, rotate}
  function transformStr(s) {
    if (!s) return "";
    return (s.flip ? "scaleX(-1) " : "") + (s.rotate ? ("rotate(" + s.rotate + "deg)") : "");
  }
  // живое применение настроек модели (поворот/зеркало/размер) на сцене — персонажи И торговцы
  function applyModelLive(key, s) {
    var sel = key.replace(/"/g, '\\"');
    [].forEach.call(document.querySelectorAll('.qs-char[data-mkey="' + sel + '"]'), function (el) {
      el.style.setProperty("--qs-mscale", s.scale || 1);
      var im = el.querySelector(".q-char-img"); if (im) im.style.transform = transformStr(s);
    });
    [].forEach.call(document.querySelectorAll('.qs-merchant[data-mkey="' + sel + '"]'), function (el) {
      el.style.setProperty("--qs-mscale", s.scale || 1);
      el.style.transform = "translate(-50%,-100%) " + transformStr(s);
    });
  }

  // Координаты под РЕАЛЬНУЮ картинку scene-bg (день/ночь). % от сцены.
  // Подписи будок ВПЕЧАТАНЫ в картинку — их не дублируем; сверху только счётчик+кнопка.
  // path — путь очереди: t=1 у будки (перёд), t=0 хвост (глубже в площадь).
  var BOOTHS = [
    { q: 0, title: "Обычные", accent: "#7ec46a", bx: 50, by: 26, ui: { x: 49, y: 40 }, item: { x: 60, y: 27 },
      merchant: { x: 43, y: 35 },
      path: [{ x: 45, y: 60 }, { x: 47, y: 51 }, { x: 48, y: 43 }, { x: 49, y: 35 }] },
    { q: 1, title: "Редкие (R)", accent: "#ff8a2b", bx: 65, by: 62, ui: { x: 61, y: 74 }, item: { x: 73, y: 64 },
      merchant: { x: 70, y: 59 },
      path: [{ x: 37, y: 80 }, { x: 45, y: 76 }, { x: 53, y: 72 }, { x: 60, y: 69 }] },
    { q: 2, title: "Легендарные (S)", accent: "#c07be0", bx: 80, by: 74, ui: { x: 78, y: 88 }, item: { x: 89, y: 80 },
      merchant: { x: 88, y: 77 },
      path: [{ x: 53, y: 88 }, { x: 61, y: 85 }, { x: 68, y: 83 }, { x: 74, y: 81 }] }
  ];
  // ресурсы за каждой будкой (файлы assets/queue/scene/item/*.png)
  var BOOTH_ITEMS = [
    ["kamen-doblesti", "meteorit", "zhemchuzhina", "znak-edinstva", "koloda-kart", "kamen-bessmertnyh", "pilyulya"],
    ["gramota", "prikaz-feniksa"],
    ["drakonya-cheshuya", "sushchnost-karty", "vysshiy-kamen", "mount-cilin"]
  ];
  var RES_NAME = {
    "kamen-doblesti": "Камень доблести", "meteorit": "Метеорит", "zhemchuzhina": "Жемчужина Фу Си",
    "znak-edinstva": "Знак единства", "koloda-kart": "Колода карт", "kamen-bessmertnyh": "Камень бессмертных",
    "pilyulya": "Пилюля звёздного духа 4 ур.", "gramota": "Запечатанная грамота Лиги", "prikaz-feniksa": "Приказ Феникса",
    "drakonya-cheshuya": "Драконья чешуя", "sushchnost-karty": "Сущность карты", "vysshiy-kamen": "Высший камень божества",
    "mount-cilin": "Огненный цилинь"
  };
  function resName(k) { return RES_NAME[k] || k; }
  function resImg(k) { return "assets/queue/scene/item/" + k + ".webp"; }
  // HTML для всплывающей подсказки: ник + иконка ресурса + КОЛИЧЕСТВО (для жетона —
  // суммарное за все применённые жетоны, а не размер одного стака)
  function tipHtml(e) {
    var nick = '<span class="qtip-nick">' + esc(e.nick) + "</span>";
    if (!e.resource)
      return nick + (e.privileged
        ? '<span class="qtip-priv">⚡ вне очереди — жетон ТОП-3 (ресурс не выбран)</span>'
        : '<span class="qtip-res none">ресурс ещё не выбран</span>');
    var rm = REWARDS_META[e.resource] || {}, unit = rm.unit || 0, qty;
    if (e.privileged) {
      var st = e.priv_stacks || 1;
      qty = (unit ? (st * unit) + " шт" : "") + (st > 1 ? " · " + st + " жетон(ов)" : "");
    } else {
      qty = rm.mode === "pack" ? "всё за неделю — первому" : (unit ? unit + " шт" : "");
    }
    var res = '<span class="qtip-res"><img class="qtip-ic" src="' + resImg(e.resource) + '" alt=""> ' +
      esc(resName(e.resource)) + (qty ? ' — <b>' + qty + "</b>" : "") + "</span>";
    if (e.privileged)
      return nick + '<span class="qtip-priv">⚡ берёт ВНЕ очереди — жетон ТОП-3 по доблести</span>' + res;
    return nick + '<span class="qtip-sub">стоит за:</span>' + res;
  }
  // Предупреждения по «капризным» ресурсам (падают не всегда). Смысл: встал — не потеряешь
  // очередь, получишь ПЕРВЫМ, как только предмет появится, и стоишь пока не заберёшь.
  var RES_WARN = {
    "vysshiy-kamen": "Падает только начиная с 6 этапа КХ — в конце недели его может не быть в наличии. " +
      "Ничего страшного: ты займёшь очередь и станешь ПЕРВЫМ претендентом. Как только предмет выпадет на " +
      "следующих неделях — получишь его первым и останешься в очереди, пока не заберёшь.",
    "mount-cilin": "Питомец падает С ШАНСОМ — в конце недели его может не оказаться в наличии. " +
      "Ты не потеряешь место: встав в очередь, станешь ПЕРВЫМ претендентом. Как только цилинь выпадет на " +
      "следующих неделях — получишь его первым и будешь стоять в очереди, пока не заберёшь."
  };
  function _cfgMin(key, dflt) {                 // "ЧЧ:ММ" из конфига → минуты (или дефолт)
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(CONFIG[key] || "").trim());
    return m ? (Math.min(23, +m[1]) * 60 + Math.min(59, +m[2])) : dflt;
  }
  // день/ночь: админ может зафиксировать (forceTime) либо задать ТОЧНОЕ время по МСК
  function isNight() {
    var f = CONFIG["forceTime"];
    if (f === "day") return false;
    if (f === "night") return true;
    var now = new Date();
    var mskMin = ((now.getUTCHours() + 3) % 24) * 60 + now.getUTCMinutes();  // МСК = UTC+3
    var dayStart = _cfgMin("dayFrom", 7 * 60);      // день с 07:00 МСК (по умолч.)
    var nightStart = _cfgMin("nightFrom", 20 * 60); // ночь с 20:00 МСК (по умолч.)
    var isDay = dayStart <= nightStart
      ? (mskMin >= dayStart && mskMin < nightStart)
      : (mskMin >= dayStart || mskMin < nightStart);
    return !isDay;
  }

  var PLACEMENTS = {};     // key ('item:...'/'mount'/'env:<id>') -> {x,y} ручная расстановка
  var CONFIG = {};         // key -> string: 'path:N' (JSON точек), 'size:frame|char|item|mount'
  var ENV = [];            // объекты окружения (загружены админом): [{id,key,w,flip,rotate,z}]
  function loadEnv() {
    ENV = [];
    try { var a = JSON.parse(CONFIG["env_objects"] || "[]"); if (Array.isArray(a)) ENV = a; } catch (e) {}
  }
  function saveEnv() { saveCfg("env_objects", JSON.stringify(ENV)); }
  function envNextId() { var m = 0; ENV.forEach(function (o) { if (+o.id > m) m = +o.id; }); return m + 1; }
  var _placeMode = false;  // режим ручной расстановки предметов
  var _pathMode = false;   // режим редактирования формы очередей
  function getPath(qi) {
    var raw = CONFIG["path:" + qi];
    if (raw) { try { var a = JSON.parse(raw); if (a && a.length >= 2) return a; } catch (e) {} }
    return BOOTHS[qi].path;
  }
  function getSize(key, dflt) { var v = parseFloat(CONFIG["size:" + key]); return (isFinite(v) && v > 0) ? v : dflt; }
  function saveCfg(key, val) {
    CONFIG[key] = String(val);
    q("POST", "/queue/admin/config", { key: key, val: String(val) }).catch(function () {});
  }
  function placedPos(key, dx, dy) {
    var p = PLACEMENTS[key];
    return p ? { x: p.x, y: p.y } : { x: dx, y: dy };
  }
  // слой объекта: 'front' всегда спереди, 'back' всегда сзади, иначе авто по глубине (y)
  function zOf(key, y) {
    var z = PLACEMENTS[key] && PLACEMENTS[key].z;
    if (z === "front") return 9200;
    if (z === "back") return 1;
    return Math.round(y * 12);
  }
  function zToast(txt) {
    var t = document.getElementById("qs-ztoast");
    if (!t) { t = document.createElement("div"); t.id = "qs-ztoast"; document.body.appendChild(t); }
    t.textContent = txt; t.className = "show";
    clearTimeout(t._h); t._h = setTimeout(function () { t.className = ""; }, 1400);
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
          var zc = (PLACEMENTS[pkey] && PLACEMENTS[pkey].z) || "";
          PLACEMENTS[pkey] = { x: lx, y: ly, z: zc };
          el.style.zIndex = zOf(pkey, ly);
          q("POST", "/queue/admin/placement", { key: pkey, x: lx, y: ly, z: zc }).catch(function () {});
        }
      }
      document.addEventListener(moveEvt, move); document.addEventListener(endEvt, end);
    }
    el.addEventListener("mousedown", function (e) { e.preventDefault(); start("mousemove", "mouseup"); });
    el.addEventListener("touchstart", function () { start("touchmove", "touchend"); }, { passive: true });
    // правый клик — переключить слой: авто → на передний план → на задний → авто
    el.addEventListener("contextmenu", function (e) {
      e.preventDefault();
      var cur = (PLACEMENTS[pkey] && PLACEMENTS[pkey].z) || "";
      var next = cur === "" ? "front" : cur === "front" ? "back" : "";
      var px = parseFloat(el.style.left) || (PLACEMENTS[pkey] && PLACEMENTS[pkey].x) || 0;
      var py = parseFloat(el.style.top) || (PLACEMENTS[pkey] && PLACEMENTS[pkey].y) || 0;
      PLACEMENTS[pkey] = { x: px, y: py, z: next };
      el.style.zIndex = zOf(pkey, py);
      q("POST", "/queue/admin/placement", { key: pkey, x: px, y: py, z: next }).catch(function () {});
      zToast(next === "front" ? "⬆️ На передний план" : next === "back" ? "⬇️ На задний план" : "↕️ Авто (по глубине)");
    });
  }
  // редактор формы очереди — линия пути (SVG) + перетаскиваемые точки
  function svgLine(pts, color) {
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "qs-pathsvg");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("preserveAspectRatio", "none");
    var pl = document.createElementNS(ns, "polyline");
    pl.setAttribute("fill", "none"); pl.setAttribute("stroke", color);
    pl.setAttribute("stroke-width", "0.6"); pl.setAttribute("stroke-dasharray", "1.6 1.6");
    pl.setAttribute("opacity", "0.9"); pl.setAttribute("stroke-linecap", "round");
    svg._pl = pl; svg.appendChild(pl); updateSvgLine(svg, pts);
    return svg;
  }
  function updateSvgLine(svg, pts) {
    svg._pl.setAttribute("points", pts.map(function (p) { return p.x + "," + p.y; }).join(" "));
  }
  // ── индикатор направления очереди: светящийся «бегущий» след к будке + шевроны ──
  function svgFlow(pts, color) {
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "qs-flowsvg");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("preserveAspectRatio", "none");
    var pstr = pts.map(function (p) { return p.x + "," + p.y; }).join(" ");
    var glow = document.createElementNS(ns, "polyline");  // мягкая подсветка дорожки
    glow.setAttribute("fill", "none"); glow.setAttribute("stroke", color);
    glow.setAttribute("stroke-width", "1.5"); glow.setAttribute("opacity", "0.18");
    glow.setAttribute("stroke-linecap", "round"); glow.setAttribute("stroke-linejoin", "round");
    glow.setAttribute("points", pstr);
    var dash = document.createElementNS(ns, "polyline");  // бегущие точки к будке
    dash.setAttribute("class", "qs-flowdash");
    dash.setAttribute("fill", "none"); dash.setAttribute("stroke", color);
    dash.setAttribute("stroke-width", "0.5"); dash.setAttribute("opacity", "0.62");
    dash.setAttribute("stroke-linecap", "round"); dash.setAttribute("stroke-dasharray", "0.5 3.3");
    dash.setAttribute("points", pstr);
    svg.appendChild(glow); svg.appendChild(dash);
    return svg;
  }
  function renderFlow(b, pth) {
    var frag = document.createDocumentFragment();
    frag.appendChild(svgFlow(pth, b.accent));
    var AR = 1.79;  // соотношение сцены — чтобы шеврон смотрел визуально верно
    [0.30, 0.52, 0.74].forEach(function (t, k) {
      var p = pathPoint(pth, t), p2 = pathPoint(pth, Math.min(1, t + 0.05));
      var ang = Math.atan2((p2.y - p.y), (p2.x - p.x) * AR) * 180 / Math.PI;
      var ch = document.createElement("div");
      ch.className = "qs-chev";
      ch.style.cssText = "left:" + p.x.toFixed(2) + "%;top:" + p.y.toFixed(2) + "%;--gc:" + b.accent +
        ";transform:translate(-50%,-50%) rotate(" + ang.toFixed(1) + "deg);animation-delay:" + (k * 0.32).toFixed(2) + "s";
      ch.textContent = "❯";  // ❯ указывает к будке
      frag.appendChild(ch);
    });
    return frag;
  }
  function makePathDraggable(dot, qi, idx, pts, svg) {
    dot.style.cursor = "grab";
    function start(moveEvt, endEvt) {
      var stage = dot.closest(".qs-stage"); if (!stage) return;
      var rect = stage.getBoundingClientRect();
      function move(e) {
        var pt = e.touches ? e.touches[0] : e;
        var x = Math.max(0, Math.min(100, ((pt.clientX - rect.left) / rect.width) * 100));
        var y = Math.max(0, Math.min(100, ((pt.clientY - rect.top) / rect.height) * 100));
        pts[idx] = { x: +x.toFixed(2), y: +y.toFixed(2) };
        dot.style.left = x + "%"; dot.style.top = y + "%"; updateSvgLine(svg, pts);
      }
      function end() {
        document.removeEventListener(moveEvt, move); document.removeEventListener(endEvt, end);
        saveCfg("path:" + qi, JSON.stringify(pts)); render(_lastState);
      }
      document.addEventListener(moveEvt, move); document.addEventListener(endEvt, end);
    }
    dot.addEventListener("mousedown", function (e) { e.preventDefault(); start("mousemove", "mouseup"); });
    dot.addEventListener("touchstart", function () { start("touchmove", "touchend"); }, { passive: true });
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
    ".q-char-name{position:relative;font:700 10.5px/1.4 Georgia,serif;color:#f7ecd4;white-space:nowrap;" +
      "margin:0 auto 4px;padding:1.5px 10px;border-radius:9px;letter-spacing:.3px;" +
      "background:linear-gradient(180deg,rgba(60,42,20,.95),rgba(26,17,8,.95));" +
      "border:1px solid rgba(240,200,120,.5);" +
      "box-shadow:0 1px 4px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,220,150,.16);" +
      "text-shadow:0 1px 2px #000;display:inline-block;max-width:120px;overflow:hidden;text-overflow:ellipsis}" +
    ".q-char-name::after{content:'';position:absolute;left:50%;top:calc(100% - 1px);transform:translateX(-50%);" +
      "border:4px solid transparent;border-top-color:rgba(240,200,120,.5);filter:drop-shadow(0 1px 0 rgba(0,0,0,.4))}" +
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
    /* сворачиваемые секции админ-панели */
    ".q-sec{margin:0 0 8px;border:1px solid rgba(224,162,74,.22);border-radius:11px;background:rgba(0,0,0,.16);overflow:hidden}" +
    ".q-sec>summary{cursor:pointer;list-style:none;padding:11px 14px;font:800 13.5px system-ui;color:#f0c878;" +
      "display:flex;align-items:center;gap:10px;flex-wrap:wrap;user-select:none}" +
    ".q-sec>summary::-webkit-details-marker{display:none}" +
    ".q-sec>summary::before{content:'▸';color:#caa66a;font-size:12px;transition:transform .15s}" +
    ".q-sec[open]>summary::before{transform:rotate(90deg)}" +
    ".q-sec>summary:hover{background:rgba(224,162,74,.06)}" +
    ".q-sec[open]>summary{border-bottom:1px solid rgba(224,162,74,.16);background:rgba(224,162,74,.05)}" +
    ".q-sec-hint{font:400 11px system-ui;color:#8a795a}" +
    ".q-sec-body{padding:12px 14px}" +
    ".q-sec-body>.q-admin-row:last-child{margin-bottom:0}" +
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
    /* ── сцена-стейдж 16:9 в деревянной рамке (Heroes-style) ── */
    ".qs-wrap{max-width:1340px;margin:14px auto 60px;padding:0 12px}" +
    /* рамка и сцена одной пропорции (1.79) → равные отступы не искажают картинку */
    ".qs-frame{position:relative;width:100%;aspect-ratio:2400/1340}" +
    /* сцена заходит под дерево по всему периметру (окно рамки ~16%/22%, сцена 13%) —
       дерево перекрывает край картинки как настоящая рама, без зазоров */
    /* inset ~15% ≈ окно рамки (16%/22%) → дерево закрывает лишь тонкую кромку, видна почти вся картина */
    ".qs-stage{position:absolute;inset:15%;overflow:hidden;border-radius:4px;" +
      "background-size:100% 100%;background-repeat:no-repeat;box-shadow:inset 0 0 18px rgba(0,0,0,.18)}" +
    ".qs-stage.day{background-image:url('assets/queue/scene/scene-bg-day.webp')}" +
    ".qs-stage.night{background-image:url('assets/queue/scene/scene-bg-night.webp')}" +
    /* рамка ПОВЕРХ сцены (передний план, центр прозрачный) — на весь прямоугольник */
    ".qs-frame-ovl{position:absolute;inset:0;pointer-events:none;z-index:99999;" +
      "background:url('assets/queue/scene/scene-frame.webp?v=3') center/100% 100% no-repeat;" +
      "filter:drop-shadow(0 4px 10px rgba(0,0,0,.45))}" +
    ".qs-stage.place .qs-item,.qs-stage.place .qs-mount,.qs-stage.place .qs-merchant,.qs-stage.place .qs-btn-abs,.qs-stage.place .qs-env{" +
      "outline:2px dashed rgba(245,200,120,.95);outline-offset:2px;cursor:grab}" +
    /* объекты окружения (деревья/камни/костры), загружаются админом */
    ".qs-env{position:absolute;transform-origin:50% 100%;pointer-events:none;" +
      "filter:drop-shadow(0 6px 9px rgba(0,0,0,.45))}" +
    ".qs-stage.place .qs-env{pointer-events:auto}" +
    /* редактор формы очередей: линия пути + точки */
    ".qs-pathsvg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:8500;overflow:visible}" +
    /* индикатор направления очереди — мягкий след на земле под персонажами */
    ".qs-flowsvg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:4;overflow:visible;" +
      "filter:drop-shadow(0 0 3px rgba(255,224,160,.28))}" +
    ".qs-flowdash{animation:qsFlowMove 1.15s linear infinite}" +
    "@keyframes qsFlowMove{to{stroke-dashoffset:-3.8}}" +
    ".qs-chev{position:absolute;z-index:6;font:900 15px system-ui;line-height:1;color:var(--gc);pointer-events:none;" +
      "text-shadow:0 0 5px var(--gc),0 1px 1px rgba(0,0,0,.6);opacity:.22;animation:qsChevPulse 1.5s ease-in-out infinite}" +
    "@keyframes qsChevPulse{0%,100%{opacity:.18}45%{opacity:.88}}" +
    /* торговец у будки */
    ".qs-merchant{position:absolute;height:calc(20% * var(--qs-merch-scale,1) * var(--qs-mscale,1));width:auto;" +
      "transform-origin:50% 100%;pointer-events:none;filter:drop-shadow(0 5px 7px rgba(0,0,0,.5))}" +
    ".qs-pathdot{position:absolute;width:22px;height:22px;transform:translate(-50%,-50%);z-index:8600;" +
      "border-radius:50%;background:var(--gc);border:2px solid #fff;color:#1b1006;font:800 11px system-ui;" +
      "display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,.55);touch-action:none}" +
    ".qs-glow{position:absolute;width:22%;height:32%;transform:translate(-50%,-55%);pointer-events:none;" +
      "background:radial-gradient(ellipse at center,var(--gc),transparent 66%);filter:blur(7px);" +
      "opacity:.5;animation:qsGlow 3.2s ease-in-out infinite}" +
    "@keyframes qsGlow{0%,100%{opacity:.35;transform:translate(-50%,-55%) scale(.95)}" +
      "50%{opacity:.65;transform:translate(-50%,-55%) scale(1.06)}}" +
    ".qs-booth{position:absolute;transform:translate(-50%,-50%);text-align:center;z-index:9000}" +
    ".qs-btn-abs{position:absolute;transform:translate(-50%,-50%);z-index:9000;margin:0;" +
      "transition:transform .08s ease,filter .08s ease,box-shadow .08s ease}" +
    /* анимация нажатия — кнопка «проваливается» */
    ".qs-btn-abs:active{transform:translate(-50%,-50%) translateY(2px) scale(.93)!important;" +
      "filter:brightness(.82);box-shadow:0 0 0 rgba(0,0,0,0)!important}" +
    /* суперспособность топ-3 */
    ".qs-super{margin:10px auto 0;display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 14px;" +
      "border:1px solid rgba(255,210,74,.5);border-radius:12px;" +
      "background:linear-gradient(180deg,rgba(70,52,18,.55),rgba(40,28,8,.7));box-shadow:0 0 26px -10px #ffd24a}" +
    ".qs-super.preview{border-color:rgba(224,162,74,.3);box-shadow:none;opacity:.92}" +
    ".qs-super-ic{font-size:26px;filter:drop-shadow(0 0 8px rgba(255,200,80,.6))}" +
    ".qs-super-token{width:46px;height:46px;object-fit:contain;flex:0 0 auto;filter:drop-shadow(0 0 8px rgba(255,210,120,.7))}" +
    ".qs-super-txt{flex:1 1 auto;min-width:180px;font-size:12.5px;color:#f6ead2;line-height:1.35}" +
    ".qs-super-btn{flex:0 0 auto;cursor:pointer;font:800 13px system-ui;color:#1b1006;border:0;border-radius:10px;" +
      "padding:10px 16px;background:linear-gradient(180deg,#ffe08a,#eab531);box-shadow:0 3px 12px rgba(255,200,80,.4);" +
      "transition:transform .08s,filter .08s}" +
    ".qs-super-btn:hover{filter:brightness(1.08)}.qs-super-btn:active{transform:translateY(2px) scale(.96);filter:brightness(.88)}" +
    /* 3 полосы полных очередей под сценой */
    ".qs-strips{margin:12px auto 0;max-width:100%;display:flex;flex-direction:column;gap:8px}" +
    ".qs-lane{border:1px solid rgba(224,162,74,.28);border-left:3px solid var(--gc);border-radius:11px;" +
      "background:linear-gradient(180deg,rgba(28,18,9,.6),rgba(18,11,5,.75));padding:7px 9px}" +
    ".qs-lane-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin:0 0 6px}" +
    ".qs-lane-title{font:800 12.5px Georgia,serif;color:var(--gc);text-shadow:0 1px 2px #000}" +
    ".qs-lane-cnt{position:relative;display:inline-block;width:74px;flex:0 0 auto;line-height:0}" +
    ".qs-lane-cnt-bg{width:74px;height:auto;display:block;filter:drop-shadow(0 2px 3px rgba(0,0,0,.4))}" +
    ".qs-lane-cnt-n{position:absolute;top:50%;left:64%;transform:translate(-50%,-50%);font:800 13px system-ui;" +
      "color:#ffe6b0;text-shadow:0 1px 2px #000,0 0 4px rgba(0,0,0,.6)}" +
    ".qs-lane-you{font:800 11px system-ui;color:var(--gc);text-shadow:0 1px 2px #000;margin-left:2px}" +
    ".qs-lane-sw{display:flex;align-items:stretch;gap:5px}" +
    ".qs-lane-arrow{flex:0 0 auto;width:26px;border:1px solid rgba(224,162,74,.35);background:rgba(20,13,7,.7);" +
      "color:#e0a24a;border-radius:8px;cursor:pointer;font-size:12px;transition:filter .1s,transform .08s}" +
    ".qs-lane-arrow:hover{filter:brightness(1.2)}.qs-lane-arrow:active{transform:scale(.9)}" +
    ".qs-lane-strip{flex:1 1 auto;display:flex;gap:6px;overflow-x:auto;scroll-behavior:smooth;" +
      "padding:3px 2px;scrollbar-width:thin;justify-content:space-between;align-items:stretch}" +
    /* кнопка «Встать/Выйти» в начале полосы */
    ".qs-lane-join{flex:0 0 auto;align-self:center;cursor:pointer;border:0;background:none;padding:2px;width:60px;height:76px;" +
      "display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:1px;transition:filter .08s}" +
    ".qs-lane-join-ic{width:50px;height:50px;flex:0 0 auto;object-fit:contain;filter:drop-shadow(0 3px 5px rgba(0,0,0,.45))}" +
    ".qs-lane-join-tx{height:22px;display:flex;align-items:center;justify-content:center;overflow:hidden;" +
      "font:800 9px/1.1 system-ui;color:#f6ead2;text-align:center;max-width:60px;text-shadow:0 1px 2px #000}" +
    ".qs-lane-join.leave .qs-lane-join-tx{color:#ffcdbf}" +
    ".qs-lane-join:hover{filter:brightness(1.08)}.qs-lane-join:active{transform:translateY(2px) scale(.95)}" +
    /* ОТДЕЛЬНЫЙ КВАДРАТ торговца: НПЦ + сворачиваемый список ресурсов */
    ".qs-merch-box{flex:0 0 auto;align-self:center;width:300px;display:flex;flex-direction:column;gap:4px;" +
      "padding:7px 8px;border:1px solid var(--gc);border-radius:11px;" +
      "background:linear-gradient(180deg,rgba(40,26,12,.5),rgba(20,13,7,.72));box-shadow:inset 0 0 22px -10px var(--gc)}" +
    ".qs-merch-npc{display:flex;align-items:center;gap:8px}" +
    ".qs-merch-img{height:48px;width:auto;max-width:48px;object-fit:contain;flex:0 0 auto;filter:drop-shadow(0 4px 5px rgba(0,0,0,.5))}" +
    ".qs-merch-title{font:800 10.5px system-ui;color:var(--gc);line-height:1.2;text-shadow:0 1px 2px #000}" +
    ".qs-merch-det{position:relative}" +
    // ВЕСЬ верх (НПЦ+строка) — одна кнопка-разворот
    ".qs-merch-det>summary{cursor:pointer;list-style:none;display:flex;flex-direction:column;gap:5px;padding:0;border-radius:9px;transition:background .12s}" +
    ".qs-merch-det>summary::-webkit-details-marker{display:none}" +
    ".qs-merch-det>summary:hover{background:rgba(224,162,74,.08)}" +
    ".qs-merch-sumline{display:flex;align-items:center;gap:5px;font:700 10px system-ui;color:#caa66a;" +
      "padding:4px 2px 2px;border-top:1px dashed rgba(224,162,74,.28)}" +
    ".qs-merch-sumline::before{content:'▸';transition:transform .12s;flex:0 0 auto}" +
    ".qs-merch-det[open] .qs-merch-sumline{color:var(--gc)}" +
    ".qs-merch-det[open] .qs-merch-sumline::before{transform:rotate(90deg)}" +
    ".qs-merch-det>summary:hover .qs-merch-sumline{color:var(--gc)}" +
    /* раскрытый список — ОВЕРЛЕЙ вниз поверх нижних полос, не растягивает высоту полосы */
    ".qs-merch-det[open] .qs-merch-res{position:absolute;top:calc(100% + 3px);left:-8px;right:-8px;z-index:400;" +
      "background:linear-gradient(180deg,#241608,#160d06);border:1px solid var(--gc);border-radius:10px;" +
      "padding:8px 9px;box-shadow:0 14px 34px rgba(0,0,0,.65);transform-origin:top center;" +
      "animation:qMerchDrop .17s ease}" +
    "@keyframes qMerchDrop{from{opacity:0;transform:translateY(-6px) scaleY(.85)}to{opacity:1;transform:none}}" +
    ".qs-merch-res{display:flex;flex-direction:column;gap:3px;padding-top:4px}" +
    ".qs-mres{display:flex;align-items:flex-start;gap:5px;font:600 10.5px system-ui;color:#e8dcc4;cursor:pointer;" +
      "padding:4px 4px;border-radius:7px;transition:background .1s}" +
    ".qs-mres img{margin-top:1px}.qs-mres-nm{align-self:center}" +
    ".qs-mres:hover{background:rgba(224,162,74,.14)}.qs-mres:active{background:rgba(224,162,74,.24)}" +
    ".qs-mres img{height:20px;width:20px;object-fit:contain;flex:0 0 auto;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))}" +
    ".qs-mres-nm{flex:1 1 120px;min-width:0;white-space:normal;line-height:1.25;word-break:break-word}" +
    ".qs-mres-st{flex:0 0 auto;font:700 8.5px system-ui;color:#1b1006;background:var(--gc);" +
      "padding:1px 5px;border-radius:6px;white-space:nowrap}" +
    ".qs-mres-cnt{flex:0 0 auto;font:800 8.5px system-ui;color:#e8dcc4;background:rgba(0,0,0,.4);" +
      "border:1px solid rgba(224,162,74,.3);padding:1px 5px;border-radius:6px;white-space:nowrap}" +
    ".qs-mres-cnt.free{color:#0e2c12;background:linear-gradient(180deg,#a8f0b0,#6cd07a);border-color:#3a8a45;" +
      "animation:qsFree 1.5s ease-in-out infinite}" +
    "@keyframes qsFree{0%,100%{box-shadow:0 0 0 0 rgba(108,208,122,.5)}50%{box-shadow:0 0 8px 1px rgba(108,208,122,.7)}}" +
    ".qs-merch-free{margin-left:6px;font:800 9px system-ui;color:#0e2c12;background:linear-gradient(180deg,#a8f0b0,#6cd07a);" +
      "padding:1px 6px;border-radius:6px}" +
    ".qs-merch-res::-webkit-scrollbar{width:5px}.qs-merch-res::-webkit-scrollbar-thumb{background:rgba(224,162,74,.4);border-radius:3px}" +
    "@media(max-width:640px){.qs-merch-box{width:220px}}" +
    ".qs-lane-strip::-webkit-scrollbar{height:6px}.qs-lane-strip::-webkit-scrollbar-thumb{background:rgba(224,162,74,.4);border-radius:3px}" +
    ".qs-lane-empty{font-size:11.5px;color:#7a6a4a;padding:10px 6px;font-style:italic}" +
    // ── ячейка полосы: только вырезанная фигурка (без рамки) + облачко-мысль с ресурсом над головой ──
    ".qs-cell{flex:0 0 auto;width:76px;display:flex;flex-direction:column;align-items:center;gap:2px;" +
      "padding:2px 2px 4px;background:none;border:0;position:relative}" +
    ".qs-cell.me .qs-cell-img{filter:drop-shadow(0 0 7px var(--gc)) drop-shadow(0 2px 3px rgba(0,0,0,.5))}" +
    ".qs-cell.priv .qs-cell-img{filter:drop-shadow(0 0 8px #ffd24a) drop-shadow(0 0 14px rgba(255,210,74,.6));animation:qsCellPriv 1.6s ease-in-out infinite}" +
    "@keyframes qsCellPriv{0%,100%{filter:drop-shadow(0 0 6px #ffd24a) drop-shadow(0 2px 3px rgba(0,0,0,.5))}50%{filter:drop-shadow(0 0 15px #ffd24a) drop-shadow(0 0 22px rgba(255,210,74,.7))}}" +
    // облачко над головой — только картинка ресурса (без названия)
    ".qs-cell-toplbl{font:800 8.5px system-ui;color:#1b1006;white-space:nowrap;background:linear-gradient(180deg,#ffe486,#eab531);" +
      "padding:1px 7px;border-radius:7px;box-shadow:0 1px 4px rgba(255,200,80,.6);margin-bottom:1px}" +
    ".qs-bubble{display:inline-flex;align-items:center;justify-content:center;margin-bottom:9px;padding:4px;border-radius:12px;position:relative;" +
      "background:linear-gradient(180deg,#fffdf6,#ffedc4);border:1px solid rgba(205,150,60,.55);" +
      "box-shadow:0 2px 7px rgba(0,0,0,.32);z-index:2}" +
    ".qs-bubble::after{content:'';position:absolute;bottom:-4px;left:50%;margin-left:-3px;width:7px;height:7px;border-radius:50%;background:#ffedc4;border:1px solid rgba(205,150,60,.55)}" +
    ".qs-bubble::before{content:'';position:absolute;bottom:-9px;left:50%;margin-left:-2px;width:4px;height:4px;border-radius:50%;background:#ffedc4;border:1px solid rgba(205,150,60,.55)}" +
    ".qs-bubble-ic{width:24px;height:24px;object-fit:contain;flex:0 0 auto;display:block}" +
    ".qs-bubble-ic.big{width:40px;height:40px}" +   // огненный цилинь — крупнее (мелкий рисунок)
    ".qs-bubble-q{font:800 15px system-ui;color:#9a8760;width:24px;height:24px;display:flex;align-items:center;justify-content:center}" +
    ".qs-bubble.empty{background:linear-gradient(180deg,#efe6d4,#ddcfb2);border-color:rgba(150,130,95,.5)}" +
    ".qs-bubble.priv{background:linear-gradient(180deg,#fff2c2,#ffdf7a);border-color:#eab531}" +
    ".qs-cell-mdl{position:relative;display:flex;align-items:flex-end;justify-content:center;min-height:40px}" +
    ".qs-cell-img{height:44px;width:auto;max-width:60px;object-fit:contain;filter:drop-shadow(0 2px 3px rgba(0,0,0,.5))}" +
    ".qs-cell-img.ph{display:flex;align-items:center;justify-content:center;width:40px;height:40px;color:#8a795a;font-weight:700}" +
    ".qs-cell-badge{position:absolute;bottom:-2px;left:-2px;font:800 9px system-ui;color:#1b1006;background:var(--gc);" +
      "min-width:15px;text-align:center;border-radius:8px;padding:1px 4px;box-shadow:0 1px 3px rgba(0,0,0,.5)}" +
    ".qs-cell-nick{font:700 9.5px system-ui;color:#f6ead2;max-width:74px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center;text-shadow:0 1px 2px #000}" +
    ".qs-cell.clk{cursor:pointer}.qs-cell.clk:hover .qs-cell-img{filter:drop-shadow(0 0 9px var(--gc)) drop-shadow(0 2px 3px rgba(0,0,0,.5))}" +
    ".qs-cell-edit{margin-top:1px;font:800 7.5px system-ui;color:#1b1006;background:linear-gradient(180deg,#f3d489,#d09b2e);" +
      "padding:1px 6px;border-radius:7px;white-space:nowrap}" +
    "@media(max-width:640px){.qs-cell{width:64px}.qs-cell-img{height:38px}.qs-bubble{max-width:62px}}" +
    ".qs-change-note{display:flex;align-items:flex-start;gap:9px;margin:8px 0 4px;padding:9px 13px;border-radius:12px;" +
      "background:linear-gradient(180deg,rgba(60,42,16,.92),rgba(36,24,9,.92));border:1px solid rgba(240,200,120,.5);" +
      "box-shadow:inset 0 1px 0 rgba(255,224,160,.12)}" +
    ".qs-cn-ic{font-size:20px;flex:0 0 auto;filter:drop-shadow(0 0 6px rgba(240,200,120,.5))}" +
    ".qs-cn-tx{font:500 12.5px/1.5 system-ui;color:#efe0c2}.qs-cn-tx b{color:#f0c878}" +
    "@media(max-width:640px){.qs-cn-tx{font-size:11.5px}}" +
    ".qs-off-head{display:flex;align-items:center;gap:11px;margin:20px 0 8px;padding:11px 15px;border-radius:13px;" +
      "background:linear-gradient(180deg,rgba(46,44,86,.55),rgba(24,22,48,.55));border:1px solid rgba(150,150,235,.45);" +
      "box-shadow:inset 0 1px 0 rgba(190,190,255,.14)}" +
    ".qs-off-ic{font-size:22px;flex:0 0 auto;color:#bcbcff;filter:drop-shadow(0 0 7px rgba(150,150,235,.7))}" +
    ".qs-off-tx{display:flex;flex-direction:column;gap:1px}" +
    ".qs-off-tx b{font:800 14.5px system-ui;color:#cfcfff;letter-spacing:.2px}" +
    ".qs-off-sub{font:500 11.5px/1.4 system-ui;color:#b7b7d6}" +
    // «реклама» жетона ТОП-3
    ".qs-token-ad{display:flex;align-items:center;gap:13px;margin:8px 0 6px;padding:11px 16px;border-radius:15px;position:relative;overflow:hidden;" +
      "background:linear-gradient(110deg,#3a2a0c,#5b400f 45%,#3a2a0c);border:1px solid rgba(255,210,110,.6);" +
      "box-shadow:0 6px 24px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,230,160,.22),0 0 34px rgba(245,200,120,.14)}" +
    ".qs-token-ad::before{content:'';position:absolute;top:0;left:-40%;width:35%;height:100%;pointer-events:none;" +
      "background:linear-gradient(100deg,transparent,rgba(255,240,190,.35),transparent);animation:qTaShine 4.5s ease-in-out infinite}" +
    "@keyframes qTaShine{0%{left:-40%}55%,100%{left:130%}}" +
    ".qs-ta-token{width:56px;height:56px;object-fit:contain;flex:0 0 auto;filter:drop-shadow(0 0 10px rgba(255,210,120,.85));animation:qTaStar 2.8s ease-in-out infinite}" +
    "@keyframes qTaStar{0%,100%{transform:scale(1) rotate(-4deg)}50%{transform:scale(1.1) rotate(4deg)}}" +
    ".qs-ta-body{flex:1 1 auto;min-width:0}" +
    ".qs-ta-title{font:800 15px Georgia,serif;color:#ffe08a;text-shadow:0 0 10px rgba(245,200,120,.5)}" +
    ".qs-ta-title span{font:600 12px system-ui;color:#d8b877}" +
    ".qs-ta-tx{margin-top:2px;font:500 12px/1.5 system-ui;color:#f2e3c2}.qs-ta-tx b{color:#ffd98a}" +
    ".qs-ta-badge{flex:0 0 auto;align-self:center;font:800 12px system-ui;color:#5a2d0a;white-space:nowrap;" +
      "background:linear-gradient(180deg,#ffe486,#eab531);padding:6px 12px;border-radius:20px;transform:rotate(4deg);" +
      "box-shadow:0 3px 10px rgba(0,0,0,.4);animation:qTaBadge 1.8s ease-in-out infinite}" +
    "@keyframes qTaBadge{0%,100%{transform:rotate(4deg) scale(1)}50%{transform:rotate(4deg) scale(1.07)}}" +
    "@media(max-width:640px){.qs-ta-badge{display:none}.qs-ta-title{font-size:13.5px}.qs-ta-tx{font-size:11px}}" +
    ".qs-cnt-line{margin:0 0 4px}" +
    ".qs-cnt{display:inline-block;padding:2px 9px;border-radius:8px;font:700 11px system-ui;color:#fff;" +
      "background:rgba(20,13,7,.82);border:1px solid var(--gc);text-shadow:0 1px 2px #000}" +
    ".qs-item{position:absolute;height:calc(7% * var(--qs-item-scale,1));width:auto;" +
      "transform:translate(-50%,-100%);pointer-events:none;filter:drop-shadow(0 3px 4px rgba(0,0,0,.4))}" +
    ".qs-mount{position:absolute;height:calc(22% * var(--qs-mount-scale,1));width:auto;" +
      "transform:translate(-50%,-100%);pointer-events:none;" +
      "filter:drop-shadow(0 6px 8px rgba(0,0,0,.5))}" +
    ".qs-join{display:block;margin:6px auto 0;cursor:pointer;font:700 12px system-ui;color:#1b1006;" +
      "border:0;border-radius:9px;padding:7px 12px;background:linear-gradient(180deg,#f3d489,#d09b2e);" +
      "box-shadow:0 3px 10px rgba(245,200,120,.4)}" +
    ".qs-join.leave{background:linear-gradient(180deg,#d7a89a,#a5776b)}" +
    ".qs-join:hover{filter:brightness(1.07)}" +
    ".qs-list{display:block;margin:0 auto;cursor:pointer;font:700 11px system-ui;color:#f6ead2;" +
      "border:1px solid var(--gc);border-radius:8px;padding:4px 10px;background:rgba(20,13,7,.82);" +
      "box-shadow:0 2px 6px rgba(0,0,0,.5);text-shadow:0 1px 2px #000}" +
    ".qs-list-btn{cursor:pointer;border:0;background:none;padding:0;display:flex;flex-direction:column;align-items:center;gap:0;transition:transform .08s,filter .08s}" +
    ".qs-list-img{width:46px;height:46px;object-fit:contain;filter:drop-shadow(0 3px 5px rgba(0,0,0,.5))}" +
    ".qs-list-cap{font:800 9px system-ui;color:#f6ead2;text-shadow:0 1px 2px #000;margin-top:-4px}" +
    ".qs-list-btn:hover{filter:brightness(1.12)}.qs-list-btn:active{filter:brightness(.85)}" +
    ".qs-list:hover{background:rgba(40,26,12,.92);filter:brightness(1.1)}" +
    /* модалки сцены (выбор ресурса / полный список) */
    ".qs-modal-ov{position:fixed;inset:0;z-index:100000;background:rgba(8,5,2,.72);backdrop-filter:blur(3px);" +
      "display:flex;align-items:center;justify-content:center;padding:20px}" +
    ".qs-modal{max-width:580px;width:100%;max-height:92vh;overflow:auto;background:linear-gradient(180deg,#241608,#160d06);" +
      "border:1px solid rgba(224,162,74,.45);border-radius:16px;box-shadow:0 0 50px rgba(0,0,0,.7);position:relative}" +
    ".qs-modal-head{position:sticky;top:0;display:flex;align-items:center;justify-content:space-between;" +
      "padding:14px 18px;background:linear-gradient(180deg,#2c1c0b,#1c1207);border-bottom:1px solid rgba(224,162,74,.3);" +
      "font:700 16px Georgia,serif;color:#f0c878}" +
    ".qs-modal-x{background:none;border:0;color:#caa66a;font-size:18px;cursor:pointer;line-height:1}" +
    ".qs-modal-x:hover{color:#fff}" +
    ".qs-respick{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:8px;padding:12px}" +
    ".qs-rescard{cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:4px;padding:8px 6px;" +
      "background:rgba(0,0,0,.3);border:1px solid rgba(224,162,74,.3);border-radius:11px;color:#f6ead2;" +
      "font:700 12px system-ui;text-align:center}" +
    ".qs-rescard:hover{border-color:#f0c878;background:rgba(224,162,74,.12);transform:translateY(-2px)}" +
    ".qs-rescard.sel{border-color:#7ec46a;background:rgba(126,196,106,.16);box-shadow:0 0 0 1px #7ec46a}" +
    ".qs-rescard img{height:48px;width:auto;object-fit:contain;filter:drop-shadow(0 3px 5px rgba(0,0,0,.5))}" +
    ".qs-rc-name{font:700 11.5px/1.15 system-ui}" +
    ".qs-rc-stack{font:600 10px system-ui;color:#8fc36a}" +
    ".qs-rc-total{font-size:9px;color:#8a795a}" +
    /* пикер v2 (выбор+получатель+повтор+план) */
    ".qs-pick2{padding:8px 16px 0}" +
    ".qs-p2-lbl{font:700 12px system-ui;color:#caa66a;margin:9px 0 5px}" +
    ".qs-p2-inp{width:100%;box-sizing:border-box;padding:8px 11px;font-size:14px;border-radius:9px;" +
      "border:1px solid rgba(224,162,74,.42);background:rgba(20,13,7,.82);color:#f3e8d2}" +
    ".qs-p2-warn{display:none;font-size:11.5px;margin:5px 0 0}" +
    ".qs-res-warn{display:none;margin:2px 0 4px;padding:9px 12px;border-radius:10px;font:500 12px/1.5 system-ui;" +
      "color:#ffe0b0;background:linear-gradient(180deg,rgba(150,70,20,.4),rgba(90,40,10,.35));" +
      "border:1px solid rgba(240,150,70,.55);box-shadow:inset 0 1px 0 rgba(255,200,120,.12)}" +
    ".qs-res-warn b{color:#ffd18a}" +
    ".qs-p2-note{margin:2px 0 8px;padding:9px 12px;border-radius:10px;font:500 12px/1.5 system-ui;color:#f2e3c2;" +
      "background:linear-gradient(180deg,rgba(70,52,18,.55),rgba(40,28,10,.5));border:1px solid rgba(255,210,110,.45)}" +
    ".qs-p2-note b{color:#ffd98a}" +
    ".qs-p2-chk{display:flex;align-items:center;gap:7px;font-size:12.5px;color:#f0dcb4;margin:9px 0 2px;cursor:pointer}" +
    ".qs-p2-planrow{display:flex;gap:6px;align-items:center}" +
    ".qs-p2-planrow select{flex:1;min-width:0;padding:6px 8px;border-radius:8px;background:rgba(20,13,7,.82);color:#f3e8d2;border:1px solid rgba(224,162,74,.4)}" +
    ".qs-p2-plan{display:flex;flex-wrap:wrap;gap:5px;margin-top:7px}" +
    // сворачиваемый блок необязательных настроек
    ".qs-p2-more{margin:10px 0 2px;border:1px solid rgba(224,162,74,.28);border-radius:11px;background:rgba(0,0,0,.16);overflow:hidden}" +
    ".qs-p2-more>summary{cursor:pointer;list-style:none;padding:10px 13px;font:800 13px system-ui;color:#e6c48f;" +
      "display:flex;align-items:center;gap:6px}" +
    ".qs-p2-more>summary::-webkit-details-marker{display:none}" +
    ".qs-p2-more>summary::before{content:'▸';color:#caa66a;transition:transform .15s}" +
    ".qs-p2-more[open]>summary::before{transform:rotate(90deg)}" +
    ".qs-p2-more>summary:hover{background:rgba(224,162,74,.06)}" +
    ".qs-p2-more[open]>summary{border-bottom:1px solid rgba(224,162,74,.18);background:rgba(224,162,74,.05)}" +
    ".qs-p2-more-sub{font:400 11px system-ui;color:#8a795a}" +
    ".qs-p2-more-body{padding:4px 13px 12px}" +
    "@media(max-width:640px){.qs-p2-more-sub{display:none}}" +
    ".qs-plan-chip{display:inline-flex;align-items:center;font:600 11.5px system-ui;color:#f0dcb4;" +
      "padding:3px 6px 3px 9px;border:1px solid rgba(126,196,106,.4);border-radius:11px;background:rgba(126,196,106,.1)}" +
    /* липкий низ окна: кнопка «Встать» ВСЕГДА видна без прокрутки */
    ".qs-pick2-foot{position:sticky;bottom:0;margin:10px -16px 0;padding:11px 16px 14px;" +
      "background:linear-gradient(180deg,rgba(22,13,6,0),rgba(22,13,6,.97) 34%)}" +
    ".qs-pick2-foot .qs-join{display:block;margin:0 auto;width:min(330px,82%);aspect-ratio:440/191;height:auto;min-height:0;" +
      "border:0;box-shadow:none;background:url(assets/queue/ui/btn-join-lit.webp) center/contain no-repeat;" +
      "color:#ffe8bc;font:800 15px/1.15 system-ui;text-shadow:0 1px 3px #000,0 0 5px rgba(0,0,0,.6);" +
      "padding:0 8% 0 25%;filter:drop-shadow(0 4px 9px rgba(0,0,0,.4))}" +
    ".qs-pick2-foot .qs-join:hover{filter:drop-shadow(0 4px 12px rgba(255,200,120,.4)) brightness(1.05)}" +
    ".qs-pick2 .qs-join:disabled{opacity:1;color:#c8b892;cursor:default;" +
      "background:url(assets/queue/ui/btn-join-dim.webp) center/contain no-repeat;filter:grayscale(.15)}" +
    ".qs-fl-flags{display:inline-flex;gap:3px;flex:0 0 auto}" +
    ".qs-fl-flag{font:700 10px system-ui;padding:1px 5px;border-radius:5px}" +
    /* отчёт распределения */
    ".qs-distrep{padding:12px 16px 18px}" +
    ".qs-dr-head{font-size:12.5px;color:#c9b48f;margin:0 0 10px;padding-bottom:8px;border-bottom:1px solid rgba(224,162,74,.2)}" +
    ".qs-dr-sec{margin:0 0 12px}" +
    ".qs-dr-sec h4{margin:0 0 6px;font:800 13px Georgia,serif;color:#f0c878}" +
    ".qs-dr-row{font-size:12.5px;color:#f6ead2;padding:3px 6px;border-bottom:1px solid rgba(224,162,74,.08);display:flex;flex-wrap:wrap;gap:5px;align-items:center}" +
    ".qs-dr-empty{font-size:11.5px;color:#8a795a;padding:4px 6px}" +
    ".qs-dr-val{font-size:11px;color:#a58c68}" +
    ".qs-dr-to{font:700 11px system-ui;color:#8fc36a}" +
    ".qs-dr-top{font:800 9.5px system-ui;color:#1b1006;background:#ffd24a;padding:1px 6px;border-radius:6px}" +
    ".qs-dr-prov{font:800 9.5px system-ui;color:#1b1006;background:#ff9a44;padding:1px 6px;border-radius:6px}" +
    /* история и активность очереди */
    ".q-hist-tabs{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:0 0 8px}" +
    ".q-hist-tab.active{background:rgba(224,162,74,.38);color:#fff}" +
    ".q-hist-week{margin:0 0 5px;border:1px solid rgba(224,162,74,.2);border-radius:9px;background:rgba(0,0,0,.16);overflow:hidden}" +
    ".q-hist-week>summary{cursor:pointer;list-style:none;padding:8px 11px;font-size:12px;color:#f0dcb4}" +
    ".q-hist-week>summary::-webkit-details-marker{display:none}" +
    ".q-hist-week[open]>summary{border-bottom:1px solid rgba(224,162,74,.15)}" +
    ".q-hist-body{padding:6px 10px}" +
    ".q-act-list{display:flex;flex-direction:column;gap:2px;max-height:420px;overflow:auto}" +
    ".q-act-row{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;font-size:12px;padding:3px 6px;border-bottom:1px solid rgba(224,162,74,.08)}" +
    ".q-act-t{color:#8a795a;font-size:10.5px;min-width:98px;flex:0 0 auto}" +
    ".q-act-k{color:#f0c878;font-weight:700;min-width:150px;flex:0 0 auto}" +
    ".q-act-q{color:#caa66a;font-size:10.5px}" +
    ".q-act-n{color:#f6ead2;font-weight:600}" +
    ".q-act-d{color:#a58c68;flex:1 1 auto;min-width:120px}" +
    ".qs-dr-group{margin:0 0 10px;padding:8px 10px;border:1px solid rgba(224,162,74,.25);border-radius:9px;background:rgba(0,0,0,.18)}" +
    ".qs-dr-gh{font:800 12px system-ui;color:#f0c878;margin:0 0 4px}" +
    ".qs-dr-gp{font-size:12.5px;color:#f6ead2;line-height:1.5;margin:0 0 5px}" +
    ".qs-dr-gr{font-size:12px;color:#a9e08f;line-height:1.55;border-top:1px dashed rgba(224,162,74,.2);padding-top:5px}" +
    ".qs-fulllist{padding:10px 14px 16px}" +
    ".qs-fl-row{display:flex;align-items:center;gap:10px;padding:7px 8px;border-bottom:1px solid rgba(224,162,74,.14)}" +
    ".qs-fl-row.waiting{opacity:.62}" +
    ".qs-fl-num{width:24px;text-align:center;font:700 13px system-ui;color:#caa66a;flex:0 0 auto}" +
    ".qs-fl-mdl{height:44px;width:36px;object-fit:contain;flex:0 0 auto;" +
      "background:linear-gradient(180deg,rgba(190,224,234,.18),rgba(143,195,106,.18));border-radius:6px}" +
    ".qs-fl-mdl.ph{display:flex;align-items:center;justify-content:center;color:#8a795a;font-weight:700}" +
    ".qs-fl-nick{font:700 13px system-ui;color:#f6ead2;flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
    ".qs-fl-res{height:26px;width:26px;object-fit:contain;flex:0 0 auto}" +
    ".qs-fl-rname{font-size:11px;color:#c9b48f;flex:0 0 auto}" +
    ".qs-fl-rcpt{font:700 11px system-ui;color:#8fc36a;flex:0 0 auto;padding:1px 7px;border-radius:6px;" +
      "background:rgba(126,196,106,.14);border:1px solid rgba(126,196,106,.3)}" +
    ".qs-fl-tag{font:700 10px system-ui;padding:2px 7px;border-radius:6px;flex:0 0 auto}" +
    ".qs-fl-tag.shown{background:rgba(126,196,106,.2);color:#a9e08f;border:1px solid rgba(126,196,106,.4)}" +
    ".qs-fl-tag.wait{background:rgba(224,162,74,.16);color:#e6c48f;border:1px solid rgba(224,162,74,.35)}" +
    ".qs-char{position:absolute;height:calc(16% * var(--qs-char-scale,1) * var(--qs-mscale,1));transform-origin:bottom center;text-align:center}" +
    ".qs-char .q-char-name{position:absolute;bottom:100%;left:50%;transform:translateX(-50%);margin-bottom:2px}" +
    ".qs-char-inner{height:100%;display:flex;align-items:flex-end;justify-content:center;" +
      "animation:qsBob 2.6s ease-in-out infinite}" +
    ".qs-char-inner img{height:100%;width:auto;filter:drop-shadow(0 5px 5px rgba(0,0,0,.45))}" +
    ".qs-char-inner .q-char-ph{height:100%}" +
    "@keyframes qsBob{0%,100%{transform:translateY(0)}50%{transform:translateY(-4%)}}" +
    /* привилегия «жетон ТОП-3»: божественное свечение + подпись над головой */
    ".q-char-priv .q-char-img{animation:qsPrivGlow 1.6s ease-in-out infinite}" +
    "@keyframes qsPrivGlow{0%,100%{filter:drop-shadow(0 0 7px #ffd24a) drop-shadow(0 0 13px #ffae00) drop-shadow(0 5px 5px rgba(0,0,0,.45))}" +
      "50%{filter:drop-shadow(0 0 15px #fff0a0) drop-shadow(0 0 26px #ffc030) drop-shadow(0 5px 5px rgba(0,0,0,.45))}}" +
    ".q-char-priv::after{content:'';position:absolute;left:50%;bottom:2%;width:70%;height:26%;transform:translateX(-50%);" +
      "background:radial-gradient(ellipse at center,rgba(255,210,74,.55),transparent 70%);filter:blur(5px);z-index:-1;" +
      "animation:qsPrivAura 1.6s ease-in-out infinite;pointer-events:none}" +
    "@keyframes qsPrivAura{0%,100%{opacity:.5;transform:translateX(-50%) scale(.9)}50%{opacity:.85;transform:translateX(-50%) scale(1.1)}}" +
    ".q-char-priv-lbl{position:absolute;bottom:120%;left:50%;transform:translateX(-50%);white-space:nowrap;" +
      "font:800 12px system-ui;color:#1b1006;background:linear-gradient(180deg,#ffe486,#eab531);" +
      "padding:3px 10px;border-radius:9px;box-shadow:0 2px 8px rgba(255,200,80,.6);z-index:9;" +
      "border:1px solid rgba(120,80,20,.35);text-shadow:0 1px 0 rgba(255,255,255,.25);" +
      "animation:qsPrivLbl 1.6s ease-in-out infinite}" +
    "@keyframes qsPrivLbl{0%,100%{box-shadow:0 2px 6px rgba(255,200,80,.4)}50%{box-shadow:0 2px 12px rgba(255,220,120,.85)}}" +
    // над головой в сцене: стопка метка-ТОП3 → облачко-ресурс → ник
    ".qs-char .q-char-head{position:absolute;bottom:100%;left:50%;transform:translateX(-50%);display:flex;" +
      "flex-direction:column;align-items:center;gap:2px;margin-bottom:3px;pointer-events:none;z-index:9}" +
    ".qs-char .q-char-head .q-char-name{position:static;transform:none;margin:0}" +
    ".qs-char .q-char-head .q-char-priv-lbl{position:static;transform:none;bottom:auto;left:auto}" +
    // ресурс — просто иконка над ником; качается синхронно с моделькой (та же qsBob)
    ".qs-char-res{width:23px;height:23px;object-fit:contain;pointer-events:auto;cursor:default;" +
      "filter:drop-shadow(0 0 3px rgba(0,0,0,.7)) drop-shadow(0 2px 2px rgba(0,0,0,.5));animation:qsBob 2.6s ease-in-out infinite}" +
    ".qs-char-res.big{width:46px;height:46px}" +   // огненный цилинь — крупнее (мелкий рисунок)
    ".qs-char .q-char-head .q-char-name{pointer-events:auto}" +
    ".q-char-priv .qs-char-res{filter:drop-shadow(0 0 5px #ffd24a) drop-shadow(0 2px 2px rgba(0,0,0,.5))}" +
    // всплывающая подсказка (ник + ресурс) для полосы и сцены
    ".qtip{position:fixed;z-index:2147483600;pointer-events:none;max-width:250px;padding:9px 12px;border-radius:11px;" +
      "background:linear-gradient(180deg,#33210d,#190f05);border:1px solid rgba(240,200,120,.6);" +
      "box-shadow:0 12px 32px rgba(0,0,0,.6),inset 0 1px 0 rgba(255,224,160,.16);display:flex;flex-direction:column;gap:3px}" +
    ".qtip::after{content:'';position:absolute;bottom:-6px;left:50%;transform:translateX(-50%) rotate(45deg);width:11px;height:11px;" +
      "background:#190f05;border-right:1px solid rgba(240,200,120,.6);border-bottom:1px solid rgba(240,200,120,.6)}" +
    ".qtip.below::after{bottom:auto;top:-6px;border:0;border-left:1px solid rgba(240,200,120,.6);border-top:1px solid rgba(240,200,120,.6)}" +
    ".qtip-nick{font:800 13.5px Georgia,serif;color:#ffe08a;text-shadow:0 0 8px rgba(245,200,120,.4)}" +
    ".qtip-res{display:flex;align-items:center;gap:5px;font:600 12.5px system-ui;color:#e7d6b7}.qtip-res b{color:#ffd98a}.qtip-res.none{color:#9a8a68;font-style:italic}" +
    ".qtip-ic{width:20px;height:20px;object-fit:contain;flex:0 0 auto;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))}" +
    ".qtip-sub{font:600 10.5px system-ui;color:#9a8a68;letter-spacing:.3px}" +
    ".qtip-priv{font:700 11.5px/1.35 system-ui;color:#ffd24a}" +
    ".qtip-hint{font:600 11px system-ui;color:#9fe0a0}" +
    // ── свиток «дроп по этапам КХ» слева ──
    "#qs-scroll{position:fixed;left:0;top:120px;z-index:2147482000;display:flex;align-items:flex-start;max-width:96vw}" +
    "#qs-scroll .qsc-handle{flex:0 0 auto;cursor:pointer;border:0;width:52px;padding:14px 4px;border-radius:0 12px 12px 0;" +
      "background:linear-gradient(90deg,#5b3c17,#7a5320 60%,#5b3c17);border-right:2px solid #caa66a;color:#ffe6b0;" +
      "font:800 11px/1.2 Georgia,serif;text-align:center;box-shadow:3px 4px 14px rgba(0,0,0,.5);writing-mode:initial}" +
    "#qs-scroll .qsc-handle .qsc-ic{font-size:22px;display:block;margin-bottom:3px;filter:drop-shadow(0 0 5px rgba(255,200,110,.6))}" +
    "#qs-scroll .qsc-handle:hover{filter:brightness(1.08)}" +
    "#qs-scroll .qsc-body{flex:0 1 auto;max-width:0;overflow:hidden;transition:max-width .35s ease,opacity .3s ease;opacity:0}" +
    "#qs-scroll.open .qsc-body{max-width:min(420px,88vw);opacity:1}" +
    "#qs-scroll .qsc-parch{margin:0;max-height:74vh;overflow-y:auto;width:min(420px,88vw);padding:16px 18px;" +
      "background:linear-gradient(180deg,#efd9a8,#e6ca92 55%,#d8b876);color:#3a2a10;border:2px solid #8a5a24;" +
      "border-left:0;border-radius:0 10px 10px 0;box-shadow:6px 8px 26px rgba(0,0,0,.55),inset 0 0 40px rgba(150,100,40,.25)}" +
    "#qs-scroll .qsc-parch::-webkit-scrollbar{width:7px}#qs-scroll .qsc-parch::-webkit-scrollbar-thumb{background:rgba(120,80,30,.5);border-radius:4px}" +
    ".qsc-title{font:800 16px Georgia,serif;color:#5a3610;text-align:center;margin:0 0 4px;text-shadow:0 1px 0 rgba(255,240,200,.5)}" +
    ".qsc-sub{font:600 11px system-ui;color:#7a5a2a;text-align:center;margin:0 0 12px}" +
    ".qsc-stage{margin:0 0 11px;padding:0 0 9px;border-bottom:1px dashed rgba(120,80,30,.4)}" +
    ".qsc-stage:last-child{border-bottom:0}" +
    ".qsc-stage-h{font:800 13px Georgia,serif;color:#7a3a10;margin:0 0 4px}" +
    ".qsc-item{display:flex;align-items:center;gap:7px;font:600 12px system-ui;color:#3a2a10;padding:2px 0}" +
    ".qsc-ic{width:24px;height:24px;flex:0 0 auto;object-fit:contain;filter:drop-shadow(0 1px 2px rgba(90,60,20,.4))}" +
    ".qsc-item .qname{flex:1 1 auto;min-width:0}" +
    ".qsc-item .qn{font-weight:800;white-space:nowrap;color:#5a3610;flex:0 0 auto}" +
    ".qsc-item.qsc-clk{cursor:pointer;border-radius:7px;margin:0 -6px;padding:2px 6px;transition:background .1s,transform .1s}" +
    ".qsc-item.qsc-clk:hover{background:rgba(150,100,40,.22)}.qsc-item.qsc-clk:hover .qname{color:#7a3a10}" +
    ".qsc-item.qsc-clk:active{transform:scale(.98)}" +
    ".qsc-item.q1 .qname{color:#8a4a10}.qsc-item.q2 .qname{color:#6a2a8a}" +
    ".qsc-item.qcilin .qname{color:#8a2a6a;font-weight:800}.qsc-item.qcilin .qn{color:#8a2a6a}" +
    ".qsc-mode{font-size:10px;color:#8a6a3a;font-style:italic}" +
    ".qsc-chance{margin-top:8px;padding:9px 11px;border-radius:9px;background:rgba(150,60,30,.14);border:1px solid rgba(150,80,30,.4)}" +
    ".qsc-chance-h{font:800 12.5px Georgia,serif;color:#8a3a10;margin:0 0 3px}" +
    ".qsc-chance-tx{font:600 11.5px/1.45 system-ui;color:#5a3010}" +
    "@media(max-width:640px){#qs-scroll{top:88px}#qs-scroll .qsc-handle{width:42px;font-size:9.5px;padding:10px 3px}}" +
    "#qs-ztoast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%) translateY(12px);z-index:2147483600;opacity:0;" +
      "pointer-events:none;transition:opacity .2s,transform .2s;padding:9px 18px;border-radius:12px;font:800 14px system-ui;" +
      "color:#1b1006;background:linear-gradient(180deg,#ffe486,#eab531);box-shadow:0 8px 26px rgba(0,0,0,.5)}" +
    "#qs-ztoast.show{opacity:1;transform:translateX(-50%) translateY(0)}" +
    ".qs-stage.admin .q-char-x,.qs-stage.admin .q-char-mv{display:flex}" +
    "@media(max-width:640px){.qs-sign{font-size:10px;padding:3px 8px}" +
      ".qs-join{font-size:10.5px;padding:5px 9px}.qs-list{font-size:9.5px;padding:3px 7px}" +
      ".q-char-name{font:700 9px/1.3 Georgia,serif;max-width:74px}" +
      ".q-admin{padding:11px 10px}.q-admin-row{gap:6px}}";
    document.head.appendChild(st);
    setupTip();
    setupDropScroll();
  }

  // ── свиток «дроп по этапам КХ» слева (для всех) ──
  var _dropsCache = null;
  function setupDropScroll() {
    if (document.getElementById("qs-scroll")) return;
    var el = document.createElement("div"); el.id = "qs-scroll";
    el.innerHTML =
      '<div class="qsc-body"><div class="qsc-parch" id="qsc-parch">Загрузка…</div></div>' +
      '<button class="qsc-handle" title="Что падает с этапов КХ"><span class="qsc-ic">📜</span>Дроп<br>по этапам<br>КХ</button>';
    document.body.appendChild(el);
    el.querySelector(".qsc-handle").addEventListener("click", function () {
      el.classList.toggle("open");
      if (el.classList.contains("open")) loadDrops(el.querySelector("#qsc-parch"));
    });
    // клик по ресурсу в свитке → встать в нужную очередь за ним (как у торговца)
    el.querySelector("#qsc-parch").addEventListener("click", function (ev) {
      var it = ev.target.closest(".qsc-item[data-res]"); if (!it) return;
      pickResourceForQueue(+it.getAttribute("data-q"), it.getAttribute("data-res"));
    });
  }
  // Встать/сменить ресурс за ресурсом `res` в очереди `q` — универсально (свиток, торговец)
  function pickResourceForQueue(q, res) {
    var b = BOOTHS[q]; if (!b) return;
    if (_isAdmin && !_meAcc) { openResourcePicker(b, null, res); return; }   // админ встаёт как Лирия!
    if (!_meAcc) { alert("Чтобы встать в очередь, войди как игрок (по своему нику)."); return; }
    var mc = canon(_meAcc.main_nick), mine = null;
    (_lastState.queues[q] || []).forEach(function (e) {
      if (canon(e.main_nick) === mc && !e.privileged) mine = e;             // моё обычное место
    });
    if (mine) openResourcePicker(b, { resource: res, recipient: mine.recipient || "",
      auto_repeat: mine.auto_repeat, plan: mine.auto_plan || [] });
    else openResourcePicker(b, null, res);
  }
  function loadDrops(host) {
    function paint() { autoCropAll(host, ".qsc-ic"); }   // иконки заполняют место (цилинь без пустот)
    if (_dropsCache) { host.innerHTML = _dropsCache; paint(); return; }
    q("GET", "/queue/drops").then(function (d) { _dropsCache = dropsHtml(d); host.innerHTML = _dropsCache; paint(); })
      .catch(function () { host.innerHTML = '<div class="qsc-sub">Не удалось загрузить.</div>'; });
  }
  function dropsHtml(d) {
    var MODE = { stack: "по очереди, стаками", pack: "всё за неделю разом — первому в очереди", fixed: "каждому" };
    var qn = d.queues || ["Обычные", "Редкие (R)", "Легендарные (S)"];
    var cilinName = d.cilin_name || "Огненный цилинь";
    var h = '<div class="qsc-title">📜 Награды по этапам КХ</div>' +
      '<div class="qsc-sub">что и сколько падает с каждого этапа. 👆 <b>Нажми на любой ресурс — встанешь за ним в очередь</b></div>';
    var cilinRes = d.cilin_res || "mount-cilin";
    (d.stages || []).forEach(function (s) {
      if ((!s.items || !s.items.length) && !s.cilin) return;
      h += '<div class="qsc-stage"><div class="qsc-stage-h">Этап ' + s.stage + "</div>";
      (s.items || []).forEach(function (it) {
        h += '<div class="qsc-item qsc-clk q' + it.q + '" data-res="' + esc(it.res) + '" data-q="' + it.q +
          '" title="Встать в очередь за: ' + esc(it.name) + '">' +
          '<img class="qsc-ic" src="' + resImg(it.res) + '" alt="">' +
          '<span class="qname">' + esc(it.name) +
          ' <span class="qsc-mode">(' + esc(qn[it.q] || "") + " · " + esc(MODE[it.mode] || it.mode) + ")</span></span>" +
          '<span class="qn">×' + it.qty + "</span></div>";
      });
      if (s.cilin)   // питомец падает с шансом с этого этапа — тоже можно встать (очередь 2)
        h += '<div class="qsc-item qsc-clk qcilin" data-res="' + esc(cilinRes) + '" data-q="2" title="Встать в очередь за: ' + esc(cilinName) + '">' +
          '<img class="qsc-ic" src="' + resImg(cilinRes) + '" alt="">' +
          '<span class="qname">🎲 ' + esc(cilinName) +
          ' <span class="qsc-mode">(легендарные · с шансом)</span></span><span class="qn">×1</span></div>';
      h += "</div>";
    });
    h += '<div class="qsc-chance"><div class="qsc-chance-h">🎲 ' + esc(cilinName) + "</div>" +
      '<div class="qsc-chance-tx">' + esc(d.cilin_note || "падает с шансом") + "</div></div>";
    h += '<div class="qsc-sub" style="margin-top:10px">💡 «стаками» — раздаётся по очереди пока есть; ' +
      '«всё за неделю разом первому» — весь недельный объём этого ресурса отдаётся ОДНОМУ, первому в очереди; ' +
      '«каждому» — фиксировано каждому в очереди.</div>';
    return h;
  }

  // ── единая всплывающая подсказка (ник + ресурс) для полосы и сцены ──
  var _tipEl = null;
  function setupTip() {
    if (_tipEl) return;
    _tipEl = document.createElement("div");
    _tipEl.className = "qtip"; _tipEl.style.display = "none";
    document.body.appendChild(_tipEl);
    function place(t) {
      var r = t.getBoundingClientRect();
      _tipEl.style.display = "flex"; _tipEl.classList.remove("below");
      var tw = _tipEl.offsetWidth, th = _tipEl.offsetHeight;
      var x = Math.max(6, Math.min(r.left + r.width / 2 - tw / 2, window.innerWidth - tw - 6));
      var y = r.top - th - 10;
      if (y < 6) { y = r.bottom + 10; _tipEl.classList.add("below"); }   // не влезло сверху → снизу
      _tipEl.style.left = x + "px"; _tipEl.style.top = y + "px";
    }
    document.addEventListener("mouseover", function (e) {
      var t = e.target.closest && e.target.closest("[data-tip]");
      if (!t) return;
      _tipEl.innerHTML = t.getAttribute("data-tip"); place(t);
    });
    document.addEventListener("mouseout", function (e) {
      var t = e.target.closest && e.target.closest("[data-tip]");
      if (t && !(e.relatedTarget && t.contains(e.relatedTarget))) _tipEl.style.display = "none";
    });
    window.addEventListener("scroll", function () { if (_tipEl) _tipEl.style.display = "none"; }, true);
  }

  // ── одна моделька на сцене: позиция %, масштаб по глубине (ниже=крупнее), y-сортировка ──
  function renderChar(e, p, meCanon, boothQ, idx) {
    var scale = 0.5 + (p.y / 100) * 0.62;         // ниже на экране = ближе = крупнее
    var mi = modelInfo(e);
    var mine = canon(e.main_nick) === meCanon;
    // Очередь ОБЫЧНЫХ ресурсов (0) на картинке идёт справа налево → зеркалим модели,
    // чтобы они «смотрели вперёд» по ходу очереди, а не спиной.
    var mirror = boothQ === 0 ? "scaleX(-1) " : "";
    var body = mi
      ? '<img class="q-char-img" src="' + esc(mi.url) + '" data-mkey="' + esc(mi.key) +
          '" style="transform:' + mirror + transformStr(MODEL_SETTINGS[mi.key]) + '" alt="" loading="lazy" decoding="async">'
      : '<div class="q-char-ph">' + PH_FIGURE + '<span class="q-ph-cls">' +
          esc((e.cls || "класс?").slice(0, 12)) + "</span></div>";
    var el = document.createElement("div");
    el.className = "qs-char" + (mine ? " q-char-me" : "") + (e.privileged ? " q-char-priv" : "");
    el.dataset.id = e.id || "";
    if (mi) el.dataset.mkey = mi.key;   // для точечной регулировки размера этой модели
    var mscale = (mi && MODEL_SETTINGS[mi.key] && +MODEL_SETTINGS[mi.key].scale) || 1;
    el.style.cssText = "left:" + p.x.toFixed(2) + "%;top:" + p.y.toFixed(2) + "%;--qs-mscale:" + mscale + ";" +
      "transform:translate(-50%,-100%) scale(" + scale.toFixed(3) + ");z-index:" + (e.privileged ? 8800 : Math.round(p.y * 12)) + ";";
    // всплывающая подсказка (ник + ресурс, для привилегии — пояснение)
    el.setAttribute("data-tip", tipHtml(e));
    // над головой (сверху вниз): рисунок ресурса → метка ТОП-3 → ник
    var resIcon = e.resource
      ? '<img class="qs-char-res' + (e.resource === "mount-cilin" ? " big" : "") + '" src="' + resImg(e.resource) + '" alt="" title="">' : "";
    el.innerHTML =
      (_isAdmin ? '<button class="q-char-x" title="Убрать">✕</button>' : "") +
      '<div class="q-char-head">' +
        resIcon +                                        // ресурс — САМЫЙ ВЕРХ
        (e.privileged ? '<div class="q-char-priv-lbl">⚡ Жетон ТОП-3</div>' : "") +   // ТОП-3 — над ником
        '<div class="q-char-name">' + esc(e.nick) + "</div>" +
      "</div>" +
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

  // ── универсальная модалка сцены ──
  function sceneModal(title, bodyNode) {
    var ov = document.createElement("div");
    ov.className = "qs-modal-ov";
    var box = document.createElement("div");
    box.className = "qs-modal";
    var head = document.createElement("div");
    head.className = "qs-modal-head";
    head.innerHTML = "<span>" + esc(title) + "</span>";
    var x = document.createElement("button");
    x.className = "qs-modal-x"; x.textContent = "✕";
    function close() { ov.remove(); document.removeEventListener("keydown", onKey); }
    function onKey(e) { if (e.key === "Escape") close(); }
    x.addEventListener("click", close);
    ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
    document.addEventListener("keydown", onKey);
    head.appendChild(x); box.appendChild(head); box.appendChild(bodyNode);
    ov.appendChild(box); document.body.appendChild(ov);
    return { close: close };
  }
  // кто получатель относительно игрока: "self" | "twin" | "spouse" | "other"
  function recipientRel(rcpt) {
    if (!rcpt || !rcpt.trim()) return "self";
    var rc = canon(rcpt.trim());
    var myMain = canon(_meAcc && _meAcc.main_nick);
    if (rc === myMain) return "twin";                       // сам себе (мэйн)
    var found = _roster.filter(function (p) { return canon(p.nick) === rc; })[0];
    if (found && canon(found.main_nick) === myMain) return "twin";
    var sp = SPOUSE_BY_NICK[myMain] || "";
    if (sp && canon(sp) === rc) return "spouse";
    return "other";
  }

  // выбор ресурса при вставании (или правка, edit={resource,recipient,auto_repeat,plan})
  function openResourcePicker(b, edit, presel) {
    var isPriv = !!(edit && edit.privileged);                 // меняем ресурс жетона ТОП-3 (отдельная запись)
    var items = (BOOTH_ITEMS[b.q] || []).filter(function (it) {
      return !isPriv || (REWARDS_META[it] || {}).mode !== "pack";   // жетон — только обычные стаковые
    });
    var sel = edit ? (edit.resource || "") : (presel || "");  // выбранный/пред-выбранный ресурс
    var planArr = (edit && edit.plan ? edit.plan.slice() : []);
    var body = document.createElement("div");
    body.className = "qs-pick2";
    var defRcpt = edit ? (edit.recipient || "")
      : (SPOUSE_BY_NICK[canon(_meAcc && _meAcc.main_nick)] || "");
    var planOpts = items.map(function (it) { return '<option value="' + esc(it) + '">' + esc(resName(it)) + "</option>"; }).join("");
    // необязательные настройки открыты сразу только если они уже заданы (правка)
    var openMore = !!(edit && (edit.recipient || edit.auto_repeat || (edit.plan && edit.plan.length)));
    body.innerHTML =
      '<div class="qs-p2-lbl">1 · Выбери ресурс:</div>' +
      '<div class="qs-respick" id="qs-p2-grid"></div>' +
      '<div id="qs-res-warn" class="qs-res-warn"></div>' +
      // всё необязательное — в сворачиваемый блок, чтобы не путать с обязательным выбором ресурса
      '<details class="qs-p2-more"' + (openMore ? " open" : "") + '>' +
        '<summary>⚙️ Дополнительно <span class="qs-p2-more-sub">— кому передать, повтор, план на недели (всё необязательно)</span></summary>' +
        '<div class="qs-p2-more-body">' +
          '<div class="qs-p2-lbl">Кому передать <span style="color:#8a795a;font-weight:400">(только твин или супруг)</span>:</div>' +
          '<input id="qs-rcpt" list="qs-rcpt-dl" autocomplete="off" placeholder="пусто = себе" value="' + esc(defRcpt) + '" class="qs-p2-inp">' +
          '<datalist id="qs-rcpt-dl">' + _roster.slice(0, 600).map(function (p) { return '<option value="' + esc(p.nick) + '">'; }).join("") + '</datalist>' +
          '<div id="qs-rcpt-warn" class="qs-p2-warn"></div>' +
          '<label class="qs-p2-chk"><input type="checkbox" id="qs-repeat"' + (edit && edit.auto_repeat ? " checked" : "") + '> ' +
            '🔁 Запомнить выбор — вставать за этим ресурсом автоматически каждую неделю</label>' +
          '<div class="qs-p2-lbl">📅 План на будущие недели <span style="color:#8a795a;font-weight:400">(до 8 — как дойдёт очередь, ресурс сменится по порядку)</span>:</div>' +
          '<div class="qs-p2-planrow"><select id="qs-plan-sel">' + planOpts + '</select>' +
            '<button class="sec" id="qs-plan-add" type="button">＋ в план</button></div>' +
          '<div id="qs-plan-list" class="qs-p2-plan"></div>' +
        '</div>' +
      '</details>' +
      '<div class="qs-pick2-foot"><button class="qs-join" id="qs-p2-go"></button></div>';
    // карточки-выбор
    var grid = body.querySelector("#qs-p2-grid");
    function paintCards() {
      [].forEach.call(grid.children, function (c) { c.classList.toggle("sel", c.dataset.res === sel); });
      var go = body.querySelector("#qs-p2-go");
      go.textContent = edit ? "💾 Сохранить" : (sel ? "Встать в очередь" : "Сначала выбери ресурс");
      go.disabled = !sel && !edit;
      var warn = body.querySelector("#qs-res-warn");        // предупреждение по «капризному» ресурсу
      if (warn) {
        if (RES_WARN[sel]) { warn.innerHTML = "⚠️ <b>" + esc(resName(sel)) + ".</b> " + esc(RES_WARN[sel]); warn.style.display = "block"; }
        else warn.style.display = "none";
      }
    }
    items.forEach(function (it) {
      var card = document.createElement("button");
      card.className = "qs-rescard"; card.dataset.res = it; card.type = "button";
      var rm = REWARDS_META[it] || {};
      var stack = rm.text ? '<span class="qs-rc-stack">' + esc(rm.text) + "</span>" : "";
      var total = (rm.total != null && rm.total > 0) ? '<span class="qs-rc-total">накоплено: ' + rm.total + "</span>" : "";
      card.innerHTML = '<img src="' + resImg(it) + '" alt="" loading="lazy"><span class="qs-rc-name">' + esc(resName(it)) + "</span>" + stack + total;
      card.addEventListener("click", function () { sel = it; paintCards(); });
      grid.appendChild(card);
    });
    // получатель — живая проверка твин/супруг
    var rcptEl = body.querySelector("#qs-rcpt"), warnEl = body.querySelector("#qs-rcpt-warn");
    function checkRcpt() {
      var rel = recipientRel(rcptEl.value);
      if (rel === "other") { warnEl.textContent = "⚠ этот игрок не твин и не супруг — ресурс уйдёт постороннему"; warnEl.style.display = "block"; }
      else if (rel === "spouse") { warnEl.textContent = "✓ супруг"; warnEl.style.color = "#8fc36a"; warnEl.style.display = "block"; }
      else if (rel === "twin") { warnEl.textContent = "✓ твой аккаунт/твин"; warnEl.style.color = "#8fc36a"; warnEl.style.display = "block"; }
      else { warnEl.style.display = "none"; }
      if (rel === "other") warnEl.style.color = "#e0a86a";
    }
    rcptEl.addEventListener("input", checkRcpt); checkRcpt();
    // план — чипы
    var planList = body.querySelector("#qs-plan-list");
    function renderPlan() {
      planList.innerHTML = "";
      planArr.forEach(function (it, i) {
        var chip = document.createElement("span"); chip.className = "qs-plan-chip";
        chip.innerHTML = (i + 1) + ". " + esc(resName(it));
        var x = document.createElement("button"); x.type = "button"; x.className = "sec"; x.textContent = "✕";
        x.style.cssText = "padding:0 6px;font-size:11px;margin-left:4px";
        x.addEventListener("click", function () { planArr.splice(i, 1); renderPlan(); });
        chip.appendChild(x); planList.appendChild(chip);
      });
    }
    renderPlan();
    body.querySelector("#qs-plan-add").addEventListener("click", function () {
      if (planArr.length >= 8) { return; }
      var v = body.querySelector("#qs-plan-sel").value;
      if (v) { planArr.push(v); renderPlan(); }
    });
    var m = sceneModal((isPriv ? "Сменить ресурс жетона ТОП-3 — «" : edit ? "Изменить запись — очередь «" : "Встать в очередь — «") + b.title + "»", body);
    paintCards();
    // commit
    body.querySelector("#qs-p2-go").addEventListener("click", function () {
      var resource = sel;
      if (!edit && !resource) { return; }
      var rcpt = (rcptEl.value || "").trim();
      if (rcpt && recipientRel(rcpt) === "other" &&
          !confirm("«" + rcpt + "» не твин и не супруг. Всё равно передать ресурс ему?")) return;
      if (m) m.close();
      // смена ресурса ЖЕТОННОЙ записи (отдельная, privileged=1)
      if (isPriv) {
        q("POST", "/queue/set-entry", { queue: b.q, resource: resource, privileged: true })
          .then(refresh).catch(function (e2) { alert(e2.status === 400 ? "Жетоном — только обычные ресурсы." : ("Ошибка: " + (e2.detail || e2.message))); });
        return;
      }
      // Админ без игрового аккаунта встаёт/меняет ресурс ОТ ИМЕНИ Лирия! (тест)
      if (_isAdmin && !_meAcc) {
        q("POST", "/queue/admin/join-as", { nick: ADMIN_NICK, queue: b.q, resource: resource, recipient: rcpt })
          .then(refresh).catch(function (e2) { alert("Ошибка: " + (e2.detail || e2.message)); });
        return;
      }
      var payload = { queue: b.q, resource: resource, recipient: rcpt,
                      auto_repeat: body.querySelector("#qs-repeat").checked, plan: planArr };
      var path = edit ? "/queue/set-entry" : "/queue/join";
      q("POST", path, payload).then(refresh).catch(function (e2) {
        alert(e2.status === 409 ? "Ты уже стоишь в этой очереди." :
              e2.status === 401 ? "Сессия истекла, войди заново." :
              e2.status === 404 ? "Тебя нет в этой очереди." : ("Ошибка: " + (e2.detail || e2.message)));
      });
    });
  }
  // полный список очереди (все — они же на сцене и в полосе) с модельками
  function openFullList(b, entries) {
    var body = document.createElement("div");
    body.className = "qs-fulllist";
    if (!entries.length) {
      body.innerHTML = '<div style="padding:22px;text-align:center;color:#c9b48f">Очередь пуста.</div>';
    } else entries.forEach(function (e, i) {
      var mi = modelInfo(e), waiting = false;
      var row = document.createElement("div");
      row.className = "qs-fl-row" + (waiting ? " waiting" : "");
      row.innerHTML =
        '<span class="qs-fl-num">' + (i + 1) + "</span>" +
        (mi ? '<img class="qs-fl-mdl" src="' + esc(mi.url) + '" alt="">' : '<span class="qs-fl-mdl ph">?</span>') +
        '<span class="qs-fl-nick">' + esc(e.nick) + "</span>" +
        (e.resource ? '<img class="qs-fl-res" src="' + resImg(e.resource) + '" title="' + esc(resName(e.resource)) + '" alt="">' +
          '<span class="qs-fl-rname">' + esc(resName(e.resource)) + "</span>" : '<span class="qs-fl-rname" style="opacity:.5">— ресурс не выбран</span>') +
        (e.recipient ? '<span class="qs-fl-rcpt" title="кому передать"' +
            (e.recipient_ok === false ? ' style="color:#e0a86a;border-color:rgba(224,168,106,.5);background:rgba(224,168,106,.12)"' : "") +
            '>→ ' + esc(e.recipient) + (e.recipient_ok === false ? " ⚠" : "") + "</span>" : "") +
        '<span class="qs-fl-flags">' +
          (e.auto_repeat ? '<span class="qs-fl-flag" style="background:rgba(126,196,106,.16);color:#8fc36a" title="повторяет каждую неделю">🔁</span>' : "") +
          (e.auto_plan && e.auto_plan.length ? '<span class="qs-fl-flag" style="background:rgba(224,162,74,.16);color:#e6c48f" title="план на ' + e.auto_plan.length + ' нед.">📅' + e.auto_plan.length + "</span>" : "") +
        "</span>" +
        (waiting ? '<span class="qs-fl-tag wait">ждёт</span>' : '<span class="qs-fl-tag shown">на сцене</span>');
      body.appendChild(row);
    });
    autoCropAll(body, ".qs-fl-mdl");
    sceneModal("Очередь «" + b.title + "» — всего " + entries.length + " чел.", body);
  }

  // ── сцена: рамка + фон день/ночь + будки (свечение, предметы, счётчик, кнопка) + модельки ──
  function renderStage(state) {
    var frame = document.createElement("div");
    frame.className = "qs-frame";
    var stage = document.createElement("div");
    stage.className = "qs-stage " + (isNight() ? "night" : "day") + (_isAdmin ? " admin" : "") + (_placeMode ? " place" : "");
    stage.style.setProperty("--qs-char-scale", getSize("char", 1));
    stage.style.setProperty("--qs-item-scale", getSize("item", 1));
    stage.style.setProperty("--qs-mount-scale", getSize("mount", 1));
    stage.style.setProperty("--qs-merch-scale", getSize("merch", 1));
    stage.style.inset = getSize("inset", 15) + "%";   // край рамки (сохраняется, макс ~15.5%)
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
        img.className = "qs-item"; img.alt = ""; img.decoding = "async"; img.loading = "lazy";
        img.src = "assets/queue/scene/item/" + it + ".webp";
        img.style.cssText = "left:" + pos.x.toFixed(2) + "%;top:" + pos.y.toFixed(2) +
          "%;z-index:" + zOf("item:" + it, pos.y);
        if (_placeMode) makeDraggable(img, "item:" + it);
        stage.appendChild(img);
      });
      // торговец у будки (перетаскивается; поворот/зеркало/размер — как у моделей)
      var mkey = "scene/merchant-" + b.q + ".png";
      var mset = MODEL_SETTINGS[mkey] || {};
      var mp = placedPos("merchant:" + b.q, b.merchant.x, b.merchant.y);
      var merch = document.createElement("img");
      merch.className = "qs-merchant"; merch.alt = ""; merch.decoding = "async"; merch.loading = "lazy";
      merch.dataset.mkey = mkey;
      merch.src = "assets/queue/scene/merchant-" + b.q + ".webp";
      merch.style.cssText = "left:" + mp.x.toFixed(2) + "%;top:" + mp.y.toFixed(2) +
        "%;--qs-mscale:" + ((+mset.scale) || 1) + ";z-index:" + zOf("merchant:" + b.q, mp.y) +
        ";transform:translate(-50%,-100%) " + transformStr(mset) + ";";
      if (_placeMode) makeDraggable(merch, "merchant:" + b.q);
      stage.appendChild(merch);
      // индикатор направления очереди (к будке) — под персонажами
      var pth = getPath(b.q);
      if (!_pathMode && !_placeMode) stage.appendChild(renderFlow(b, pth));
      // персонажи от будки (перёд, t=1) назад по пути. Показываем ВСЕХ — точное
      // зеркало нижней полосы: кто встал внизу, тот и на картинке, и наоборот.
      // РАВНОМЕРНО распределяем по пути: i=0 у будки (t=1), последний — в хвосте.
      // Больше людей → меньше расстояние (очередь сжимается).
      var spread = getSize("spread", 1);            // 0.4–1: какую долю пути занимает очередь
      var shown = entries.length;                   // на сцене — все, кто в очереди
      entries.forEach(function (e, i) {
        var t = shown <= 1 ? 0.92 : 1 - (i / (shown - 1)) * spread;
        stage.appendChild(renderChar(e, pathPoint(pth, t), meCanon, b.q, i));
      });
      // UI: кнопки «Список», «Встать/Выйти» и (когда стоишь) «✎ ресурс/кому».
      // Каждую можно перетащить (в режиме «Расставить предметы»); позиция сохраняется.
      var myEntry = null;
      // «в очереди» = ОБЫЧНОЕ место (не жетон): жетонная запись отдельная, не считается местом
      entries.some(function (e) { if (canon(e.main_nick) === meCanon && !e.privileged) { myEntry = e; return true; } return false; });
      var iAmIn = !!myEntry;
      // кнопка «Список»
      var lp = placedPos("btn-list:" + b.q, b.ui.x, b.ui.y - 3);
      var listBtn = document.createElement("button");
      listBtn.className = "qs-list-btn qs-btn-abs";
      listBtn.style.cssText = "left:" + lp.x.toFixed(2) + "%;top:" + lp.y.toFixed(2) + "%;--gc:" + b.accent;
      listBtn.title = "Показать всю очередь";
      listBtn.innerHTML = '<img class="qs-list-img" src="assets/queue/ui/btn-list.webp" alt=""><span class="qs-list-cap">Список</span>';
      if (_placeMode) makeDraggable(listBtn, "btn-list:" + b.q);
      else listBtn.addEventListener("click", function () { openFullList(b, entries); });
      stage.appendChild(listBtn);
      // кнопка «Встать в очередь» — есть всегда
      var jp = placedPos("btn-join:" + b.q, b.ui.x, b.ui.y + 2);
      var joinBtn = document.createElement("button");
      joinBtn.className = "qs-join qs-btn-abs" + (iAmIn ? " leave" : "");
      joinBtn.style.cssText = "left:" + jp.x.toFixed(2) + "%;top:" + jp.y.toFixed(2) + "%";
      joinBtn.textContent = iAmIn ? "Выйти" : "Встать в очередь";
      if (_placeMode) makeDraggable(joinBtn, "btn-join:" + b.q);
      else joinBtn.addEventListener("click", function () {
        if (!_meAcc) { alert("Чтобы встать в очередь, войди как игрок (по своему нику)."); return; }
        if (!iAmIn) { openResourcePicker(b); return; }       // встать → выбор ресурса
        joinBtn.disabled = true;
        q("POST", "/queue/leave", { queue: b.q }).then(refresh).catch(function (e2) {
          joinBtn.disabled = false;
          alert(e2.status === 401 ? "Сессия истекла, войди заново." : ("Ошибка: " + (e2.detail || e2.message)));
        });
      });
      stage.appendChild(joinBtn);
      // кнопка «✎ ресурс/кому» — только когда игрок стоит в этой очереди
      if (iAmIn && !_placeMode && _meAcc) {
        var ep = placedPos("btn-edit:" + b.q, b.ui.x + 9, b.ui.y + 2);
        var editBtn = document.createElement("button");
        editBtn.className = "qs-list qs-btn-abs";
        editBtn.style.cssText = "left:" + ep.x.toFixed(2) + "%;top:" + ep.y.toFixed(2) + "%;--gc:" + b.accent;
        editBtn.title = "Изменить ресурс и кому передать"; editBtn.textContent = "✎ ресурс/кому";
        editBtn.addEventListener("click", function () {
          openResourcePicker(b, { resource: myEntry.resource || "", recipient: myEntry.recipient || "",
            auto_repeat: myEntry.auto_repeat, plan: myEntry.auto_plan || [] });
        });
        stage.appendChild(editBtn);
      } else if (iAmIn && _placeMode) {
        var ep2 = placedPos("btn-edit:" + b.q, b.ui.x + 9, b.ui.y + 2);
        var editPh = document.createElement("button");
        editPh.className = "qs-list qs-btn-abs";
        editPh.style.cssText = "left:" + ep2.x.toFixed(2) + "%;top:" + ep2.y.toFixed(2) + "%;--gc:" + b.accent;
        editPh.textContent = "✎ ресурс/кому";
        makeDraggable(editPh, "btn-edit:" + b.q);
        stage.appendChild(editPh);
      }
    });
    // ездовой питомец «Огненный цилинь» — крупная награда у легендарной будки
    var mpos = placedPos("mount", 85, 70);
    var mount = document.createElement("img");
    mount.className = "qs-mount"; mount.alt = ""; mount.decoding = "async"; mount.loading = "lazy";
    mount.src = "assets/queue/scene/item/mount-cilin.webp";
    mount.style.cssText = "left:" + mpos.x.toFixed(2) + "%;top:" + mpos.y.toFixed(2) +
      "%;z-index:" + zOf("mount", mpos.y);
    if (_placeMode) makeDraggable(mount, "mount");
    stage.appendChild(mount);

    // объекты окружения (загружены админом): слой back(за всеми)/depth(по глубине)/front(перед),
    // зеркало/поворот/размер из настроек объекта; drag в режиме расстановки
    ENV.forEach(function (o) {
      var url = uploadedUrl(o.key); if (!url) return;
      var pos = placedPos("env:" + o.id, 50, 55);
      var img = document.createElement("img");
      img.className = "qs-env"; img.alt = ""; img.decoding = "async"; img.loading = "lazy";
      img.dataset.envid = o.id; img.src = url;
      var pz = (PLACEMENTS["env:" + o.id] || {}).z, zval = pz || o.z;   // правый клик (placement) важнее
      var zi = zval === "front" ? 8000 : (zval === "back" ? 1 : Math.round(pos.y * 12));
      img.style.cssText = "left:" + pos.x.toFixed(2) + "%;top:" + pos.y.toFixed(2) + "%;width:" +
        ((+o.w) || 18) + "%;z-index:" + zi + ";transform:translate(-50%,-100%) " +
        (o.flip ? "scaleX(-1) " : "") + (o.rotate ? "rotate(" + o.rotate + "deg)" : "") + ";";
      if (_placeMode) makeDraggable(img, "env:" + o.id);
      stage.appendChild(img);
    });

    // редактор формы очередей: линия пути + перетаскиваемые точки (начало ◉ … конец ⚑)
    if (_pathMode) {
      BOOTHS.forEach(function (b) {
        var pts = getPath(b.q).map(function (p) { return { x: p.x, y: p.y }; });
        var svg = svgLine(pts, b.accent);
        stage.appendChild(svg);
        pts.forEach(function (pt, i) {
          var dot = document.createElement("div");
          dot.className = "qs-pathdot";
          dot.style.cssText = "left:" + pt.x + "%;top:" + pt.y + "%;--gc:" + b.accent;
          dot.textContent = (i === 0 ? "◉" : (i === pts.length - 1 ? "⚑" : String(i + 1)));
          makePathDraggable(dot, b.q, i, pts, svg);
          stage.appendChild(dot);
        });
      });
    }

    frame.appendChild(stage);
    // центровка моделей на сцене (как в полосе): обрезаем прозрачные поля и ставим
    // симметричный отступ → модель ровно под ником/ресурсом, а не «уехала» вбок
    autoCropAll(stage, ".q-char-img");
    // рамка ПОВЕРХ сцены (передний план) — центр прозрачный
    var ovl = document.createElement("div");
    ovl.className = "qs-frame-ovl";
    frame.appendChild(ovl);
    return frame;
  }

  function admErr(e) { alert("Ошибка (нужны права админа?): " + (e.detail || e.message)); }

  // ── 3 ПОЛОСЫ полных очередей под сценой (всем): кнопка «встать» в начале,
  //    получатели равномерно растянуты, НПЦ-торговец наград в конце, прокрутка ◀▶ ──
  var MERCH_LABEL = ["обычные ресурсы", "редкие ресурсы (R)", "легендарные (S)"];

  // Заметная плашка: до воскресенья 16:00 мск (пока не собраны данные) КАЖДЫЙ может
  // в любой момент сменить ресурс, за которым стоит — жми на свою модельку или на
  // ресурс у торговца. То же для тех, кто взял ⚡ вне очереди.
  function buildChangeBanner() {
    var el = document.createElement("div");
    el.className = "qs-change-note";
    el.innerHTML =
      '<span class="qs-cn-ic">🔄</span>' +
      '<span class="qs-cn-tx"><b>Ресурс можно менять в любой момент — до воскресенья 16:00 мск</b> ' +
      "(пока не собраны данные по доблести). Нажми на <b>свою модельку</b> в очереди или на нужный " +
      "<b>ресурс у торговца</b> — и встанешь за ним. Кто взял <b>⚡ вне очереди</b> — тоже может " +
      "переиграть выбор, жетоны не сгорают.</span>";
    return el;
  }

  // Подпись над офицерскими функциями (связки/«не забрал»/история) — чтобы офицер
  // понимал: эта панель есть ТОЛЬКО у офицеров и админа, обычные игроки её не видят.
  function buildOfficerHeader() {
    var el = document.createElement("div");
    el.className = "qs-off-head";
    el.innerHTML =
      '<span class="qs-off-ic">✦</span>' +
      '<div class="qs-off-tx"><b>Офицерская панель</b>' +
      '<span class="qs-off-sub">Эти функции доступны только офицерам и админам — обычные игроки их не видят.</span></div>';
    return el;
  }

  // «Реклама» жетона ТОП-3 — над всей картинкой, для всех. Коротко: что это и как работает.
  function buildTokenAd() {
    var el = document.createElement("div");
    el.className = "qs-token-ad";
    el.innerHTML =
      '<img class="qs-ta-token" src="assets/queue/ui/token.webp" alt="Жетон ТОП-3">' +
      '<div class="qs-ta-body">' +
        '<div class="qs-ta-title">Жетон ТОП-3 <span>— награда за доблесть</span></div>' +
        '<div class="qs-ta-tx">Попади в <b>ТОП-3 недели по доблести</b> — получишь <b>жетон</b>. С ним берёшь ресурсы ' +
        'из обычной очереди <b>вне очереди</b>, сразу первым у торговца. При этом <b>твоё место в очереди не теряется</b> — ' +
        'ты продолжаешь стоять как обычно и <b>вдобавок</b> получаешь ресурсы по жетону. Копится по 1 за неделю в топ-3, не сгорает.</div>' +
      "</div>" +
      '<div class="qs-ta-badge">без очереди!</div>';
    return el;
  }

  function renderQueueStrips(state) {
    var box = document.createElement("div");
    box.className = "qs-strips";
    var meCanon = _meAcc ? canon(_meAcc.main_nick) : "";
    var adminCanon = (_isAdmin && !_meAcc) ? canon(ADMIN_NICK) : "";   // админ тестирует как Лирия!
    BOOTHS.forEach(function (b) {
      var entries = state.queues[b.q] || [];
      var myIdx = -1, iAmIn = false, myEntry = null;
      // «в очереди» = обычное место (privileged=0); жетонная запись — отдельная, не место
      entries.forEach(function (e, i) { if (meCanon && canon(e.main_nick) === meCanon && !e.privileged) { myIdx = i; iAmIn = true; myEntry = e; } });
      // для админ-теста: считаем «в очереди» наличие Лирия!
      var adminIn = adminCanon && entries.some(function (e) { return canon(e.main_nick) === adminCanon; });
      var lane = document.createElement("div");
      lane.className = "qs-lane"; lane.style.setProperty("--gc", b.accent);
      var head = document.createElement("div"); head.className = "qs-lane-head";
      head.innerHTML = '<span class="qs-lane-title">' + esc(b.title) + "</span>" +
        '<span class="qs-lane-cnt" title="' + entries.length + ' чел в очереди">' +
          '<img class="qs-lane-cnt-bg" src="assets/queue/ui/counter.webp" alt="">' +
          '<b class="qs-lane-cnt-n">' + entries.length + "</b></span>" +
        (myIdx >= 0 ? '<span class="qs-lane-you">ты #' + (myIdx + 1) + "</span>" : "");
      var sw = document.createElement("div"); sw.className = "qs-lane-sw";
      // кнопка «Встать/Выйти» в начале очереди (отдельно, не скроллится с людьми)
      var joinCell = document.createElement("button");
      var inNow = iAmIn || adminIn;
      joinCell.className = "qs-lane-join" + (inNow ? " leave" : "");
      var joinTx = inNow
        ? (adminIn && !iAmIn ? "Убрать " + esc(ADMIN_NICK) : "Выйти")
        : (adminCanon ? "Встать как " + esc(ADMIN_NICK) : "Встать в очередь");
      joinCell.innerHTML =
        '<img class="qs-lane-join-ic" src="assets/queue/ui/' + (inNow ? "join-red" : "join-green") + '.webp" alt="">' +
        '<span class="qs-lane-join-tx">' + joinTx + "</span>";
      joinCell.addEventListener("click", function () {
        // Админ без игрового аккаунта — тест от имени Лирия!
        if (_isAdmin && !_meAcc) {
          if (!adminIn) { openResourcePicker(b); return; }
          joinCell.disabled = true;
          q("POST", "/queue/admin/leave-as", { nick: ADMIN_NICK, queue: b.q }).then(refresh)
            .catch(function (e2) { joinCell.disabled = false; alert("Ошибка: " + (e2.detail || e2.message)); });
          return;
        }
        if (!_meAcc) { alert("Чтобы встать в очередь, войди как игрок (по своему нику)."); return; }
        if (!iAmIn) { openResourcePicker(b); return; }
        joinCell.disabled = true;
        q("POST", "/queue/leave", { queue: b.q }).then(refresh).catch(function (e2) {
          joinCell.disabled = false;
          alert(e2.status === 401 ? "Сессия истекла, войди заново." : ("Ошибка: " + (e2.detail || e2.message)));
        });
      });
      var lArr = document.createElement("button"); lArr.className = "qs-lane-arrow"; lArr.textContent = "◀"; lArr.title = "назад";
      var strip = document.createElement("div"); strip.className = "qs-lane-strip";
      var rArr = document.createElement("button"); rArr.className = "qs-lane-arrow"; rArr.textContent = "▶"; rArr.title = "вперёд";

      // ПОЛОСА — только люди. Торговец СПРАВА → №1 (кого обслужат первым) рисуем
      // ПОСЛЕДНИМ, чтобы он оказался справа ВПЛОТНУЮ к торговцу; новенькие (больший
      // номер) — слева, дальше всех. Поэтому идём в обратном порядке, номер = i+1.
      if (!entries.length) {
        var em = document.createElement("div"); em.className = "qs-lane-empty"; em.textContent = "очередь пуста";
        strip.appendChild(em);
      } else entries.map(function (e, i) { return { e: e, i: i }; }).reverse().forEach(function (o) {
        var e = o.e, i = o.i;
        var mi = modelInfo(e), mine = meCanon && canon(e.main_nick) === meCanon;
        var cell = document.createElement("div");
        cell.className = "qs-cell" + (mine ? " me" : "") + (e.privileged ? " priv" : "");
        cell.setAttribute("data-tip", tipHtml(e) + (mine ? '<span class="qtip-hint">нажми, чтобы сменить ресурс</span>' : ""));
        // облачко над головой — ТОЛЬКО картинка ресурса (без названия); имя и кол-во в подсказке.
        // Иконки автокропятся ниже → цилинь заполняет облачко без пустого пространства.
        var bubble = e.resource
          ? '<div class="qs-bubble' + (e.privileged ? " priv" : "") + '"><img class="qs-bubble-ic" src="' +
            resImg(e.resource) + '" alt=""></div>'
          : '<div class="qs-bubble empty"><span class="qs-bubble-q">?</span></div>';
        // применяем настройку зеркала модели (как в сцене) — иначе флипнутые (заглушка,
        // Лирия!, Стрелок…) в полосе смотрят назад
        var cflip = (mi && MODEL_SETTINGS[mi.key] && MODEL_SETTINGS[mi.key].flip) ? ' style="transform:scaleX(-1)"' : "";
        cell.innerHTML =
          (e.privileged ? '<span class="qs-cell-toplbl">⚡ ТОП-3</span>' : "") +   // метка ТОП-3 НАД облачком
          bubble +
          '<div class="qs-cell-mdl">' +
            (mi ? '<img class="qs-cell-img" src="' + esc(mi.url) + '"' + cflip + ' alt="" loading="lazy">' : '<span class="qs-cell-img ph">?</span>') +
            (e.privileged ? "" : '<span class="qs-cell-badge">' + (i + 1) + "</span>") +
          "</div>" +
          '<span class="qs-cell-nick">' + esc(e.nick) + "</span>" +
          (mine ? '<span class="qs-cell-edit">✏️ сменить</span>' : "");
        if (mine) {
          cell.classList.add("clk");
          cell.addEventListener("click", function () {
            openResourcePicker(b, { resource: e.resource || "", recipient: e.recipient || "",
              auto_repeat: e.auto_repeat, plan: e.auto_plan || [], privileged: !!e.privileged });
          });
        }
        strip.appendChild(cell);
      });

      // ОТДЕЛЬНЫЙ КВАДРАТ ТОРГОВЦА: НПЦ + иконки и названия ресурсов, что он выдаёт.
      // Возле каждого ресурса — СКОЛЬКО человек за ним стоит (0 = свободно, шанс встать).
      var merchBox = document.createElement("div");
      merchBox.className = "qs-merch-box"; merchBox.style.setProperty("--gc", b.accent);
      var resItems = BOOTH_ITEMS[b.q] || [];
      var resCount = {};
      entries.forEach(function (e) { if (e.resource) resCount[e.resource] = (resCount[e.resource] || 0) + 1; });
      var anyFree = false;
      var resChips = resItems.map(function (it) {
        var rm = REWARDS_META[it] || {};
        var st = rm.mode === "pack" ? "всё 1-му" : rm.mode === "fixed" ? ("по " + rm.unit) : ("стак " + rm.unit);
        var cnt = resCount[it] || 0; if (cnt === 0) anyFree = true;
        var cntHtml = cnt === 0
          ? '<span class="qs-mres-cnt free">🟢 свободно · 0 чел</span>'
          : '<span class="qs-mres-cnt">👥 ' + cnt + " чел</span>";
        return '<span class="qs-mres" data-res="' + esc(it) + '" title="Встать в очередь за: ' + esc(resName(it)) +
          " (сейчас стоят: " + cnt + ')">' +
          '<img src="' + resImg(it) + '" alt="">' +
          '<span class="qs-mres-nm">' + esc(resName(it)) + "</span>" +
          '<span class="qs-mres-st">' + esc(st) + "</span>" + cntHtml + "</span>";
      }).join("");
      // ВЕСЬ бокс торговца — одна кнопка: клик по НПЦ ИЛИ по строке разворачивает список
      merchBox.innerHTML =
        '<details class="qs-merch-det"><summary>' +
          '<div class="qs-merch-npc">' +
            '<img class="qs-merch-img" src="assets/queue/scene/merchant-' + b.q + '.webp" alt="">' +
            '<div class="qs-merch-title">🏪 Награды: ' + esc(MERCH_LABEL[b.q]) + "</div></div>" +
          '<div class="qs-merch-sumline">📋 что выдаёт · сколько стоят — нажми, чтобы встать (' + resItems.length + ")" +
            (anyFree ? '<span class="qs-merch-free">✦ есть свободные</span>' : "") + "</div>" +
        "</summary>" +
        '<div class="qs-merch-res">' + resChips + "</div></details>";
      // клик по ресурсу в списке торговца → встать в эту очередь за ним (или сменить, если уже стоишь)
      merchBox.addEventListener("click", function (ev) {
        var chip = ev.target.closest(".qs-mres"); if (!chip) return;
        var it = chip.getAttribute("data-res"); if (!it) return;
        if (_isAdmin && !_meAcc) { openResourcePicker(b, null, it); return; }   // админ встаёт как Лирия!
        if (!_meAcc) { alert("Чтобы встать в очередь, войди как игрок (по своему нику)."); return; }
        if (iAmIn) openResourcePicker(b, { resource: it, recipient: (myEntry && myEntry.recipient) || "",
          auto_repeat: myEntry && myEntry.auto_repeat, plan: (myEntry && myEntry.auto_plan) || [] });
        else openResourcePicker(b, null, it);
      });

      lArr.addEventListener("click", function () { strip.scrollBy({ left: -260, behavior: "smooth" }); });
      rArr.addEventListener("click", function () { strip.scrollBy({ left: 260, behavior: "smooth" }); });
      // запоминаем позицию прокрутки этой полосы, чтобы при перерисовке (удаление в ЛЮБОЙ
      // очереди пересобирает всё) она не «прыгала» вправо, а осталась на месте
      strip.addEventListener("scroll", function () { _stripScroll[b.q] = strip.scrollLeft; });
      sw.appendChild(joinCell); sw.appendChild(lArr); sw.appendChild(strip);
      sw.appendChild(rArr); sw.appendChild(merchBox);
      lane.appendChild(head); lane.appendChild(sw);
      box.appendChild(lane);
      autoCropAll(strip, ".qs-cell-img");                  // центровка моделей
      autoCropAll(strip, ".qs-bubble-ic");                 // ресурс заполняет облачко (цилинь без пустот)
      autoCropAll(merchBox, ".qs-mres img");               // иконки ресурсов заполняют бокс (цилинь крупнее)
      setTimeout(function () {
        if (_stripScroll[b.q] != null) { strip.scrollLeft = _stripScroll[b.q]; return; }  // вернуть, где было
        var c = strip.querySelector(".qs-cell.me");        // первый показ: к своей ячейке…
        if (c) strip.scrollLeft = c.offsetLeft - strip.clientWidth / 2 + c.clientWidth / 2;
        else strip.scrollLeft = strip.scrollWidth;         // …иначе к голове очереди (у торговца)
      }, 70);
    });
    return box;
  }

  // ── СУПЕРСПОСОБНОСТЬ топ-3: панель «взять ресурсы вне очереди» (жетоны) ──
  function renderSuperAbility() {
    var canUse = _meAcc && _myTokens > 0;
    if (!canUse && !_isAdmin) return null;        // держатели жетонов + админ (тест как Лирия!)
    var adminMode = !canUse && _isAdmin;          // админ тестирует от имени Лирия!
    var bar = document.createElement("div");
    bar.className = "qs-super" + (adminMode ? " preview" : "");
    bar.innerHTML =
      '<img class="qs-super-token" src="assets/queue/ui/token.webp" alt="">' +
      '<span class="qs-super-txt"><b>Суперспособность ТОП-3 — взять обычные ресурсы ВНЕ очереди</b><br>' +
      (adminMode
        ? '<span style="color:#e6c48f">🧪 админ-тест как <b>' + esc(ADMIN_NICK) +
          '</b>: у торговца встанет вторая светящаяся моделька, а обычное место в очереди (если стоял) не пропадёт. Жетоны добираются автоматически.</span>'
        : 'у тебя <b style="color:#ffd24a">' + _myTokens + '</b> жетон(ов). Место в очереди <b>не теряется</b> — берёшь ресурсы вдобавок, вне очереди') +
      "</span>";
    var btn = document.createElement("button");
    btn.className = "qs-super-btn";
    btn.textContent = adminMode ? "⚡ Взять вне очереди (как " + ADMIN_NICK + ")" : "⚡ Взять вне очереди";
    btn.addEventListener("click", function () { openPrivClaim(adminMode ? "admin" : "player"); });
    bar.appendChild(btn);
    return bar;
  }

  function openPrivClaim(mode) {
    var admin = mode === "admin";
    var preview = false;
    var items = (BOOTH_ITEMS[0] || []).filter(function (it) { return (REWARDS_META[it] || {}).mode !== "pack"; });
    var sel = "";
    var body = document.createElement("div"); body.className = "qs-pick2";
    var maxStacks = Math.max(1, admin ? 10 : _myTokens);
    body.innerHTML =
      '<div class="qs-p2-note">✨ Жетон даёт ресурсы <b>ВНЕ очереди</b> и <b>не сбивает твоё место</b>: если ты уже стоишь ' +
        'в обычной очереди — твоя моделька остаётся там и движется дальше, а рядом с торговцем встаёт <b>вторая</b>, ' +
        'светящаяся. То есть ты получишь и по очереди, и <b>вдобавок</b> по жетону.</div>' +
      '<div class="qs-p2-lbl">1 · Выбери обычный ресурс (вне очереди):</div>' +
      '<div class="qs-respick" id="qpc-grid"></div>' +
      '<div class="qs-p2-lbl">2 · Сколько пачек взять (1 пачка = 1 жетон' + (admin ? "" : ", у тебя " + _myTokens) + "):</div>" +
      '<div class="q-admin-row" style="align-items:center;gap:10px">' +
        '<input type="range" id="qpc-stacks" min="1" max="' + maxStacks + '" step="1" value="1" style="flex:1;min-width:120px">' +
        '<b id="qpc-stacks-v" style="min-width:160px;color:#ffd24a"></b></div>' +
      (admin ? '<div style="font-size:11.5px;color:#e6c48f;margin-top:6px">🧪 Админ-тест как <b>' + esc(ADMIN_NICK) +
        '</b>: у торговца встанет вторая, светящаяся моделька (обычное место, если стоял, не пропадёт). ' +
        'Жетоны при нехватке добираются автоматически.</div>' : "") +
      '<div class="qs-pick2-foot"><button class="qs-join" id="qpc-go"></button></div>';
    var grid = body.querySelector("#qpc-grid");
    function stacks() { return +body.querySelector("#qpc-stacks").value; }
    function upd() {
      var unit = (REWARDS_META[sel] || {}).unit || 0;
      body.querySelector("#qpc-stacks-v").textContent = sel ? (stacks() + " пачки = " + (stacks() * unit) + " шт") : "выбери ресурс";
      var go = body.querySelector("#qpc-go");
      go.textContent = sel ? ((admin ? "⚡ " + ADMIN_NICK + " берёт: " : "⚡ Взять: ") + resName(sel) + " ×" + (stacks() * unit)) : "Сначала выбери ресурс";
      go.disabled = !sel;
    }
    items.forEach(function (it) {
      var card = document.createElement("button"); card.className = "qs-rescard"; card.dataset.res = it; card.type = "button";
      var rm = REWARDS_META[it] || {};
      card.innerHTML = '<img src="' + resImg(it) + '" alt="" loading="lazy"><span class="qs-rc-name">' + esc(resName(it)) + "</span>" +
        (rm.text ? '<span class="qs-rc-stack">' + esc(rm.text) + "</span>" : "");
      card.addEventListener("click", function () { sel = it; [].forEach.call(grid.children, function (c) { c.classList.toggle("sel", c === card); }); upd(); });
      grid.appendChild(card);
    });
    body.querySelector("#qpc-stacks").addEventListener("input", upd);
    var m = sceneModal("⚡ Взять ресурсы вне очереди" + (admin ? " · тест как " + ADMIN_NICK : " · жетонов: " + _myTokens), body);
    upd();
    body.querySelector("#qpc-go").addEventListener("click", function () {
      if (!sel) return;
      var path = admin ? "/queue/admin/priv-claim-as" : "/queue/priv-claim";
      var payload = admin ? { nick: ADMIN_NICK, resource: sel, stacks: stacks() } : { resource: sel, stacks: stacks() };
      q("POST", path, payload).then(function (d) {
        if (!admin) _myTokens = d.tokens; if (m) m.close(); refresh();
      }).catch(function (e) {
        alert(e.status === 409 ? "Не хватает жетонов." : e.status === 400 ? "Только обычные ресурсы (не пачечные)." :
              e.status === 401 ? "Войди как игрок." : ("Ошибка: " + (e.detail || e.message)));
      });
    });
  }

  var _roster = [], _isAdmin = false, _role = "", _meAcc = null, _myTokens = 0, _lastState = { queues: [[], [], []] };
  var _stripScroll = {};   // позиция горизонтальной прокрутки каждой полосы (чтобы не прыгала при перерисовке)

  function render(state) {
    _lastState = state;
    updatePageBg();
    var host = document.getElementById("scene");
    host.innerHTML = "";
    var wrap = document.createElement("div");
    wrap.className = "qs-wrap";
    wrap.style.maxWidth = Math.round(1340 * getSize("frame", 1)) + "px";  // размер рамки (сохраняется)
    var banner = document.createElement("div");
    banner.className = "q-banner";
    banner.innerHTML = _pathMode
      ? "✏️ <b>Форма очередей.</b> Тащи точки: ◉ начало очереди, ⚑ у будки (конец), цифры — изгибы. У каждой очереди свой цвет. Сохраняется сразу."
      : _placeMode
        ? "🎯 <b>Режим расстановки.</b> Тащи мышкой предметы, торговца, питомца — позиции сразу сохраняются. " +
          "<b>Правый клик</b> по объекту — слой: на передний план → на задний → авто. Выключить — кнопкой в панели ниже."
        : "🏰 <b>Очередь за ресурсами с КХ.</b> Встань в любую из 3 очередей — можно во все сразу. " +
          "В одну очередь дважды нельзя: снова встанешь, когда дойдёт очередь и заберёшь свой ресурс.";
    wrap.appendChild(banner);
    if (!_pathMode && !_placeMode) wrap.appendChild(buildTokenAd());  // «реклама» жетона ТОП-3 (всем)
    var sup = renderSuperAbility(); if (sup) wrap.appendChild(sup);   // суперспособность топ-3
    wrap.appendChild(renderStage(state));
    if (!_pathMode && !_placeMode) wrap.appendChild(buildChangeBanner());   // «можно менять ресурс до вс 16:00»
    wrap.appendChild(renderQueueStrips(state));   // 3 полосы полных очередей (всем)
    if (_isAdmin) wrap.appendChild(adminPanel(state));
    else if (_role === "officer") {          // офицеру — связки + отметка «не забрал»
      wrap.appendChild(buildOfficerHeader());   // подпись «Офицерская панель — только у офицеров»
      wrap.appendChild(buildSpousePanel(true));
      wrap.appendChild(buildDuePanel(true));
      wrap.appendChild(buildHistoryPanel(true));
    }
    host.appendChild(wrap);
    updatePageBg();   // ещё раз — теперь рамка в DOM, выравниваем фон-мир по её центру
  }

  // размытый фон страницы (из сцены день/ночь) — заполняет коричневые края
  // полный мир (world-day/night) как фон страницы: центр карты совмещаем с рамкой сцены,
  // а края (остальной мир) вылезают вокруг и размываются
  function updatePageBg() {
    var pbg = document.getElementById("qs-page-bg");
    if (!pbg) {
      pbg = document.createElement("div");
      pbg.id = "qs-page-bg";
      document.body.insertBefore(pbg, document.body.firstChild);
    }
    pbg.style.backgroundImage = "url('assets/queue/scene/world-" + (isNight() ? "night" : "day") + ".webp')";
    pbg.style.backgroundRepeat = "no-repeat";
    if (!updatePageBg._bound) {          // пересчёт позиции при скролле/ресайзе — фон едет вместе с рамкой
      updatePageBg._bound = true;
      var raf = 0;
      var recompute = function () { if (raf) return; raf = requestAnimationFrame(function () { raf = 0; updatePageBg(); }); };
      window.addEventListener("resize", recompute, { passive: true });
      window.addEventListener("scroll", recompute, { passive: true });
    }
    var stage = document.querySelector(".qs-stage");
    if (!stage) return;                       // логин-страница: фон как есть (cover из CSS)
    var r = stage.getBoundingClientRect();
    if (!r.width) return;
    // «наша сцена» = центральная часть полного мира: доля ширины SW, центр (CX,CY)
    var SW = 0.55, CX = 0.46, CY = 0.55, AR = 1.792;
    var bw = r.width / SW, bh = bw / AR;
    var scx = r.left + r.width / 2, scy = r.top + r.height / 2;
    pbg.style.inset = "auto";
    pbg.style.width = bw + "px";
    pbg.style.height = bh + "px";
    pbg.style.left = (scx - CX * bw) + "px";
    pbg.style.top = (scy - CY * bh) + "px";
    pbg.style.backgroundSize = "100% 100%";
  }

  // ── админ-панель ──
  function adminPanel(state) {
    var box = document.createElement("div");
    box.className = "q-admin";
    var _open = CONFIG["queue_open"] === "1";
    box.innerHTML =
      "<h3>⚙️ Управление разделом «Очередь за ресурсами с КХ» (админ)</h3>" +
      '<div class="q-adm-status" id="qa-status"></div>' +

      // ── 🎁 РАСПРЕДЕЛЕНИЕ (главное) — панели догружаются ниже ──
      '<details class="q-sec" open><summary>🎁 Распределение ресурсов' +
        '<span class="q-sec-hint">этапы КХ · проводники · отчёт · финализация · кто не забрал</span></summary>' +
        '<div class="q-sec-body" id="qsec-dist"></div></details>' +

      // ── 🧪 ТЕСТИРОВАНИЕ ──
      '<details class="q-sec"><summary>🧪 Тестирование очереди' +
        '<span class="q-sec-hint">набить людьми · встать и «Взять вне очереди» как ' + esc(ADMIN_NICK) + '</span></summary>' +
        '<div class="q-sec-body">' +
          '<div style="font-size:12px;color:#c9b48f;line-height:1.5;margin:0 0 10px">Заполни очереди случайными людьми из ростера, ' +
            'чтобы посмотреть, как всё работает. Ты можешь <b>встать в очередь</b> и нажать <b>⚡ Взять вне очереди</b> ' +
            'кнопками прямо в сцене — это сработает от имени <b>' + esc(ADMIN_NICK) + '</b> (твой аккаунт), ' +
            'модель встанет первой и засветится.</div>' +
          '<div class="q-admin-row" style="align-items:center">' +
            '<span style="font-size:12.5px;color:#caa66a">Людей в каждую очередь:</span>' +
            '<input type="number" id="qa-test-n" value="6" min="1" max="30" style="width:70px">' +
            '<button id="qa-test-fill">🧪 Заполнить тестовыми (случайно)</button>' +
            '<button class="sec" id="qa-test-clear">🧹 Убрать тестовых</button>' +
            '<span id="qa-test-msg" style="font-size:11.5px;color:#8fc36a"></span>' +
          "</div>" +
          // массовое добавление с ВЫБОРОМ ресурсов
          '<div style="margin-top:12px;padding-top:10px;border-top:1px dashed rgba(224,162,74,.25)">' +
            '<div style="font-size:12.5px;color:#f0c878;font-weight:700;margin:0 0 7px">➕ Добавить в очередь с выбором ресурсов</div>' +
            '<div class="q-admin-row" style="align-items:center">' +
              '<span style="font-size:12.5px;color:#caa66a">Очередь:</span>' +
              '<select id="qa-ma-queue"><option value="0">Обычные</option><option value="1">Редкие (R)</option><option value="2">Легендарные (S)</option></select>' +
            "</div>" +
            '<div id="qa-ma-rows"></div>' +
            '<div class="q-admin-row" style="align-items:center;margin-top:2px">' +
              '<button class="sec" id="qa-ma-more" style="font-size:12px">＋ ещё ресурс</button>' +
              '<span style="font-size:12.5px;color:#caa66a;margin-left:8px">+ случайных:</span>' +
              '<input type="number" id="qa-ma-rand" value="0" min="0" max="300" style="width:66px">' +
            "</div>" +
            '<div class="q-admin-row" style="align-items:center;margin-top:2px">' +
              '<button id="qa-ma-add">➕ Добавить в очередь</button>' +
              '<span id="qa-ma-msg" style="font-size:11.5px;color:#8fc36a"></span>' +
            "</div>" +
          "</div>" +
        "</div></details>" +

      // ── 💞 ОФИЦЕРСКОЕ ──
      '<details class="q-sec"><summary>💞 Связки супругов' +
        '<span class="q-sec-hint">кому передавать рес · доступно и офицерам</span></summary>' +
        '<div class="q-sec-body" id="qsec-officer"></div></details>' +

      // ── 📜 ИСТОРИЯ И ЛОГИ (офицерам тоже) ──
      '<details class="q-sec"><summary>📜 История и активность' +
        '<span class="q-sec-hint">недельные отчёты · кто вставал/выходил/за чем · доступно и офицерам</span></summary>' +
        '<div class="q-sec-body" id="qsec-hist"></div></details>' +

      // ── 🔒 ДОСТУП И ОЧЕРЕДЬ ──
      '<details class="q-sec"><summary>🔒 Доступ и управление очередью' +
        '<span class="q-sec-hint">открыть/закрыть · добавить · очистить · лимиты</span></summary>' +
        '<div class="q-sec-body">' +
          '<div class="q-admin-row" style="align-items:center">' +
            '<span style="font-size:12.5px;color:#caa66a">Доступ в раздел:</span>' +
            '<button class="' + (_open ? "danger" : "sec") + '" id="qa-toggle-open" style="font-weight:700">' +
              (_open ? "🔓 ОТКРЫТ — закрыть (в разработку)" : "🔒 ЗАКРЫТ — открыть для всех") + "</button>" +
            '<span style="font-size:11px;color:#8a795a">' +
              (_open ? "офицеры и игроки могут входить" : "остальные видят «в разработке», входишь только ты") + "</span>" +
          "</div>" +
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
          "</div>" +
          '<div class="q-admin-row" style="gap:20px;align-items:flex-end">' +
            '<label style="display:flex;flex-direction:column;gap:2px;font-size:11px;color:#caa66a">' +
              'Показывать в очереди (лимит): <b id="qa-limit-v">' + Math.round(getSize("limit", 6)) + '</b>' +
              '<input type="range" id="qa-limit" min="1" max="20" step="1" value="' + Math.round(getSize("limit", 6)) + '" style="width:240px"></label>' +
            '<label style="display:flex;flex-direction:column;gap:2px;font-size:11px;color:#caa66a">' +
              'Растянутость очереди: <b id="qa-spread-v">' + getSize("spread", 1).toFixed(2) + '</b>' +
              '<input type="range" id="qa-spread" min="0.4" max="1" step="0.05" value="' + getSize("spread", 1) + '" style="width:240px"></label>' +
          "</div>" +
        "</div></details>" +

      // ── 🎨 СЦЕНА: фон, размеры, расстановка ──
      '<details class="q-sec"><summary>🎨 Сцена: фон, размеры, расстановка' +
        '<span class="q-sec-hint">день/ночь · размеры моделей · перетаскивание предметов</span></summary>' +
        '<div class="q-sec-body">' +
          '<div class="q-admin-row">' +
            '<button class="sec" id="qa-place">🎯 Расставить предметы: ' + (_placeMode ? "ВКЛ" : "выкл") + "</button>" +
            '<button class="sec" id="qa-path">✏️ Форма очередей: ' + (_pathMode ? "ВКЛ" : "выкл") + "</button>" +
          "</div>" +
          '<div class="q-admin-row" style="align-items:center;flex-wrap:wrap">' +
            '<span style="font-size:12.5px;color:#caa66a">Фон:</span>' +
            '<button class="sec" data-time="auto">🕒 Авто</button>' +
            '<button class="sec" data-time="day">☀️ День</button>' +
            '<button class="sec" data-time="night">🌙 Ночь</button>' +
            '<label style="font-size:11px;color:#caa66a;display:inline-flex;align-items:center;gap:4px;margin-left:8px">☀️ день с ' +
              '<input type="time" id="qa-dayfrom" value="' + (CONFIG["dayFrom"] || "07:00") + '"></label>' +
            '<label style="font-size:11px;color:#caa66a;display:inline-flex;align-items:center;gap:4px">🌙 ночь с ' +
              '<input type="time" id="qa-nightfrom" value="' + (CONFIG["nightFrom"] || "20:00") + '"></label>' +
          "</div>" +
          '<div class="q-admin-row" style="gap:16px;align-items:flex-end">' +
            '<span style="font-size:12px;color:#caa66a">Размеры:</span>' +
            sizeSlider("frame", "Рамка/сцена", 0.5, 4) + sizeSlider("char", "Модели") +
            sizeSlider("item", "Предметы") + sizeSlider("mount", "Питомец") + sizeSlider("merch", "Торговцы") +
          "</div>" +
          '<div class="q-admin-row" style="gap:12px;align-items:flex-end">' +
            '<label style="display:flex;flex-direction:column;gap:2px;font-size:11px;color:#caa66a">' +
              'Сколько видно картины (край рамки): <b id="qa-inset-v">' + getSize("inset", 15).toFixed(1) + '%</b>' +
              '<input type="range" id="qa-inset" min="4" max="50" step="0.5" value="' + getSize("inset", 15) + '" style="width:300px"></label>' +
            '<span style="font-size:11px;color:#8a795a">← фон крупнее · правее меньше →</span>' +
          "</div>" +
        "</div></details>" +

      // ── 🧍 МОДЕЛИ ИГРОКОВ: пол + размеры/загрузка (панели догружаются) ──
      '<details class="q-sec"><summary>🧍 Модели игроков: пол, размеры, загрузка' +
        '<span class="q-sec-hint">пол для модели · размер/поворот · загрузка PNG</span></summary>' +
        '<div class="q-sec-body" id="qsec-models">' +
          '<div class="q-admin-row">' +
            '<span style="font-size:12.5px;color:#caa66a">Пол игрока (для модели):</span>' +
            '<input id="qa-gnick" list="qa-roster-dl" placeholder="ник игрока…" autocomplete="off" style="min-width:150px">' +
            '<datalist id="qa-roster-dl"></datalist>' +
            '<button class="sec" id="qa-gm">♂ Мужской</button>' +
            '<button class="sec" id="qa-gf">♀ Женский</button>' +
            '<button class="sec" id="qa-gr">Сброс (по имени)</button>' +
          "</div>" +
          '<div class="q-admin-row" style="flex-direction:column;align-items:stretch;gap:4px">' +
            '<div style="font-size:12px;color:#caa66a">❓ Кому уточнить пол ' +
              '<span style="color:#8a795a;font-size:11px">(классы воин/жрец — модель зависит от пола; «авто» = угадано по имени)</span></div>' +
            '<div id="qa-gender-list" style="display:flex;flex-direction:column;gap:4px;max-height:230px;overflow:auto"></div>' +
          "</div>" +
        "</div></details>" +

      // ── 🌳 ОКРУЖЕНИЕ (панель догружается) ──
      '<details class="q-sec"><summary>🌳 Объекты окружения' +
        '<span class="q-sec-hint">деревья, камни, костры — загрузка и расстановка</span></summary>' +
        '<div class="q-sec-body" id="qsec-env"></div></details>' +

      // ── 📋 ЛОГИ ──
      '<details class="q-sec"><summary>📋 Логи и входы' +
        '<span class="q-sec-hint">кто что делал в разделе</span></summary>' +
        '<div class="q-sec-body">' +
          '<div class="q-admin-row"><button class="sec" id="qa-log-btn">Показать лог и входы</button></div>' +
          '<div class="q-log" id="qa-log" hidden></div>' +
        "</div></details>";

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
            "</td><td>" + esc(r.actor || "—") + "</td><td>" + esc(r.nick || "") + "</td><td>" + (r.queue == null ? "" : (+r.queue + 1)) +
            "</td><td>" + esc(r.ip || "") + "</td><td>" + esc(r.detail || "") + "</td></tr>";
        }).join("");
        var accs = (d.accounts || []).map(function (a) {
          return "<tr><td>" + esc(a.main_nick) + "</td><td>" + esc(a.email || "—") + "</td><td>" +
            esc((a.created_at || "").slice(0, 10)) + "</td><td>" + esc((a.last_login_at || "").replace("T", " ").slice(0, 16)) + "</td></tr>";
        }).join("");
        logEl.innerHTML =
          '<table><thead><tr><th>время</th><th>событие</th><th>кто (офицер/админ)</th><th>ник</th><th>оч.</th><th>IP</th><th>детали</th></tr></thead><tbody>' +
          (rows || '<tr><td colspan="7">пусто</td></tr>') + "</tbody></table>" +
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
    // список тех, кому нужно уточнить пол (классы с двумя моделями: воин/жрец)
    function quickGender(nk, g) {
      q("POST", "/queue/admin/gender", { nick: nk, gender: g })
        .then(function () { st("✓ " + nk + " → " + (g === "m" ? "муж" : g === "f" ? "жен" : "авто"), true); refresh(); })
        .catch(function (e) { st(e.status === 404 ? "Ник не найден." : ("Ошибка: " + (e.detail || e.message))); });
    }
    (function buildGenderList() {
      var host = box.querySelector("#qa-gender-list"); if (!host) return;
      var seen = {}, rows = [];
      ((_lastState && _lastState.queues) || []).forEach(function (q2) {
        (q2 || []).forEach(function (e) {
          var set = CLASS_MODEL[(e.cls || "").toLowerCase()];
          if (!(set && set.m && set.f)) return;             // нужен пол только где есть И муж И жен модель
          var key = canon(e.main_nick || e.nick);
          if (seen[key]) return; seen[key] = 1; rows.push(e);
        });
      });
      if (!rows.length) {
        host.innerHTML = '<span style="font-size:11px;color:#8a795a">Некому — в очередях нет классов воин/жрец.</span>'; return;
      }
      rows.sort(function (a, b) { return (a.gender_by === "manual" ? 1 : 0) - (b.gender_by === "manual" ? 1 : 0); });
      rows.forEach(function (e) {
        var auto = e.gender_by !== "manual", g = e.gender === "f" ? "Ж" : "М", nk = e.main_nick || e.nick;
        var row = document.createElement("div");
        row.style.cssText = "display:flex;align-items:center;gap:8px;font-size:12px;color:#f6ead2;padding:3px 6px;border:1px solid rgba(224,162,74,.18);border-radius:8px";
        row.innerHTML = '<b style="min-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(nk) + "</b>" +
          '<span style="color:#c9b48f;min-width:64px">' + esc(e.cls || "") + "</span>" +
          '<span style="min-width:92px;color:' + (auto ? "#e6c48f" : "#a9e08f") + '">' + (auto ? "авто: " : "вручную: ") + g + "</span>";
        ["♂ М m", "♀ Ж f", "авто "].forEach(function (spec) {
          var parts = spec.split(" "), b = document.createElement("button");
          b.className = "sec"; b.textContent = parts[0] + (parts[1] || ""); b.style.padding = "3px 9px";
          var gv = parts[2] || "";
          b.addEventListener("click", function () { quickGender(nk, gv); });
          row.appendChild(b);
        });
        host.appendChild(row);
      });
    })();
    function sizeSlider(key, label, mn, mx) {
      var v = getSize(key, 1).toFixed(2);
      return '<label style="display:flex;flex-direction:column;gap:2px;font-size:11px;color:#caa66a">' +
        label + ': <b id="qa-sz-' + key + '-v">' + v + '×</b>' +
        '<input type="range" id="qa-sz-' + key + '" min="' + (mn || 0.4) + '" max="' + (mx || 2.2) +
        '" step="0.05" value="' + v + '" style="width:118px"></label>';
    }
    box.querySelector("#qa-toggle-open").addEventListener("click", function () {
      saveCfg("queue_open", CONFIG["queue_open"] === "1" ? "0" : "1");
      render(_lastState);
    });
    // ── тестирование: заполнить/убрать ──
    var tMsg = box.querySelector("#qa-test-msg");
    box.querySelector("#qa-test-fill").addEventListener("click", function () {
      var n = Math.max(1, Math.min(30, +box.querySelector("#qa-test-n").value || 6));
      tMsg.textContent = "…"; tMsg.style.color = "#8a795a";
      q("POST", "/queue/admin/test-fill", { n: n }).then(function (d) {
        tMsg.style.color = "#8fc36a"; tMsg.textContent = "добавлено: " + (d.added || 0); refresh();
      }).catch(function (e) { tMsg.style.color = "#ff8a7a"; tMsg.textContent = "ошибка: " + (e.detail || e.message); });
    });
    box.querySelector("#qa-test-clear").addEventListener("click", function () {
      tMsg.textContent = "…"; tMsg.style.color = "#8a795a";
      q("POST", "/queue/admin/test-clear", {}).then(function (d) {
        tMsg.style.color = "#8fc36a"; tMsg.textContent = "убрано: " + (d.removed || 0); refresh();
      }).catch(function (e) { tMsg.style.color = "#ff8a7a"; tMsg.textContent = "ошибка: " + (e.detail || e.message); });
    });
    // ── массовое добавление с выбором ресурсов ──
    (function () {
      var qSel = box.querySelector("#qa-ma-queue"), rows = box.querySelector("#qa-ma-rows"), mMsg = box.querySelector("#qa-ma-msg");
      if (!qSel) return;
      function resOpts(qn) {
        return (BOOTH_ITEMS[qn] || []).map(function (it) {
          return '<option value="' + esc(it) + '">' + esc(resName(it)) + "</option>"; }).join("");
      }
      function addRow() {
        var qn = +qSel.value;
        var row = document.createElement("div");
        row.className = "q-admin-row qa-ma-row"; row.style.cssText = "align-items:center;margin:0 0 5px";
        row.innerHTML = '<select class="qa-ma-res">' + resOpts(qn) + "</select>" +
          '<input type="number" class="qa-ma-cnt" value="10" min="0" max="300" style="width:66px">' +
          '<span style="font-size:12px;color:#8a795a">чел</span>' +
          '<button class="sec qa-ma-del" style="padding:4px 8px;font-size:12px">✕</button>';
        row.querySelector(".qa-ma-del").addEventListener("click", function () { row.remove(); });
        rows.appendChild(row);
      }
      function rebuildOpts() {   // при смене очереди — обновить варианты во всех строках
        var qn = +qSel.value;
        [].forEach.call(rows.querySelectorAll(".qa-ma-res"), function (s) { s.innerHTML = resOpts(qn); });
      }
      qSel.addEventListener("change", rebuildOpts);
      box.querySelector("#qa-ma-more").addEventListener("click", addRow);
      addRow();   // одна строка по умолчанию
      box.querySelector("#qa-ma-add").addEventListener("click", function () {
        var qn = +qSel.value;
        var items = [].map.call(rows.querySelectorAll(".qa-ma-row"), function (r) {
          return { resource: r.querySelector(".qa-ma-res").value, count: Math.max(0, +r.querySelector(".qa-ma-cnt").value || 0) };
        }).filter(function (it) { return it.count > 0; });
        var rand = Math.max(0, +box.querySelector("#qa-ma-rand").value || 0);
        if (!items.length && !rand) { mMsg.style.color = "#e0a86a"; mMsg.textContent = "укажи количество"; return; }
        mMsg.textContent = "…"; mMsg.style.color = "#8a795a";
        q("POST", "/queue/admin/test-add", { queue: qn, items: items, random_count: rand }).then(function (d) {
          mMsg.style.color = "#8fc36a";
          mMsg.textContent = "добавлено: " + (d.added || 0) + (d.pool_left <= 0 ? " (ростер кончился)" : "");
          refresh();
        }).catch(function (e) { mMsg.style.color = "#ff8a7a"; mMsg.textContent = "ошибка: " + (e.detail || e.message); });
      });
    })();
    box.querySelector("#qa-place").addEventListener("click", function () {
      _placeMode = !_placeMode; if (_placeMode) _pathMode = false; render(_lastState);
    });
    box.querySelector("#qa-path").addEventListener("click", function () {
      _pathMode = !_pathMode; if (_pathMode) _placeMode = false; render(_lastState);
    });
    // переключатель фона день/ночь/авто
    var curTime = CONFIG["forceTime"] || "auto";
    [].forEach.call(box.querySelectorAll("[data-time]"), function (btn) {
      if (btn.dataset.time === curTime) { btn.style.background = "rgba(224,162,74,.4)"; btn.style.color = "#fff"; }
      btn.addEventListener("click", function () { saveCfg("forceTime", btn.dataset.time); render(_lastState); });
    });
    var dfEl = box.querySelector("#qa-dayfrom"), nfEl = box.querySelector("#qa-nightfrom");
    if (dfEl) dfEl.addEventListener("change", function () { saveCfg("dayFrom", dfEl.value || "07:00"); render(_lastState); });
    if (nfEl) nfEl.addEventListener("change", function () { saveCfg("nightFrom", nfEl.value || "20:00"); render(_lastState); });
    ["frame", "char", "item", "mount", "merch"].forEach(function (key) {
      var el = box.querySelector("#qa-sz-" + key), vl = box.querySelector("#qa-sz-" + key + "-v"), t;
      el.addEventListener("input", function () {
        var v = +el.value; vl.textContent = v.toFixed(2) + "×";
        if (key === "frame") { var w = document.querySelector(".qs-wrap"); if (w) w.style.maxWidth = Math.round(1340 * v) + "px"; }
        else { var s = document.querySelector(".qs-stage"); if (s) s.style.setProperty("--qs-" + key + "-scale", v); }
        clearTimeout(t); t = setTimeout(function () { saveCfg("size:" + key, v); }, 300);
      });
    });
    // ползунок «сколько видно картины» — двигает край рамки (inset сцены), сохраняется
    var insEl = box.querySelector("#qa-inset"), insV = box.querySelector("#qa-inset-v"), insT;
    if (insEl) insEl.addEventListener("input", function () {
      var v = +insEl.value; insV.textContent = v.toFixed(1) + "%";
      var s = document.querySelector(".qs-stage"); if (s) s.style.inset = v + "%";
      clearTimeout(insT); insT = setTimeout(function () { saveCfg("size:inset", v); }, 300);
    });
    // ползунок интервала между людьми — требует пересборки очереди, поэтому по отпусканию
    var spEl = box.querySelector("#qa-spread"), spV = box.querySelector("#qa-spread-v");
    if (spEl) {
      spEl.addEventListener("input", function () { spV.textContent = (+spEl.value).toFixed(2); });
      spEl.addEventListener("change", function () { saveCfg("size:spread", +spEl.value); render(_lastState); });
    }
    var lEl = box.querySelector("#qa-limit"), lV = box.querySelector("#qa-limit-v");
    if (lEl) {
      lEl.addEventListener("input", function () { lV.textContent = lEl.value; });
      lEl.addEventListener("change", function () { saveCfg("size:limit", +lEl.value); render(_lastState); });
    }
    // панели — каждая в свою секцию (best practice: по смыслу)
    var secDist = box.querySelector("#qsec-dist");
    secDist.appendChild(buildDistPanel());
    secDist.appendChild(buildDuePanel(false));
    box.querySelector("#qsec-officer").appendChild(buildSpousePanel(false));
    box.querySelector("#qsec-hist").appendChild(buildHistoryPanel(false));
    var secModels = box.querySelector("#qsec-models");
    secModels.appendChild(buildModelSizePanel());
    secModels.appendChild(buildUploadPanel());
    box.querySelector("#qsec-env").appendChild(buildEnvPanel());
    return box;
  }

  // (поворот/зеркало моделей перенесены ВНИЗ в панель размеров — buildModelSizePanel;
  //  отдельная кнопка «⚙️ Настройки моделей» убрана)

  // ── панель размеров КАЖДОЙ модели с визуальным сравнением (общая базовая линия) ──
  // пол(а) для класса: заблокированные — один, остальные — муж+жен
  function classGenders(cls) {
    var c = (cls || "").toLowerCase();
    if (FEMALE_ONLY.indexOf(c) >= 0) return ["f"];
    if (MALE_ONLY.indexOf(c) >= 0) return ["m"];
    return ["m", "f"];
  }
  function fileToDataURL(file, cb, errcb) {
    if (!file) { errcb("Файл не выбран."); return; }
    if (file.size > 5 * 1024 * 1024) { errcb("Файл слишком большой (макс 5 МБ)."); return; }
    var r = new FileReader();
    r.onload = function () { cb(r.result); };
    r.onerror = function () { errcb("Не удалось прочитать файл."); };
    r.readAsDataURL(file);
  }
  // оценка оптимальности картинки: вес + размеры, совет по оптимизации
  function assessImage(file, cb) {
    if (!file) { cb("файл не выбран", false); return; }
    var kb = file.size / 1024, img = new Image(), url = URL.createObjectURL(file);
    img.onload = function () {
      var w = img.naturalWidth, h = img.naturalHeight, ok = true, msg;
      if (kb > 350 || w > 1800 || h > 1800) {
        ok = false; msg = "⚠ тяжеловата (" + Math.round(kb) + " КБ, " + w + "×" + h +
          ") — оптимизируй: ужми до ~1000 px по большей стороне, сохрани WebP/PNG";
      } else if (kb > 180 || Math.max(w, h) > 1300) {
        msg = "◐ нормально, но можно легче (" + Math.round(kb) + " КБ, " + w + "×" + h + ")";
      } else {
        msg = "✓ оптимально (" + Math.round(kb) + " КБ, " + w + "×" + h + ")";
      }
      cb(msg, ok); URL.revokeObjectURL(url);
    };
    img.onerror = function () { cb("не удалось прочитать картинку", false); URL.revokeObjectURL(url); };
    img.src = url;
  }
  // ── админ: загрузка моделей (классовых с делением муж/жен + персональных) ──
  function buildUploadPanel() {
    var wrap = document.createElement("div");
    wrap.className = "q-admin-row";
    wrap.style.cssText = "flex-direction:column;align-items:stretch;gap:8px";
    var clsSet = {};
    ["Воин", "Жрец", "Маг", "Друид", "Стрелок", "Оборотень", "Странник"].forEach(function (c) { clsSet[c] = 1; });
    (_roster || []).forEach(function (p) { if (p.cls) clsSet[p.cls] = 1; });
    var clsOpts = Object.keys(clsSet).sort().map(function (cls) {
      return classGenders(cls).map(function (g) {
        var key = "class-" + cls + "-" + g;
        return '<option value="' + esc(key) + '">' + esc(cls) + " (" + (g === "m" ? "муж" : "жен") + ")" +
          (UPLOADED[key] ? " ✓" : "") + "</option>";
      }).join("");
    }).join("");
    wrap.innerHTML =
      '<div style="font-size:12px;color:#caa66a">🖼️ Загрузка моделей (PNG с вырезанным фоном) ' +
        '<span style="color:#8a795a;font-size:11px">— класс делится на муж/жен; ✓ = уже загружена; ' +
        'персональная идёт человеку И его твинам</span></div>' +
      '<div class="q-admin-row" style="gap:8px;align-items:center;flex-wrap:wrap">' +
        '<b style="font-size:11px;color:#caa66a">Класс:</b>' +
        '<select id="qa-up-class" style="min-width:180px">' + clsOpts + "</select>" +
        '<input type="file" id="qa-up-class-file" accept="image/png,image/webp,image/jpeg">' +
        '<button class="sec" id="qa-up-class-btn">Загрузить классу</button>' +
        '<button class="sec" id="qa-up-class-del" title="Удалить загруженную">✕</button>' +
      "</div>" +
      '<div class="q-admin-row" style="gap:8px;align-items:center;flex-wrap:wrap">' +
        '<b style="font-size:11px;color:#caa66a">Персональная:</b>' +
        '<input id="qa-up-nick" list="qa-roster-dl" placeholder="ник игрока…" style="min-width:150px" autocomplete="off">' +
        '<input type="file" id="qa-up-nick-file" accept="image/png,image/webp,image/jpeg">' +
        '<button class="sec" id="qa-up-nick-btn">Загрузить игроку</button>' +
        '<button class="sec" id="qa-up-nick-del" title="Удалить загруженную">✕</button>' +
      "</div>" +
      '<div id="qa-up-status" style="min-height:16px;font-size:11.5px;color:#e0a86a"></div>';
    var st = wrap.querySelector("#qa-up-status");
    function status(m, ok) { st.textContent = m || ""; st.style.color = ok ? "#9fe0a0" : "#e0a86a"; }
    function reloadUploaded() {
      q("GET", "/queue/uploaded-models").then(function (d) { UPLOADED = d.keys || {}; refresh(); }).catch(refresh);
    }
    function doUpload(key, file, label) {
      if (!key) { status("Не выбрана цель."); return; }
      fileToDataURL(file, function (dataUrl) {
        status("Загрузка…");
        q("POST", "/queue/admin/model-upload", { key: key, data: dataUrl })
          .then(function () { status("✓ " + label + " загружена!", true); reloadUploaded(); })
          .catch(function (e) { status("Ошибка: " + (e.detail || e.message)); });
      }, status);
    }
    function doDelete(key, label) {
      if (!key || !UPLOADED[key]) { status("Для этой цели загруженной модели нет."); return; }
      q("POST", "/queue/admin/model-delete", { key: key })
        .then(function () { status("Удалена: " + label, true); reloadUploaded(); })
        .catch(function (e) { status("Ошибка: " + (e.detail || e.message)); });
    }
    wrap.querySelector("#qa-up-class-btn").addEventListener("click", function () {
      var sel = wrap.querySelector("#qa-up-class");
      doUpload(sel.value, wrap.querySelector("#qa-up-class-file").files[0], "Модель класса");
    });
    wrap.querySelector("#qa-up-class-del").addEventListener("click", function () {
      var sel = wrap.querySelector("#qa-up-class");
      doDelete(sel.value, sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : "");
    });
    wrap.querySelector("#qa-up-nick-btn").addEventListener("click", function () {
      var nk = wrap.querySelector("#qa-up-nick").value.trim();
      if (!nk) { status("Укажи ник игрока."); return; }
      doUpload("person-" + canon(nk), wrap.querySelector("#qa-up-nick-file").files[0], "Персональная модель");
    });
    wrap.querySelector("#qa-up-nick-del").addEventListener("click", function () {
      var nk = wrap.querySelector("#qa-up-nick").value.trim();
      if (!nk) { status("Укажи ник игрока."); return; }
      doDelete("person-" + canon(nk), nk);
    });
    // оценка оптимальности при выборе файла (вес/размеры + совет)
    ["#qa-up-class-file", "#qa-up-nick-file"].forEach(function (sel) {
      wrap.querySelector(sel).addEventListener("change", function () {
        var f = this.files[0];
        if (!f) return;
        assessImage(f, function (m, ok) { status("Оценка: " + m, ok); });
      });
    });
    return wrap;
  }

  function envSlug(name) {
    return (name || "").trim().toLowerCase().replace(/\s+/g, "-").replace(/[^\p{L}\p{N}\-]+/gu, "").slice(0, 40);
  }
  // ── админ: объекты окружения (загрузка, добавление в сцену, поворот/зеркало/слой/размер) ──
  function buildEnvPanel() {
    var wrap = document.createElement("div");
    wrap.className = "q-admin-row";
    wrap.style.cssText = "flex-direction:column;align-items:stretch;gap:8px";
    var envKeys = Object.keys(UPLOADED).filter(function (k) { return k.indexOf("env-") === 0; }).sort();
    var opts = envKeys.map(function (k) {
      return '<option value="' + esc(k) + '">' + esc(k.slice(4)) + "</option>";
    }).join("") || '<option value="">— сначала загрузи картинку —</option>';
    wrap.innerHTML =
      '<div style="font-size:12px;color:#caa66a">🌳 Объекты окружения ' +
        '<span style="color:#8a795a;font-size:11px">— деревья, камни, костры и пр. PNG с вырезанным фоном. ' +
        'Загрузи → добавь в сцену → тащи (в режиме «Расставить предметы»), крути, зеркаль, задавай слой</span></div>' +
      '<div class="q-admin-row" style="gap:8px;align-items:center;flex-wrap:wrap">' +
        '<b style="font-size:11px;color:#caa66a">Новый:</b>' +
        '<input id="qa-env-name" placeholder="название (дерево, камень…)" style="min-width:150px" autocomplete="off">' +
        '<input type="file" id="qa-env-file" accept="image/png,image/webp,image/jpeg">' +
        '<button class="sec" id="qa-env-up">Загрузить картинку</button>' +
      "</div>" +
      '<div class="q-admin-row" style="gap:8px;align-items:center;flex-wrap:wrap">' +
        '<b style="font-size:11px;color:#caa66a">В сцену:</b>' +
        '<select id="qa-env-pick" style="min-width:170px">' + opts + "</select>" +
        '<button class="sec" id="qa-env-add">➕ Добавить в сцену</button>' +
      "</div>" +
      '<div id="qa-env-list" style="display:flex;flex-direction:column;gap:6px"></div>' +
      '<div id="qa-env-status" style="min-height:16px;font-size:11.5px;color:#e0a86a"></div>';
    var st = wrap.querySelector("#qa-env-status");
    function status(m, ok) { st.textContent = m || ""; st.style.color = ok ? "#9fe0a0" : "#e0a86a"; }
    function reloadUploaded(cb) {
      q("GET", "/queue/uploaded-models").then(function (d) { UPLOADED = d.keys || {}; (cb || refresh)(); }).catch(refresh);
    }
    // загрузка картинки окружения
    wrap.querySelector("#qa-env-file").addEventListener("change", function () {
      var f = this.files[0]; if (!f) return;
      assessImage(f, function (m, ok) { status("Оценка: " + m, ok); });
    });
    wrap.querySelector("#qa-env-up").addEventListener("click", function () {
      var name = wrap.querySelector("#qa-env-name").value.trim();
      var slug = envSlug(name);
      if (!slug) { status("Укажи название латиницей/кириллицей."); return; }
      var file = wrap.querySelector("#qa-env-file").files[0];
      fileToDataURL(file, function (dataUrl) {
        status("Загрузка…");
        q("POST", "/queue/admin/model-upload", { key: "env-" + slug, data: dataUrl })
          .then(function () { status("✓ Картинка «" + slug + "» загружена — выбери её ниже и добавь в сцену", true); reloadUploaded(); })
          .catch(function (e) { status("Ошибка: " + (e.detail || e.message)); });
      }, status);
    });
    // добавить экземпляр в сцену
    wrap.querySelector("#qa-env-add").addEventListener("click", function () {
      var key = wrap.querySelector("#qa-env-pick").value;
      if (!key) { status("Сначала загрузи картинку окружения."); return; }
      ENV.push({ id: envNextId(), key: key, w: 18, flip: 0, rotate: 0, z: "depth" });
      saveEnv(); status("✓ Добавлено в сцену. Включи «Расставить предметы» и перетащи на место.", true);
      render(_lastState);
    });
    // список размещённых объектов + управление
    var listHost = wrap.querySelector("#qa-env-list");
    function rebuildList() {
      listHost.innerHTML = "";
      if (!ENV.length) {
        listHost.innerHTML = '<span style="font-size:11px;color:#8a795a">В сцене пока нет объектов окружения.</span>';
        return;
      }
      ENV.forEach(function (o) {
        var row = document.createElement("div");
        row.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:5px 7px;" +
          "border:1px solid rgba(224,162,74,.2);border-radius:8px;background:rgba(0,0,0,.18)";
        var thumb = uploadedUrl(o.key) || "";
        row.innerHTML =
          '<img src="' + esc(thumb) + '" alt="" style="height:34px;width:auto;max-width:52px;object-fit:contain">' +
          '<b style="font-size:11.5px;color:#f0dcb4;min-width:90px">' + esc(o.key.slice(4)) + "</b>";
        // зеркало
        var flip = document.createElement("button");
        flip.className = "sec"; flip.style.padding = "3px 8px"; flip.textContent = o.flip ? "⇋ зеркало ✓" : "⇋ зеркало";
        flip.addEventListener("click", function () { o.flip = o.flip ? 0 : 1; saveEnv(); render(_lastState); });
        row.appendChild(flip);
        // поворот
        ["↺", "↻"].forEach(function (sym, i) {
          var b = document.createElement("button");
          b.className = "sec"; b.style.padding = "3px 8px"; b.textContent = sym;
          b.title = i ? "повернуть +15°" : "повернуть −15°";
          b.addEventListener("click", function () {
            o.rotate = (((+o.rotate || 0) + (i ? 15 : -15)) % 360); saveEnv(); render(_lastState);
          });
          row.appendChild(b);
        });
        var rlbl = document.createElement("span");
        rlbl.style.cssText = "font-size:11px;color:#c9b48f;min-width:38px";
        rlbl.textContent = (+o.rotate || 0) + "°";
        row.appendChild(rlbl);
        // размер
        var szWrap = document.createElement("label");
        szWrap.style.cssText = "display:flex;align-items:center;gap:4px;font-size:11px;color:#caa66a";
        szWrap.appendChild(document.createTextNode("размер"));
        var sz = document.createElement("input");
        sz.type = "range"; sz.min = "4"; sz.max = "60"; sz.step = "1"; sz.value = String((+o.w) || 18); sz.style.width = "110px";
        var szV = document.createElement("b"); szV.textContent = ((+o.w) || 18) + "%"; szV.style.minWidth = "34px";
        sz.addEventListener("input", function () {
          szV.textContent = sz.value + "%";
          var im = document.querySelector('.qs-env[data-envid="' + o.id + '"]'); if (im) im.style.width = sz.value + "%";
        });
        sz.addEventListener("change", function () { o.w = +sz.value; saveEnv(); });
        szWrap.appendChild(sz); szWrap.appendChild(szV); row.appendChild(szWrap);
        // слой
        var lay = document.createElement("select");
        lay.style.fontSize = "11px";
        [["back", "фон (за всеми)"], ["depth", "по глубине"], ["front", "перед (спереди)"]].forEach(function (p) {
          var op = document.createElement("option"); op.value = p[0]; op.textContent = p[1];
          if ((o.z || "depth") === p[0]) op.selected = true; lay.appendChild(op);
        });
        lay.addEventListener("change", function () { o.z = lay.value; saveEnv(); render(_lastState); });
        row.appendChild(lay);
        // удалить
        var del = document.createElement("button");
        del.className = "danger"; del.style.padding = "3px 9px"; del.textContent = "✕";
        del.title = "убрать из сцены";
        del.addEventListener("click", function () {
          ENV = ENV.filter(function (x) { return x.id !== o.id; });
          saveEnv(); status("Объект убран из сцены.", true); render(_lastState);
        });
        row.appendChild(del);
        listHost.appendChild(row);
      });
    }
    rebuildList();
    return wrap;
  }

  // ── связки «кому кто передаёт ресурс» — доступно ОФИЦЕРАМ и админу ──
  function buildSpousePanel(standalone) {
    var wrap = document.createElement("div");
    if (standalone) wrap.className = "q-admin";   // отдельная коробка для офицера
    var head = standalone
      ? "<h3>💞 Связки: кому кто передаёт ресурс</h3>" +
        '<div style="font-size:11.5px;color:#8a795a;margin:-6px 0 10px">Единственная функция офицеров тут. ' +
        'Задай, кому игрок по умолчанию передаёт полученный ресурс (супруг/твин). ' +
        'Игрок сможет переопределить при вставании.</div>'
      : '<div style="font-size:12px;color:#caa66a">💞 Связки супругов/получателей ' +
        '<span style="color:#8a795a;font-size:11px">— кому игрок передаёт рес по умолчанию (могут менять и офицеры)</span></div>';
    var dl = _roster.slice(0, 600).map(function (p) { return '<option value="' + esc(p.nick) + '">'; }).join("");
    wrap.innerHTML = head +
      '<div class="q-admin-row" style="gap:8px;align-items:center;flex-wrap:wrap">' +
        '<b style="font-size:12px;color:#caa66a">Игрок:</b>' +
        '<input id="qsp-nick" list="qsp-dl" placeholder="ник игрока…" autocomplete="off" style="min-width:150px">' +
        '<b style="font-size:12px;color:#caa66a">→ кому:</b>' +
        '<input id="qsp-rcpt" list="qsp-dl" placeholder="ник получателя…" autocomplete="off" style="min-width:150px">' +
        '<button id="qsp-save">Сохранить связку</button>' +
        '<button class="sec" id="qsp-del" title="Удалить связку игрока">✕</button>' +
        '<datalist id="qsp-dl">' + dl + '</datalist>' +
      "</div>" +
      '<div id="qsp-list" style="display:flex;flex-direction:column;gap:5px;max-height:240px;overflow:auto;margin-top:4px"></div>' +
      '<div id="qsp-status" style="min-height:16px;font-size:11.5px;color:#e0a86a"></div>';
    var st = wrap.querySelector("#qsp-status");
    function status(m, ok) { st.textContent = m || ""; st.style.color = ok ? "#9fe0a0" : "#e0a86a"; }
    var listHost = wrap.querySelector("#qsp-list");
    function reload() {
      q("GET", "/queue/spouses").then(function (d) {
        applySpouses(d);
        var items = d.items || [];
        listHost.innerHTML = "";
        if (!items.length) {
          listHost.innerHTML = '<span style="font-size:11px;color:#8a795a">Связок пока нет.</span>'; return;
        }
        items.forEach(function (it) {
          var row = document.createElement("div");
          row.style.cssText = "display:flex;align-items:center;gap:8px;font-size:12.5px;color:#f6ead2;" +
            "padding:4px 7px;border:1px solid rgba(224,162,74,.18);border-radius:8px";
          row.innerHTML = '<b style="min-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
            esc(it.nick) + '</b><span style="color:#caa66a">→</span>' +
            '<span style="flex:1;color:#a9e08f">' + esc(it.recipient) + "</span>";
          var del = document.createElement("button");
          del.className = "sec"; del.style.padding = "2px 9px"; del.textContent = "✕"; del.title = "удалить";
          del.addEventListener("click", function () { save(it.nick, ""); });
          row.appendChild(del); listHost.appendChild(row);
        });
      }).catch(function (e) { status("Не загрузилось: " + (e.detail || e.message)); });
    }
    function save(nick, rcpt) {
      q("POST", "/queue/spouse", { nick: nick, recipient: rcpt })
        .then(function () {
          status(rcpt ? ("✓ " + nick + " → " + rcpt) : ("Связка удалена: " + nick), true);
          reload();
        })
        .catch(function (e) {
          status(e.status === 404 ? "Ник не найден." :
                 e.status === 403 ? "Нужны права офицера/админа." : ("Ошибка: " + (e.detail || e.message)));
        });
    }
    wrap.querySelector("#qsp-save").addEventListener("click", function () {
      var nk = wrap.querySelector("#qsp-nick").value.trim(), rc = wrap.querySelector("#qsp-rcpt").value.trim();
      if (!nk || !rc) { status("Укажи игрока и получателя."); return; }
      save(nk, rc);
    });
    wrap.querySelector("#qsp-del").addEventListener("click", function () {
      var nk = wrap.querySelector("#qsp-nick").value.trim();
      if (!nk) { status("Укажи ник игрока для удаления связки."); return; }
      save(nk, "");
    });
    reload();
    return wrap;
  }

  // ── офицер/админ: кто «дошёл» на этой неделе — отметить, кто НЕ забрал ресурс ──
  // По умолчанию все они проходят дальше; отмеченные «не забрал» остаются в очереди.
  function buildDuePanel(standalone) {
    var QN = ["Обычные", "Редкие R", "Легендарные S"];
    var wrap = document.createElement("div");
    if (standalone) wrap.className = "q-admin";
    wrap.innerHTML =
      (standalone ? "<h3>🕗 Не забрал ресурс — остаётся в очереди</h3>" :
        '<div style="font-size:12px;color:#caa66a">🕗 Кто не забрал ресурс (остаётся в очереди)</div>') +
      '<div style="font-size:11.5px;color:#8a795a;margin:2px 0 8px">Кому подошла очередь и положен ресурс — по умолчанию ' +
        'на финализации (вс 00:00) проходят дальше. Отметь тех, кто НЕ успел забрать до 00:00 — они останутся в очереди первыми.</div>' +
      '<div class="q-admin-row" style="margin:0 0 6px"><button class="sec" id="qdue-refresh">↻ Обновить список</button>' +
        '<span id="qdue-status" style="font-size:11.5px;color:#e0a86a"></span></div>' +
      '<div id="qdue-list" style="display:flex;flex-direction:column;gap:5px;max-height:280px;overflow:auto"></div>';
    var listHost = wrap.querySelector("#qdue-list");
    var st = wrap.querySelector("#qdue-status");
    function status(m, ok) { st.textContent = m || ""; st.style.color = ok ? "#9fe0a0" : "#e0a86a"; }
    function reload() {
      status("Считаю…");
      q("GET", "/queue/due").then(function (d) {
        status(d.has_valor ? "" : "⚠ нет данных доблести — собери сбор");
        listHost.innerHTML = "";
        var due = d.due || [];
        if (!due.length) { listHost.innerHTML = '<span style="font-size:11.5px;color:#8a795a">На этой неделе никому не подошла очередь с ресурсом.</span>'; return; }
        due.forEach(function (r) {
          var row = document.createElement("label");
          row.style.cssText = "display:flex;align-items:center;gap:9px;font-size:12.5px;color:#f6ead2;" +
            "padding:5px 8px;border:1px solid rgba(224,162,74,.2);border-radius:8px;cursor:pointer" +
            (r.not_collected ? ";background:rgba(224,168,106,.12);border-color:rgba(224,168,106,.5)" : "");
          var cb = document.createElement("input");
          cb.type = "checkbox"; cb.checked = !!r.not_collected;
          cb.addEventListener("change", function () {
            cb.disabled = true;
            q("POST", "/queue/mark-uncollected", { entry_id: r.entry_id, uncollected: cb.checked })
              .then(function () {
                r.not_collected = cb.checked; cb.disabled = false;
                row.style.background = cb.checked ? "rgba(224,168,106,.12)" : "";
                row.style.borderColor = cb.checked ? "rgba(224,168,106,.5)" : "rgba(224,162,74,.2)";
                status(cb.checked ? ("✓ " + r.nick + " — остаётся (не забрал)") : ("✓ " + r.nick + " — пройдёт дальше"), true);
              })
              .catch(function (e) { cb.checked = !cb.checked; cb.disabled = false; status("Ошибка: " + (e.detail || e.message)); });
          });
          row.appendChild(cb);
          var info = document.createElement("span"); info.style.cssText = "flex:1;min-width:0";
          info.innerHTML = '<b>' + esc(r.nick) + '</b> <span style="color:#a58c68">· ' + esc(QN[r.queue] || "") + "</span> · " +
            esc(r.got || "") +
            (r.recipient ? ' <span style="color:#8fc36a">→ ' + esc(r.recipient) + "</span>" : "");
          row.appendChild(info);
          var tag = document.createElement("span");
          tag.style.cssText = "font:700 10px system-ui;flex:0 0 auto";
          tag.textContent = r.not_collected ? "остаётся" : "пройдёт";
          tag.style.color = r.not_collected ? "#e0a86a" : "#8fc36a";
          row.appendChild(tag);
          listHost.appendChild(row);
        });
      }).catch(function (e) {
        status(e.status === 403 ? "Доступно офицеру/админу." : ("Ошибка: " + (e.detail || e.message)));
      });
    }
    wrap.querySelector("#qdue-refresh").addEventListener("click", reload);
    reload();
    return wrap;
  }

  // человекочитаемые названия событий лога
  var LOG_KIND = {
    register: "🆕 регистрация", login: "🔑 вход", join: "➡️ встал в очередь", leave: "⬅️ вышел из очереди",
    set_entry: "✎ сменил ресурс/получателя", spouse: "💞 связка супругов", uncollected: "🕗 отметка «не забрал»",
    advance: "✅ финализация недели", report_sent: "📤 отчёт отправлен", gender: "⚧ пол игрока",
    admin_add: "➕ добавлен админом", admin_remove: "✕ убран админом", admin_move: "↕ перемещён админом",
    admin_clear: "🧹 очистка очереди", left_clan: "🚪 убран (вылетел из клана)", config: "⚙️ настройка",
    model_upload: "🖼 загрузка модели", model_delete: "🗑 удаление модели"
  };

  // ── история: недельные отчёты распределения + активность очереди (офицер+админ) ──
  function buildHistoryPanel(standalone) {
    var wrap = document.createElement("div");
    if (standalone) wrap.className = "q-admin";
    wrap.innerHTML =
      (standalone ? "<h3>📜 История и логи очереди</h3>" :
        '<div style="font-size:12px;color:#caa66a">📜 История распределений и активность очереди</div>') +
      '<div style="font-size:11.5px;color:#8a795a;margin:2px 0 8px">Полная история для ручной проверки: ' +
        'что раздавали каждую неделю, сколько этапов было закрыто, куда ушёл отчёт, и вся активность (кто вставал/выходил/за чем).</div>' +
      '<div class="q-hist-tabs">' +
        '<button class="sec q-hist-tab active" data-tab="weeks">🗓 Недельные отчёты</button>' +
        '<button class="sec q-hist-tab" data-tab="activity">📋 Активность очереди</button>' +
        '<button class="sec" id="qh-refresh" style="margin-left:auto">↻ Обновить</button>' +
      "</div>" +
      '<div id="qh-weeks"></div>' +
      '<div id="qh-activity" hidden></div>' +
      '<div id="qh-status" style="min-height:15px;font-size:11.5px;color:#e0a86a;margin-top:4px"></div>';
    var st = wrap.querySelector("#qh-status");
    function status(m, ok) { st.textContent = m || ""; st.style.color = ok ? "#9fe0a0" : "#e0a86a"; }
    var weeksHost = wrap.querySelector("#qh-weeks"), actHost = wrap.querySelector("#qh-activity");

    function fmtDate(iso) { return (iso || "").replace("T", " ").slice(0, 16); }
    function chanLabel(ch) {
      if (!ch) return "";
      if (ch.test) return "🧪 в личку: " + ch.test;
      return "TG:" + (ch.tg || "—") + " VK:" + (ch.vk || "—");
    }
    function loadWeeks() {
      status("Загружаю…");
      q("GET", "/queue/history").then(function (d) {
        status("");
        var reps = d.reports || [];
        weeksHost.innerHTML = reps.length ? "" :
          '<div style="font-size:12px;color:#8a795a;padding:8px">Пока нет финализированных недель. ' +
          'История появится после первой «Финализации недели».</div>';
        reps.forEach(function (r) {
          var det = document.createElement("details"); det.className = "q-hist-week";
          var sum = document.createElement("summary");
          sum.innerHTML = '<b>' + esc(fmtDate(r.at)) + "</b> · этапов: " + r.stages +
            ' <span style="color:#8a795a">· ' + esc(r.summary || "") + "</span>" +
            ' <span style="color:#7c9;font-size:10.5px">' + esc(chanLabel(r.channels)) + "</span>";
          det.appendChild(sum);
          var bodyEl = document.createElement("div"); bodyEl.className = "qs-distrep q-hist-body";
          bodyEl.innerHTML = '<div style="color:#8a795a;font-size:11px">открой, чтобы загрузить отчёт…</div>';
          det.appendChild(bodyEl);
          var loaded = false;
          det.addEventListener("toggle", function () {
            if (!det.open || loaded) return;
            loaded = true;
            q("GET", "/queue/history/" + r.id).then(function (dd) {
              bodyEl.innerHTML = distReportHtml(dd.report || {});
            }).catch(function (e) { bodyEl.innerHTML = '<span style="color:#e08a8a">Ошибка: ' + esc(e.detail || e.message) + "</span>"; });
          });
          weeksHost.appendChild(det);
        });
      }).catch(function (e) {
        status(e.status === 403 ? "Доступно офицеру/админу." : ("Ошибка: " + (e.detail || e.message)));
      });
    }
    function loadActivity() {
      status("Загружаю…");
      q("GET", "/queue/activity-log").then(function (d) {
        status("");
        var log = d.log || [];
        if (!log.length) { actHost.innerHTML = '<div style="font-size:12px;color:#8a795a;padding:8px">Активности пока нет.</div>'; return; }
        actHost.innerHTML = '<div class="q-act-list">' + log.map(function (r) {
          var qn = r.queue == null ? "" : (' <span class="q-act-q">оч.' + (+r.queue + 1) + "</span>");
          return '<div class="q-act-row"><span class="q-act-t">' + esc(fmtDate(r.at)) + "</span>" +
            '<span class="q-act-k">' + esc(LOG_KIND[r.kind] || r.kind) + "</span>" + qn +
            '<span class="q-act-n">' + esc(r.nick || r.actor || "") + "</span>" +
            (r.detail ? '<span class="q-act-d">' + esc(r.detail) + "</span>" : "") + "</div>";
        }).join("") + "</div>";
      }).catch(function (e) {
        status(e.status === 403 ? "Доступно офицеру/админу." : ("Ошибка: " + (e.detail || e.message)));
      });
    }
    var tabs = wrap.querySelectorAll(".q-hist-tab");
    [].forEach.call(tabs, function (btn) {
      btn.addEventListener("click", function () {
        [].forEach.call(tabs, function (b) { b.classList.remove("active"); });
        btn.classList.add("active");
        var isWeeks = btn.dataset.tab === "weeks";
        weeksHost.hidden = !isWeeks; actHost.hidden = isWeeks;
        if (isWeeks) loadWeeks(); else loadActivity();
      });
    });
    wrap.querySelector("#qh-refresh").addEventListener("click", function () {
      if (!weeksHost.hidden) loadWeeks(); else loadActivity();
    });
    loadWeeks();
    return wrap;
  }

  // ── админ: данные распределения (этапы КХ, питомец, проводники) + отчёт ──
  function buildDistPanel() {
    var wrap = document.createElement("div");
    wrap.className = "q-admin-row";
    wrap.style.cssText = "flex-direction:column;align-items:stretch;gap:8px";
    var stages = parseInt(CONFIG["stages_closed"] || "0", 10) || 0;
    var pet = parseInt(CONFIG["pet_count"] || "0", 10) || 0;
    var shooters = [];
    try { shooters = JSON.parse(CONFIG["shooters"] || "[]"); } catch (e) { shooters = []; }
    var dl = _roster.slice(0, 600).map(function (p) { return '<option value="' + esc(p.nick) + '">'; }).join("");
    wrap.innerHTML =
      '<div style="font-size:12px;color:#caa66a">🎁 Распределение ресурсов ' +
        '<span style="color:#8a795a;font-size:11px">— порог: обычные ≥60, редкие/легенд ≥100 доблести; ' +
        'проводникам по 10% камней доблести и метеоритов; доблесть берётся из последнего сбора</span></div>' +
      '<div class="q-admin-row" style="gap:14px;align-items:flex-end;flex-wrap:wrap">' +
        '<label style="display:flex;flex-direction:column;gap:2px;font-size:11px;color:#caa66a">' +
          'Закрыто этапов КХ (1–7): <b id="qd-stages-v">' + stages + '</b>' +
          '<input type="range" id="qd-stages" min="0" max="7" step="1" value="' + stages + '" style="width:220px"></label>' +
        '<label style="display:flex;flex-direction:column;gap:2px;font-size:11px;color:#caa66a">' +
          'Огненных цилиней (питомец): ' +
          '<input type="number" id="qd-pet" min="0" value="' + pet + '" style="width:90px"></label>' +
      "</div>" +
      '<div class="q-admin-row" style="gap:8px;align-items:center;flex-wrap:wrap">' +
        '<b style="font-size:11px;color:#caa66a">🎯 Проводники (+10%):</b>' +
        '<input id="qd-shnick" list="qd-dl" placeholder="ник проводника…" autocomplete="off" style="min-width:150px">' +
        '<button class="sec" id="qd-shadd">＋ добавить</button>' +
        '<datalist id="qd-dl">' + dl + '</datalist>' +
        '<span id="qd-shlist" style="display:flex;gap:5px;flex-wrap:wrap"></span>' +
      "</div>" +
      '<label class="q-admin-row" style="gap:7px;align-items:center;cursor:pointer;font-size:12px;color:#f0dcb4">' +
        '<input type="checkbox" id="qd-testmode"' + (CONFIG["queue_test_send"] !== "0" ? " checked" : "") + '> ' +
        '🧪 Пробный режим — отчёт слать мне в личку (@pw_spamer_bot), НЕ в офицерский чат ' +
        '<span style="color:#8a795a">(вкл по умолчанию до запуска)</span></label>' +
      '<div class="q-admin-row" style="gap:8px;flex-wrap:wrap">' +
        '<button id="qd-report" style="font-weight:700">📋 Получить отчёт о распределении</button>' +
        '<button class="sec" id="qd-advance" title="Отчёт в чат + сдвиг очереди">✅ Распределение завершено — финализировать неделю</button>' +
        '<button class="sec" id="qd-prune" title="Убрать вылетевших из клана">🧹 Убрать вылетевших</button>' +
      "</div>" +
      '<div class="q-admin-row" style="flex-direction:column;align-items:stretch;gap:6px;margin-top:4px">' +
        '<div style="font-size:12px;color:#caa66a">🌟 Суперспособность топ-3 (жетоны «вне очереди») ' +
          '<button class="sec" id="qd-priv-btn" style="padding:2px 8px">↻ показать</button></div>' +
        '<div class="q-admin-row" style="gap:6px;align-items:center;flex-wrap:wrap">' +
          '<span style="font-size:11px;color:#8a795a">Тест: дать жетоны игроку (напр. Лирия!):</span>' +
          '<input id="qd-priv-nick" list="qd-dl" placeholder="ник…" autocomplete="off" style="min-width:130px">' +
          '<input id="qd-priv-n" type="number" value="3" min="-50" max="50" style="width:64px">' +
          '<button class="sec" id="qd-priv-give">± дать/снять жетоны</button>' +
        "</div>" +
        '<div id="qd-priv" style="font-size:11.5px;color:#c9b48f"></div>' +
      "</div>" +
      '<div id="qd-status" style="min-height:16px;font-size:11.5px;color:#e0a86a"></div>';
    var st = wrap.querySelector("#qd-status");
    function status(m, ok) { st.textContent = m || ""; st.style.color = ok ? "#9fe0a0" : "#e0a86a"; }
    function loadPriv() {
      var host = wrap.querySelector("#qd-priv"); host.textContent = "Загрузка…";
      q("GET", "/queue/privileges").then(function (d) {
        var h = (d.holders || []).map(function (x) { return esc(x.nick) + " — " + x.tokens + " жет."; }).join(" · ") || "нет накопленных жетонов";
        var cl = (d.claims || []).map(function (c) { return esc(c.nick) + ": " + esc(c.resource) + " ×" + c.amount; }).join(" · ");
        host.innerHTML = "<b>Держатели:</b> " + h + (cl ? '<br><b>Взято вне очереди на этой неделе:</b> ' + cl : "<br><span style='color:#8a795a'>вне очереди на этой неделе ничего не брали</span>");
      }).catch(function (e) { host.textContent = "Ошибка: " + (e.detail || e.message); });
    }
    wrap.querySelector("#qd-priv-btn").addEventListener("click", loadPriv);
    wrap.querySelector("#qd-priv-give").addEventListener("click", function () {
      var nk = wrap.querySelector("#qd-priv-nick").value.trim();
      var n = parseInt(wrap.querySelector("#qd-priv-n").value, 10) || 0;
      if (!nk || !n) { status("Укажи ник и число жетонов."); return; }
      q("POST", "/queue/admin/grant-token", { nick: nk, count: n }).then(function (d) {
        status("✓ " + d.nick + " — жетонов теперь: " + d.tokens + ". Войди этим ником как игрок, чтобы протестировать «Взять вне очереди».", true);
        loadPriv();
      }).catch(function (e) { status(e.status === 404 ? "Ник не найден." : ("Ошибка: " + (e.detail || e.message))); });
    });
    function renderShooters() {
      var host = wrap.querySelector("#qd-shlist");
      host.innerHTML = shooters.length ? "" : '<span style="font-size:11px;color:#8a795a">пока никого</span>';
      shooters.forEach(function (nk, i) {
        var chip = document.createElement("span");
        chip.style.cssText = "display:inline-flex;align-items:center;gap:5px;font-size:11.5px;color:#f0dcb4;" +
          "padding:2px 6px 2px 9px;border:1px solid rgba(255,150,70,.4);border-radius:11px;background:rgba(255,150,70,.1)";
        chip.innerHTML = esc(nk);
        var x = document.createElement("button");
        x.className = "sec"; x.style.cssText = "padding:0 6px;font-size:12px"; x.textContent = "✕";
        x.addEventListener("click", function () {
          shooters.splice(i, 1); saveCfg("shooters", JSON.stringify(shooters)); renderShooters();
        });
        chip.appendChild(x); host.appendChild(chip);
      });
    }
    renderShooters();
    var stEl = wrap.querySelector("#qd-stages"), stV = wrap.querySelector("#qd-stages-v"), stT;
    stEl.addEventListener("input", function () {
      stV.textContent = stEl.value;
      clearTimeout(stT); stT = setTimeout(function () { saveCfg("stages_closed", stEl.value); }, 250);
    });
    wrap.querySelector("#qd-pet").addEventListener("change", function () {
      saveCfg("pet_count", String(Math.max(0, parseInt(this.value, 10) || 0)));
    });
    wrap.querySelector("#qd-shadd").addEventListener("click", function () {
      var nk = wrap.querySelector("#qd-shnick").value.trim();
      if (!nk) { status("Укажи ник проводника."); return; }
      if (shooters.indexOf(nk) < 0) shooters.push(nk);
      saveCfg("shooters", JSON.stringify(shooters));
      wrap.querySelector("#qd-shnick").value = ""; renderShooters(); status("✓ Проводник добавлен: " + nk, true);
    });
    wrap.querySelector("#qd-testmode").addEventListener("change", function () {
      saveCfg("queue_test_send", this.checked ? "1" : "0");
      status(this.checked ? "🧪 Пробный режим ВКЛ — отчёт пойдёт в личку (@pw_spamer_bot)" : "Пробный режим выкл — отчёт в офицерский чат", true);
    });
    wrap.querySelector("#qd-report").addEventListener("click", function () {
      status("Считаю отчёт…");
      q("GET", "/queue/admin/distribute").then(function (rep) { status(""); renderDistReport(rep); })
        .catch(function (e) { status("Ошибка: " + (e.detail || e.message)); });
    });
    wrap.querySelector("#qd-advance").addEventListener("click", function () {
      if (!confirm("Финализировать неделю?\n\n1) убрать вылетевших из клана\n2) отчёт уйдёт в офицерский чат (TG + VK)\n3) отмеченные «не забрал» останутся в очереди; получившие: с 🔁/планом — в конец, без повтора — выходят; остальные остаются в начале")) return;
      status("Финализирую неделю…");
      q("POST", "/queue/admin/advance").then(function (d) {
        var c = d.channels || {};
        var rep = c.test ? ("проба: " + c.test) : ("TG:" + (c.tg || "?") + " VK:" + (c.vk || "?"));
        status("✓ Вылетевших: " + (d.pruned || 0) + " · не забрали (остались): " + (d.stayed_uncollected || 0) +
          " · авто-переочередь: " + (d.requeued || 0) + " · вышли: " + (d.left_removed || 0) + " · отчёт " + rep,
          (c.test || c.tg) === "ok");
        refresh();
      }).catch(function (e) { status("Ошибка: " + (e.detail || e.message)); });
    });
    wrap.querySelector("#qd-prune").addEventListener("click", function () {
      if (!confirm("Убрать из очередей всех, кого нет в текущем списке клана (вылетевших)?")) return;
      status("Убираю вылетевших…");
      q("POST", "/queue/admin/prune-left").then(function (d) {
        var n = (d.removed || []).length;
        status(n ? ("✓ Убрано вылетевших: " + n + " (" + d.removed.join(", ") + ")") : "Вылетевших нет.", true);
        refresh();
      }).catch(function (e) { status("Ошибка: " + (e.detail || e.message)); });
    });
    return wrap;
  }

  // ── HTML содержимого отчёта распределения (переиспользуется в модалке и истории) ──
  function distReportHtml(rep) {
    var html = '<div class="qs-dr-head">Закрыто этапов: <b>' + (rep.stages || 0) + "</b> · " +
      (rep.has_valor ? "доблесть из последнего сбора" : '<span style="color:#e08a8a">нет данных доблести</span>') +
      (rep.pet_count ? ' · 🐲 Огненный цилинь: <b>' + rep.pet_count + " шт</b>" : "") + "</div>";
    if (rep.top3_named && rep.top3_named.length) {
      html += '<div class="qs-dr-head" style="border:0">★ ТОП-3 клана: ' +
        rep.top3_named.map(function (t) { return esc(t.nick) + " (" + t.valor + ")"; }).join(" · ") + "</div>";
    }
    if (rep.priv_claims && rep.priv_claims.length) {
      html += '<div class="qs-dr-sec"><h4>⚡ Взято вне очереди (суперспособность топ-3, уже вычтено)</h4>';
      rep.priv_claims.forEach(function (c) {
        html += '<div class="qs-dr-row"><b>' + esc(c.nick) + "</b> — " + esc(c.name) + " ×" + c.amount + "</div>";
      });
      html += "</div>";
    }
    var groups = rep.groups || [];
    html += '<div class="qs-dr-sec"><h4>📦 Группы раздачи</h4>';
    if (!groups.length) html += '<div class="qs-dr-empty">некому раздавать</div>';
    groups.forEach(function (g, gi) {
      var names = g.people.map(function (p) {
        var s = esc(p.receiver);
        if (p.via) s += ' <span style="color:#8a795a">(за ' + esc(p.via) + ")</span>" + (p.ok === false ? ' <span style="color:#e0a86a">⚠</span>' : "");
        return s;
      }).join(", ");
      var res = g.resources.map(function (info) {
        return "<b>" + esc(info.name) + "</b> — " + info.total + " шт";
      }).join("<br>");
      html += '<div class="qs-dr-group"><div class="qs-dr-gh">Группа ' + (gi + 1) +
        (g.provodnik ? ' <span class="qs-dr-prov">🎯 проводники</span>' : "") +
        " · " + g.people.length + " чел</div>" +
        '<div class="qs-dr-gp">' + names + "</div>" +
        '<div class="qs-dr-gr">' + res + "</div></div>";
    });
    html += "</div>";
    var lo = rep.leftovers || {};
    var loKeys = Object.keys(lo).filter(function (k) { return lo[k] > 0; });
    html += '<div class="qs-dr-sec"><h4>🔻 Остаток — раздать в чате клана (до вс 00:00, иначе сгорит)</h4>';
    html += '<div class="qs-dr-row">' + (loKeys.length
      ? loKeys.map(function (k) { return esc(resName(k)) + " ×" + lo[k]; }).join(" · ")
      : '<span style="color:#8fc36a">— нет, всё распределено</span>') + "</div></div>";
    return html;
  }

  // ── модалка отчёта распределения ──
  function renderDistReport(rep) {
    var body = document.createElement("div");
    body.className = "qs-distrep";
    body.innerHTML = distReportHtml(rep);
    // кнопка ручной отправки отчёта в офицерский чат
    var sendBar = document.createElement("div");
    sendBar.style.cssText = "margin-top:14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap";
    var sendBtn = document.createElement("button");
    sendBtn.className = "qs-join"; sendBtn.style.cssText = "margin:0;max-width:none";
    sendBtn.textContent = "📤 Отправить отчёт в офицерский чат (TG + VK)";
    var sendMsg = document.createElement("span");
    sendMsg.style.cssText = "font-size:12px;color:#c9b48f";
    sendBtn.addEventListener("click", function () {
      sendBtn.disabled = true; sendMsg.textContent = "Отправляю…"; sendMsg.style.color = "#c9b48f";
      q("POST", "/queue/admin/distribute/send").then(function (d) {
        var c = d.channels || {};
        var okAll = c.test ? (c.test === "ok") : (c.tg === "ok" && c.vk === "ok");
        sendMsg.textContent = c.test ? ("🧪 проба (@pw_spamer_bot): " + c.test) : ("TG: " + (c.tg || "?") + " · VK: " + (c.vk || "?"));
        sendMsg.style.color = okAll ? "#9fe0a0" : "#e0a86a";
        sendBtn.disabled = false;
      }).catch(function (e) {
        sendMsg.textContent = "Ошибка: " + (e.detail || e.message); sendMsg.style.color = "#e08a8a";
        sendBtn.disabled = false;
      });
    });
    sendBar.appendChild(sendBtn); sendBar.appendChild(sendMsg);
    body.appendChild(sendBar);
    sceneModal("📋 Отчёт о распределении ресурсов", body);
  }

  function buildModelSizePanel() {
    var BASE = 58;  // px высоты модели при 1.00×
    var wrap = document.createElement("div");
    wrap.className = "q-admin-row";
    wrap.style.cssText = "flex-direction:column;align-items:stretch;gap:4px";
    wrap.innerHTML = '<div style="font-size:12px;color:#caa66a">Размер, поворот и зеркало каждой модели ' +
      '<span style="color:#8a795a;font-size:11px">— все на одной линии, видно относительный размер. ' +
      'Ползунок — размер; ⇋ — зеркало (если модель смотрит не туда); ↺/↻ — поворот. ' +
      'Меняется у всех с этой моделью сразу и сохраняется само.</span></div>';
    var strip = document.createElement("div");
    strip.style.cssText = "display:flex;gap:8px;overflow-x:auto;padding:8px 4px;align-items:flex-end;" +
      "background:rgba(0,0,0,.25);border:1px solid rgba(224,162,74,.22);border-radius:10px";
    ALL_MODELS.forEach(function (m) {
      var s = Object.assign({ flip: 0, rotate: 0, scale: 1 }, MODEL_SETTINGS[m.key] || {});
      s.scale = +s.scale || 1; MODEL_SETTINGS[m.key] = s;
      var col = document.createElement("div");
      col.style.cssText = "flex:0 0 auto;width:96px;display:flex;flex-direction:column;align-items:center;gap:3px";
      var pit = document.createElement("div");   // общая базовая линия (низ) для сравнения
      pit.style.cssText = "height:" + (BASE * 2 + 16) + "px;width:100%;display:flex;align-items:flex-end;" +
        "justify-content:center;background:linear-gradient(180deg,rgba(190,224,234,.14),rgba(143,195,106,.16));" +
        "border:1px solid rgba(224,162,74,.2);border-radius:8px;overflow:hidden";
      var img = document.createElement("img");
      img.alt = ""; img.decoding = "async"; img.loading = "lazy"; img.src = webpUrl(m.key);
      img.style.cssText = "width:auto;max-width:100%;object-fit:contain;transform:" + transformStr(s);
      function applyPreview() { img.style.transform = transformStr(s); img.style.height = Math.round(BASE * s.scale) + "px"; }
      applyPreview(); pit.appendChild(img);
      var lbl = document.createElement("div");
      lbl.textContent = m.label;
      lbl.style.cssText = "font-size:10px;color:#e8dcc4;text-align:center;line-height:1.05;height:22px;overflow:hidden";
      var val = document.createElement("div");
      val.textContent = s.scale.toFixed(2) + "× · " + (s.rotate || 0) + "°";
      val.style.cssText = "font-size:10px;color:#f0c878;font-weight:700";
      var rng = document.createElement("input");
      rng.type = "range"; rng.min = "0.4"; rng.max = "2"; rng.step = "0.05"; rng.value = String(s.scale);
      rng.style.cssText = "width:100%;accent-color:#e0a24a";
      var t;
      function persist() {
        clearTimeout(t); t = setTimeout(function () {
          q("POST", "/queue/admin/model", { key: m.key, flip: s.flip, rotate: s.rotate, scale: s.scale }).catch(function () {});
        }, 300);
      }
      function live() { val.textContent = s.scale.toFixed(2) + "× · " + (s.rotate || 0) + "°"; applyPreview(); applyModelLive(m.key, s); }
      rng.addEventListener("input", function () { s.scale = +rng.value; live(); persist(); });
      // ряд управления: зеркало + поворот −15/+15
      var ctl = document.createElement("div");
      ctl.style.cssText = "display:flex;gap:3px;width:100%;justify-content:center;align-items:center";
      var mir = document.createElement("button");
      mir.className = "sec"; mir.style.cssText = "padding:2px 6px;font-size:12px;line-height:1";
      function paintMir() { mir.textContent = "⇋"; mir.style.background = s.flip ? "rgba(224,162,74,.4)" : ""; mir.title = s.flip ? "зеркало вкл" : "зеркало выкл"; }
      paintMir();
      mir.addEventListener("click", function () { s.flip = s.flip ? 0 : 1; paintMir(); live(); persist(); });
      ctl.appendChild(mir);
      [["↺", -15], ["↻", 15]].forEach(function (p) {
        var b = document.createElement("button");
        b.className = "sec"; b.style.cssText = "padding:2px 6px;font-size:12px;line-height:1"; b.textContent = p[0];
        b.title = "поворот " + (p[1] > 0 ? "+" : "") + p[1] + "°";
        b.addEventListener("click", function () { s.rotate = (((s.rotate || 0) + p[1]) % 360); live(); persist(); });
        ctl.appendChild(b);
      });
      col.appendChild(pit); col.appendChild(lbl); col.appendChild(val); col.appendChild(rng); col.appendChild(ctl);
      strip.appendChild(col);
    });
    wrap.appendChild(strip);
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
        q("GET", "/queue/config").then(function (d) { CONFIG = d.config || {}; }).catch(function () { CONFIG = {}; }),
        q("GET", "/queue/uploaded-models").then(function (d) { UPLOADED = d.keys || {}; }).catch(function () { UPLOADED = {}; }),
        q("GET", "/queue/spouses").then(function (d) { applySpouses(d); }).catch(function () { applySpouses(null); }),
        q("GET", "/queue/rewards").then(function (d) { REWARDS_META = d.rewards || {}; }).catch(function () { REWARDS_META = {}; }),
        q("GET", "/auth/me").then(function (m) { _role = (m && m.role) || ""; _isAdmin = _role === "admin"; })
          .catch(function () { _role = ""; _isAdmin = false; }),
        q("GET", "/queue/me").then(function (m) { _myTokens = (m && m.tokens) || 0; }).catch(function () { _myTokens = 0; })
      ]).then(function () { loadEnv(); refresh(); });
    }
  };
})();
