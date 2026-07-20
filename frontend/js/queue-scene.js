/* Сцена очередей за ресурсами с КХ (Фаза 2). 2D-вид: 3 параллельные очереди,
   человечки по классу/полу (персональные модели — если есть), ник над головой,
   будки в конце, окружение с деревьями. Плюс админ-управление и лог.
   Стили инжектим из JS (чтобы не зависеть от внешнего CSS). */
(function () {
  "use strict";
  var API = (window.OFFICERS_CONFIG && window.OFFICERS_CONFIG.API_URL) || "";
  var ADMIN_NICK = "Лирия!";   // от чьего имени админ тестирует очередь (это аккаунт Лира)
  function q(m, p, b) {
    var h = b ? { "Content-Type": "application/json" } : {};
    // фолбэк-аутентификация, когда браузер режет cookie (встроенные браузеры TG/VK):
    // device-токен игрока и офицерская сессия — из localStorage.
    try {
      var dv = localStorage.getItem("queue_device_token"); if (dv) h["X-Queue-Device"] = dv;
      var ot = localStorage.getItem("officer_session_token"); if (ot) h["Authorization"] = "Bearer " + ot;
    } catch (_) {}
    return fetch(API + p, { method: m, credentials: "include", headers: h,
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
    "маг": { m: "Маг (м).png", f: "Маг (ж).png" },
    "друид": { f: "Друид.png" },
    "стрелок": { f: "Стрелок.png" },
    "оборотень": { m: "Оборотень.png" },
    "странник": { m: "Странник.png" },
    "страж": { m: "Страж (м).png", f: "Страж (ж).png" },
    "мистик": { m: "Мистик (м).png", f: "Мистик (ж).png" },
    "убийца": { m: "Убийца (м).png", f: "Убийца (ж).png" },
    "лучник": { m: "Лучник (м).png", f: "Лучник (ж).png" },
    "жнец": { m: "Жнец (м).png", f: "Жнец (ж).png" },
    "бард": { m: "Бард (м).png", f: "Бард (ж).png" },
    "шаман": { m: "Шаман (м).png", f: "Шаман (ж).png" },
    "паладин": { m: "Паладин (м).png", f: "Паладин (ж).png" },
    "призрак": { m: "Призрак (м).png", f: "Призрак (ж).png" },
    "дух крови": { m: "Дух крови (м).png", f: "Дух крови (ж).png" }
  };
  // ключи строим через canon(имя) — чтобы совпадали при латинице/кириллице в никах
  var PERSONAL_SRC = { "Naomi": "_Naomi.png", "Карася": "Карася.png", "Кэя": "Кэя.png",
    "Лирия": "Лирия!.png", "Химеко": "Химеко.png", "Шлюпка": "Шлюпка.png",
    "АдаНет": "АдаНет.png", "Томат": "Томат.png", "Мortаlitу": "Мortаlitу.png" };
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
  // ПЕРСОНАЛЬНАЯ модель по канонам (загруженная админом person-* или статический файл), иначе null
  function personalInfo(keys) {
    for (var i = 0; i < keys.length; i++) {
      var pu = keys[i] && uploadedUrl("person-" + keys[i]);
      if (pu) return { url: pu, key: "person-" + keys[i], uploaded: true };
    }
    for (var j = 0; j < keys.length; j++) {
      if (keys[j] && PERSONAL[keys[j]]) { var f = PERSONAL[keys[j]];
        return { url: webpUrl("personal/" + f), key: "personal/" + f }; }
    }
    return null;
  }
  // КЛАССОВАЯ модель по классу и полу g ('m'|'f') — загруженная админом class-* или файл CLASS_MODEL,
  // иначе временный жрец по полу.
  function classInfo(cls, g) {
    var cu = uploadedUrl("class-" + cls + "-" + g) ||
             uploadedUrl("class-" + cls + "-m") || uploadedUrl("class-" + cls + "-f");
    if (cu) return { url: cu, key: "class-" + cls + "-" + g, uploaded: true };
    var set = CLASS_MODEL[(cls || "").toLowerCase()];
    if (set) { var fn = set[g] || set.m || set.f; return { url: webpUrl("class/" + fn), key: "class/" + fn }; }
    // Записи БЕЗ класса (нет в таблице доблести, напр. SnegoVik) — раньше показывали
    // заглушку «?». Теперь по умолчанию нормальная моделька Воина по полу (не «?»).
    var df = g === "f" ? "Воин(ж).png" : "Воин(м).png";
    return { url: webpUrl("class/" + df), key: "class/" + df };
  }
  // класс поддерживает ВЫБОР пола, только если модель для 'm' и 'f' реально РАЗНАЯ
  function classHasBothGenders(cls) { return classInfo(cls, "m").url !== classInfo(cls, "f").url; }

  // ВСЕ доступные варианты модели для записи e — [{key(токен), url, label, kind, mkey}].
  // Токены безопасны для сервера (_safe_key): 'person-<canon>[--N]' | 'pers' | 'clsm' | 'clsf'.
  //   • загруженные админом персональные (базовая + слоты --2, --3…),
  //   • встроенная персональная (если нет загруженной базовой),
  //   • классовые муж/жен (если реально разные).
  function modelVariants(e) {
    var keys = [canon(e.main_nick), canon(e.nick)].filter(Boolean);
    var out = [], seenUrl = {}, seenTok = {};
    function push(tok, url, label, kind, mkey) {
      if (!url || seenUrl[url] || seenTok[tok]) return;
      seenUrl[url] = 1; seenTok[tok] = 1; out.push({ key: tok, url: url, label: label, kind: kind, mkey: mkey || tok });
    }
    var n = 0;
    keys.forEach(function (cn) {
      var base = "person-" + cn;
      Object.keys(UPLOADED).filter(function (k) { return k === base || k.indexOf(base + "--") === 0; })
        .sort(function (a, b) { return a.length - b.length || a.localeCompare(b); })
        .forEach(function (k) { n++; push(k, uploadedUrl(k), "Личная " + n, "person", k); });
    });
    keys.forEach(function (cn) {
      if (PERSONAL[cn] && !UPLOADED["person-" + cn]) {
        n++; push("pers", webpUrl("personal/" + PERSONAL[cn]), "Личная" + (n > 1 ? " " + n : ""), "person", "personal/" + PERSONAL[cn]);
      }
    });
    var cm = classInfo(e.cls, "m"), cf = classInfo(e.cls, "f");
    push("clsm", cm.url, "Общая · муж", "class", cm.key);
    if (cf.url !== cm.url) push("clsf", cf.url, "Общая · жен", "class", cf.key);
    return out;
  }
  // токен варианта, показываемый СЕЙЧАС (для стартовой позиции переключателя)
  function currentVariantKey(e, vs) {
    vs = vs || modelVariants(e);
    if (e.variant) { for (var i = 0; i < vs.length; i++) if (vs[i].key === e.variant) return e.variant; }
    var mi = modelInfoAuto(e);
    if (mi) for (var j = 0; j < vs.length; j++) if (vs[j].url === mi.url) return vs[j].key;
    return vs.length ? vs[0].key : "";
  }
  // авто-модель (без учёта явного варианта) — прежняя логика
  function modelInfoAuto(e) {
    var keys = [canon(e.main_nick), canon(e.nick)];
    if (!e.prefer_class) { var pers = personalInfo(keys); if (pers) return pers; }
    var g = (e.gender === "f" || e.gender === "m") ? e.gender : genderOf(e.cls, e.true_name);
    return classInfo(e.cls, g);
  }
  function modelInfo(e) {
    // Явно выбранный игроком вариант имеет приоритет (если он всё ещё доступен).
    if (e.variant) {
      var v = e.variant;
      if (v === "clsm") return classInfo(e.cls, "m");
      if (v === "clsf") return classInfo(e.cls, "f");
      if (v === "pers") { var p = personalInfo([canon(e.main_nick), canon(e.nick)]); if (p) return p; }
      else if (v.indexOf("person-") === 0) { var u = uploadedUrl(v); if (u) return { url: u, key: v }; }
      // вариант больше не доступен → падаем в авто-логику
    }
    return modelInfoAuto(e);
  }
  function modelUrl(e) { var m = modelInfo(e); return m ? m.url : null; }
  // «моя ли это моделька» — для кнопки смены облика: игрок по своему нику, ИЛИ админ в режиме
  // теста как Лирия! (у него нет игрового аккаунта, но он должен видеть, как всё выглядит).
  function isMyModel(e) {
    if (_meAcc) return canon(e.main_nick) === canon(_meAcc.main_nick);
    if (_isAdmin) return canon(e.main_nick) === canon(ADMIN_NICK);
    return false;
  }
  // аура текущей модели записи ('' | 'death') — для зловещей дымки вокруг конкретной модельки
  function modelAura(e) {
    var mi = modelInfo(e);
    return (mi && MODEL_SETTINGS[mi.key] && MODEL_SETTINGS[mi.key].aura) || "";
  }

  // все модели (для админ-настройки поворота/зеркала)
  var ALL_MODELS = [
    { key: "class/Воин(м).png", label: "Воин (м)" }, { key: "class/Воин(ж).png", label: "Воин (ж)" },
    { key: "class/Жрец (м).png", label: "Жрец (м)" }, { key: "class/Жрец (ж).png", label: "Жрец (ж)" },
    { key: "class/Маг (м).png", label: "Маг (м)" }, { key: "class/Маг (ж).png", label: "Маг (ж)" },
    { key: "class/Друид.png", label: "Друид" },
    { key: "class/Стрелок.png", label: "Стрелок" }, { key: "class/Оборотень.png", label: "Оборотень" },
    { key: "class/Странник.png", label: "Странник" },
    { key: "class/Страж (м).png", label: "Страж (м)" }, { key: "class/Страж (ж).png", label: "Страж (ж)" },
    { key: "class/Мистик (м).png", label: "Мистик (м)" }, { key: "class/Мистик (ж).png", label: "Мистик (ж)" },
    { key: "class/Убийца (м).png", label: "Убийца (м)" }, { key: "class/Убийца (ж).png", label: "Убийца (ж)" },
    { key: "class/Лучник (м).png", label: "Лучник (м)" }, { key: "class/Лучник (ж).png", label: "Лучник (ж)" },
    { key: "class/Жнец (м).png", label: "Жнец (м)" }, { key: "class/Жнец (ж).png", label: "Жнец (ж)" },
    { key: "class/Бард (м).png", label: "Бард (м)" }, { key: "class/Бард (ж).png", label: "Бард (ж)" },
    { key: "class/Шаман (м).png", label: "Шаман (м)" }, { key: "class/Шаман (ж).png", label: "Шаман (ж)" },
    { key: "class/Паладин (м).png", label: "Паладин (м)" }, { key: "class/Паладин (ж).png", label: "Паладин (ж)" },
    { key: "class/Призрак (м).png", label: "Призрак (м)" }, { key: "class/Призрак (ж).png", label: "Призрак (ж)" },
    { key: "class/Дух крови (м).png", label: "Дух крови (м)" }, { key: "class/Дух крови (ж).png", label: "Дух крови (ж)" },
    { key: "personal/_Naomi.png", label: "Naomi (личн.)" }, { key: "personal/Карася.png", label: "Карася (личн.)" },
    { key: "personal/Кэя.png", label: "Кэя (личн.)" }, { key: "personal/Лирия!.png", label: "Лирия! (личн.)" },
    { key: "personal/Химеко.png", label: "Химеко (личн.)" }, { key: "personal/Шлюпка.png", label: "Шлюпка (личн.)" },
    { key: "personal/АдаНет.png", label: "АдаНет (личн.)" }, { key: "personal/Томат.png", label: "Томат (личн., проводник)" },
    { key: "personal/Мortаlitу.png", label: "Мortаlitу (личн., проводник)" },
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
    { q: 1, title: "Редкие (R)", accent: "#ff8a2b", glow: "#ffd24a", bx: 65, by: 62, ui: { x: 61, y: 74 }, item: { x: 73, y: 64 },
      merchant: { x: 70, y: 59 },
      path: [{ x: 37, y: 80 }, { x: 45, y: 76 }, { x: 53, y: 72 }, { x: 60, y: 69 }] },
    { q: 2, title: "Легендарные (S)", accent: "#c07be0", glow: "#c07be0", lightning: true, bx: 80, by: 74, ui: { x: 78, y: 88 }, item: { x: 89, y: 80 },
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
  // Крупный портрет модели на «пьедестале» (свечение: золото — ТОП-3, чёрное — проводник),
  // затем разделитель и ресурсы — чтобы «кто» визуально отделялось от «за чем стоит».
  function tipPortrait(e) {
    var mi = modelInfo(e);
    if (!mi) return '<div class="qtip-portrait"><div class="qtip-ph">' + esc((e.cls || "класс?").slice(0, 14)) + "</div></div>";
    var aura = (MODEL_SETTINGS[mi.key] && MODEL_SETTINGS[mi.key].aura) || "";
    var kind = (aura === "death" ? " death" : "") + (e.privileged ? " priv" : (e.is_shooter ? " guide" : ""));
    var flip = (MODEL_SETTINGS[mi.key] && MODEL_SETTINGS[mi.key].flip) ? "scaleX(-1)" : "";
    return '<div class="qtip-portrait' + kind + '">' +
      '<span class="qtip-shadow"></span>' +
      '<img class="qtip-mdl" src="' + esc(mi.url) + '"' + (flip ? ' style="transform:' + flip + '"' : "") + ' alt="">' +
      (e.privileged ? '<span class="qtip-badge gold">⚡ ТОП-3</span>' : e.is_shooter ? '<span class="qtip-badge dark">✦ Проводник</span>' :
        aura === "death" ? '<span class="qtip-badge death-b">☠ Смерть</span>' : "") +
      "</div>";
  }
  function tipDiv(label) {
    return '<div class="qtip-divider"><span>' + label + "</span></div>";
  }
  function tipBody(e) {
    var head = tipPortrait(e) + '<span class="qtip-nick">' + esc(e.nick) + "</span>";
    var rl = (e.resources && e.resources.length) ? e.resources : (e.resource ? [e.resource] : []);
    if (!rl.length)
      return head + (e.privileged
        ? '<span class="qtip-priv">⚡ вне очереди — жетон ТОП-3 (ресурс не выбран)</span>'
        : tipDiv("стоит за") + '<span class="qtip-res none">ресурс ещё не выбран</span>');
    if (e.privileged) {                                       // жетон — всегда один ресурс
      var rm = REWARDS_META[e.resource] || {}, unit = rm.unit || 0, st = e.priv_stacks || 1;
      var qty = (unit ? (st * unit) + " шт" : "") + (st > 1 ? " · " + st + " жетон(ов)" : "");
      var res = '<span class="qtip-res"><img class="qtip-ic" src="' + resImg(e.resource) + '" alt=""> ' +
        esc(resName(e.resource)) + (qty ? ' — <b>' + qty + "</b>" : "") + "</span>";
      return head + '<span class="qtip-priv">⚡ берёт ВНЕ очереди — жетон ТОП-3 по доблести</span>' +
        tipDiv("ресурс") + res;
    }
    var list = rl.map(function (k) {
      var rm = REWARDS_META[k] || {}, unit = rm.unit || 0;
      var qty = rm.mode === "pack" ? "всё за неделю — первому" : (unit ? unit + " шт" : "стак");
      return '<span class="qtip-res"><img class="qtip-ic" src="' + resImg(k) + '" alt=""> ' +
        esc(resName(k)) + ' — <b>' + qty + "</b></span>";
    }).join("");
    return head + tipDiv("стоит за" + (rl.length > 1 ? " · " + rl.length + " (каждый по стаку)" : "")) + list;
  }
  // Обёртка: к телу подсказки добавляем кнопку «Сменить облик» — если это МОЯ моделька (игрок
  // или админ-тест как Лирия!) и обликов несколько. Кнопка кликабельна (окно становится интерактивным).
  function tipHtml(e) {
    var out = tipBody(e);
    // кнопка смены облика: своя моделька (игрок/админ-тест) ИЛИ любой админ (может менять всем)
    if ((isMyModel(e) || _isAdmin) && modelVariants(e).length > 1)
      out += '<button type="button" class="qtip-skin" data-eid="' + (e.id || "") + '">🔄 Сменить облик' +
        ((_isAdmin && !isMyModel(e)) ? " (админ)" : "") + "</button>";
    return out;
  }
  // Предупреждения по «капризным» ресурсам (падают не всегда). Смысл: встал — не потеряешь
  // очередь, получишь ПЕРВЫМ, как только предмет появится, и стоишь пока не заберёшь.
  var RES_WARN = {
    "gramota": "Может быть выдана ВНЕ очереди — проводникам на КХ или тем, у кого не осталось " +
      "пропусков на КХ, даже если подойдёт твоя очередь. Ты не теряешь место: как только грамота " +
      "освободится — получишь её по очереди.",
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
  // слой объекта: 'front' спереди, 'back' сзади, иначе авто — но ВНУТРИ каждого
  // слоя порядок сохраняется по глубине сцены (y): кто ниже на экране = ближе к
  // зрителю = перекрывает = выше по z. Так два объекта на переднем фоне уже не
  // равны: тот, что поставлен ПЕРЕД очередью (ниже/перекрывает), ляжет ПОВЕРХ неё.
  function zOf(key, y) {
    var z = PLACEMENTS[key] && PLACEMENTS[key].z;
    var base = Math.round((y || 0) * 12);        // глубина: ниже = выше слой (0..~1200)
    if (z === "front") return 9200 + base;       // передний слой, внутри — по глубине
    // задний слой: ПОЛОЖИТЕЛЬНЫЙ низкий z (отрицательный уводил объект за фон-картинку!),
    // ниже авто, но внутри слоя — по глубине (кто ниже на экране, тот чуть выше).
    if (z === "back") return 1 + Math.round((y || 0));  // 1..~101 < авто (y*12)
    return base;                                 // авто — просто по глубине
  }
  // размер конкретного объекта (по ключу размещения); откат — категорийный размер/1
  function objSize(pkey, base) { var v = parseFloat(CONFIG["size:" + pkey]); return (isFinite(v) && v > 0) ? v : (base || 1); }
  // зеркалирование объекта по ключу
  function isFlipped(pkey) { return CONFIG["flip:" + pkey] === "1"; }
  // скрыт ли объект со сцены (обратимо; встроенные объекты не удаляются насовсем, а прячутся)
  function isHidden(pkey) { return CONFIG["hide:" + pkey] === "1"; }
  // ключ загруженной ЗАМЕНЫ модели встроенного объекта. Санитайзим как бэкенд (_safe_key: [^\w-]→_),
  // иначе двоеточие в 'lavka:0' на сервере станет '_' и фронт не найдёт файл.
  function overrideKey(pkey) { return "obj-" + String(pkey).replace(/[^A-Za-z0-9_-]/g, "_"); }
  // src картинки объекта: если админ загрузил замену — она, иначе штатная (dflt)
  function objImgSrc(pkey, dflt) { return uploadedUrl(overrideKey(pkey)) || dflt; }
  // суффикс transform с учётом зеркала (base — базовый translate объекта)
  function flipTf(pkey, base) { return base + (isFlipped(pkey) ? " scaleX(-1)" : ""); }
  // текущая позиция+слой объекта (сохранённые или дефолтные) — для админ-панели перемещения
  function curPlace(key, dx, dy) { var p = PLACEMENTS[key]; return { x: p ? p.x : dx, y: p ? p.y : dy, z: (p && p.z) || "" }; }
  function savePlacement(key, x, y, z) {
    x = Math.max(0, Math.min(100, x)); y = Math.max(0, Math.min(100, y));
    PLACEMENTS[key] = { x: x, y: y, z: z || "" };
    q("POST", "/queue/admin/placement", { key: key, x: x, y: y, z: z || "" }).catch(function () {});
  }
  // подпись объекта на сцене — ТОЛЬКО для админа в режиме расстановки (гость/офицер не видят)
  function admTag(pos, text) {
    var t = document.createElement("div");
    t.className = "qs-adm-tag";
    t.style.cssText = "left:" + pos.x.toFixed(2) + "%;top:" + pos.y.toFixed(2) + "%";
    t.textContent = text;
    return t;
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
      // объекты сцены считаем от .qs-stage; кошелёк «на рамке» живёт в .qs-frame (поверх рамки)
      var stage = el.closest(".qs-stage") || el.closest(".qs-frame"); if (!stage) return;
      var rect = stage.getBoundingClientRect(), lx = null, ly = null;
      function move(e) {
        var pt = e.touches ? e.touches[0] : e;
        lx = Math.max(0, Math.min(100, ((pt.clientX - rect.left) / rect.width) * 100));
        ly = Math.max(0, Math.min(100, ((pt.clientY - rect.top) / rect.height) * 100));
        el.style.left = lx.toFixed(2) + "%"; el.style.top = ly.toFixed(2) + "%";
        if (!el.dataset.fixedz) el.style.zIndex = Math.round(ly * 12);   // fixedz (кошелёк) — всегда поверх рамки
      }
      function end() {
        document.removeEventListener(moveEvt, move); document.removeEventListener(endEvt, end);
        if (lx != null) {
          var zc = (PLACEMENTS[pkey] && PLACEMENTS[pkey].z) || "";
          PLACEMENTS[pkey] = { x: lx, y: ly, z: zc };
          if (!el.dataset.fixedz) el.style.zIndex = zOf(pkey, ly);
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
    // КРУГ-ФИНИШ на земле в конце очереди (у торговца) — концентрические кольца в цвете очереди
    var endP = pathPoint(pth, 1);
    var spot = document.createElement("div");
    spot.className = "qs-endspot";
    spot.style.cssText = "left:" + endP.x.toFixed(2) + "%;top:" + endP.y.toFixed(2) + "%;--gc:" + b.accent;
    spot.innerHTML = '<span class="qs-endspot-core"></span><span class="qs-endspot-ping"></span>';
    frag.appendChild(spot);
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
    ".q-admin-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 10px;min-width:0}" +
    ".qa-model-strip{scrollbar-width:auto}" +
    ".qa-model-strip::-webkit-scrollbar{height:12px}" +
    ".qa-model-strip::-webkit-scrollbar-track{background:rgba(0,0,0,.3);border-radius:6px}" +
    ".qa-model-strip::-webkit-scrollbar-thumb{background:linear-gradient(180deg,#e0a24a,#a5762a);border-radius:6px;border:2px solid rgba(0,0,0,.3)}" +
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
    ".qs-stage{position:absolute;inset:15%;overflow:hidden;border-radius:4px;container-type:inline-size;" +
      "background-size:100% 100%;background-repeat:no-repeat;box-shadow:inset 0 0 18px rgba(0,0,0,.18)}" +
    ".qs-stage.day{background-image:url('assets/queue/scene/scene-bg-day.webp?v=4')}" +
    ".qs-stage.night{background-image:url('assets/queue/scene/scene-bg-night.webp?v=4')}" +
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
    // круг-финиш на земле у конца очереди (у торговца)
    ".qs-endspot{position:absolute;transform:translate(-50%,-50%);width:8.5%;aspect-ratio:2/1;pointer-events:none;z-index:4}" +
    ".qs-endspot-core{position:absolute;inset:0;border-radius:50%;border:2.5px solid var(--gc);" +
      "box-shadow:0 0 12px -2px var(--gc),inset 0 0 12px -4px var(--gc);" +
      "background:radial-gradient(ellipse at center,rgba(255,255,255,.08),transparent 68%)}" +
    ".qs-endspot-core::after{content:'';position:absolute;left:50%;top:50%;width:30%;aspect-ratio:2/1;" +
      "transform:translate(-50%,-50%);border-radius:50%;background:var(--gc);box-shadow:0 0 8px 1px var(--gc);opacity:.9}" +
    ".qs-endspot-ping{position:absolute;inset:0;border-radius:50%;border:2px solid var(--gc);opacity:0;" +
      "animation:qsEndPing 2.1s ease-out infinite}" +
    "@keyframes qsEndPing{0%{transform:scale(.5);opacity:.8}100%{transform:scale(1.45);opacity:0}}" +
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
    ".qs-btn-abs{position:absolute;transform:translate(-50%,-50%) scale(var(--jd,1));z-index:9000;margin:0;" +
      "transition:transform .08s ease,filter .08s ease,box-shadow .08s ease}" +
    /* анимация нажатия — кнопка «проваливается» (с учётом масштаба по глубине --jd) */
    ".qs-btn-abs:active{transform:translate(-50%,-50%) translateY(2px) scale(calc(var(--jd,1) * .93))!important;" +
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
    ".qs-lane-cnt{position:relative;display:inline-block;width:52px;flex:0 0 auto;line-height:0}" +
    ".qs-lane-cnt-bg{width:52px;height:auto;display:block;filter:drop-shadow(0 2px 3px rgba(0,0,0,.4))}" +
    ".qs-lane-cnt-n{position:absolute;top:37%;left:50%;transform:translate(-50%,-50%);font:800 15px system-ui;" +
      "color:#7a4a10;text-shadow:0 1px 1px rgba(255,240,200,.5)}" +
    ".qs-lane-you{font:800 11px system-ui;color:var(--gc);text-shadow:0 1px 2px #000;margin-left:2px}" +
    ".qs-lane-sw{display:flex;align-items:stretch;gap:5px}" +
    ".qs-lane-arrow{flex:0 0 auto;width:26px;border:1px solid rgba(224,162,74,.35);background:rgba(20,13,7,.7);" +
      "color:#e0a24a;border-radius:8px;cursor:pointer;font-size:12px;transition:filter .1s,transform .08s}" +
    ".qs-lane-arrow:hover{filter:brightness(1.2)}.qs-lane-arrow:active{transform:scale(.9)}" +
    ".qs-lane-strip{flex:1 1 auto;display:flex;gap:6px;overflow-x:auto;overflow-y:visible;" +
      "padding:3px 2px;scrollbar-width:thin;justify-content:space-between;align-items:stretch}" +
    /* кнопка «Встать/Выйти» в начале полосы */
    ".qs-lane-join{flex:0 0 auto;align-self:center;cursor:pointer;border:0;background:none;padding:2px;min-width:60px;height:104px;" +
      "display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:1px;transition:filter .08s}" +
    ".qs-lane-join-tot{position:relative;display:flex;justify-content:center;height:78px;flex:0 0 auto}" +
    ".qs-jt-dim,.qs-jt-lit{height:78px;width:auto;object-fit:contain;filter:drop-shadow(0 3px 5px rgba(0,0,0,.5))}" +
    ".qs-jt-lit{position:absolute;left:50%;top:0;transform:translateX(-50%);opacity:0;transition:opacity .18s}" +
    ".qs-lane-join:hover .qs-jt-lit{opacity:1}" +
    ".qs-lane-join-tx{height:22px;display:flex;align-items:center;justify-content:center;overflow:hidden;" +
      "font:800 9px/1.1 system-ui;color:#f6ead2;text-align:center;max-width:74px;text-shadow:0 1px 2px #000}" +
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
    "@media(max-width:640px){.qs-merch-box{width:220px}.qs-lane-board{width:60px}}" +
    // ТЕЛЕФОН (портрет ≤480px): ряд очереди переносим, чтобы ничего не вылезало за экран.
    // Кнопка+счётчик — первой строкой, лента людей — второй, ящик торговца — третьей.
    "@media(max-width:480px){" +
      ".qs-lane-sw{flex-wrap:wrap}" +
      ".qs-lane-arrow{display:none}" +                       // ленту на телефоне листают пальцем
      ".qs-lane-join{order:1;align-self:auto}" +
      ".qs-lane-board{order:1;width:66px}" +
      ".qs-lane-strip{order:2;flex:1 1 100%;min-width:0}" +
      ".qs-merch-box{order:3;width:100%;flex:1 1 100%;align-self:auto}" +
      // UI сцены (кнопки/таблички/ники) масштабируется через cqw (см. .qs-stage container),
      // поэтому фикс-px оверрайды тут больше не нужны.
    "}" +
    ".qs-lane-strip::-webkit-scrollbar{height:6px}.qs-lane-strip::-webkit-scrollbar-thumb{background:rgba(224,162,74,.4);border-radius:3px}" +
    ".qs-lane-empty{font-size:11.5px;color:#7a6a4a;padding:10px 6px;font-style:italic}" +
    /* окно правил (вверху, разворачивается) */
    ".qs-rules{max-width:1100px;margin:10px auto 0;border:1px solid rgba(224,162,74,.4);border-radius:13px;" +
      "background:linear-gradient(180deg,rgba(40,26,12,.88),rgba(22,14,7,.92));box-shadow:0 5px 18px rgba(0,0,0,.42);overflow:hidden}" +
    ".qs-rules-sum{cursor:pointer;list-style:none;display:flex;align-items:center;gap:9px;padding:12px 16px;" +
      "font:800 14.5px Georgia,serif;color:#f0c878;text-shadow:0 1px 2px #000}" +
    ".qs-rules-sum::-webkit-details-marker{display:none}" +
    ".qs-rules-ic0{font-size:19px}" +
    ".qs-rules-arr{margin-left:auto;color:#caa66a;transition:transform .18s}" +
    ".qs-rules[open] .qs-rules-arr{transform:rotate(90deg)}" +
    ".qs-rules-sum:hover{background:rgba(224,162,74,.07)}" +
    ".qs-rules[open] .qs-rules-sum{border-bottom:1px solid rgba(224,162,74,.22)}" +
    ".qs-rules-body{padding:4px 16px 14px}" +
    ".qs-rule{font:500 13px/1.5 system-ui;color:#eaddc4;margin:9px 0;padding-bottom:9px;border-bottom:1px solid rgba(224,162,74,.12)}" +
    ".qs-rule:last-child{border-bottom:0;padding-bottom:0}" +
    ".qs-rule b{color:#f6e4bc}.qs-rule-b{font-weight:800}" +
    ".qs-rule-tok{background:linear-gradient(180deg,rgba(70,52,18,.4),rgba(40,28,10,.35));" +
      "border:1px solid rgba(255,210,110,.4);border-radius:10px;padding:10px 12px;margin-top:10px}" +
    ".qs-rules-row{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}" +
    ".qs-rules-ic{height:34px;width:auto;object-fit:contain;filter:drop-shadow(0 2px 3px rgba(0,0,0,.5))}" +
    "@media(max-width:640px){.qs-rules-sum{font-size:12.5px;padding:10px 12px}.qs-rule{font-size:12px}.qs-rules-ic{height:28px}}" +
    /* переключатель пола своей модельки (низ страницы, всем вошедшим) */
    ".qs-gender{max-width:430px;margin:16px auto 6px;padding:13px 16px 15px;border:1px solid rgba(224,162,74,.34);" +
      "border-radius:14px;background:linear-gradient(180deg,rgba(40,26,12,.74),rgba(22,14,7,.74));" +
      "box-shadow:0 5px 16px rgba(0,0,0,.42),inset 0 1px 0 rgba(255,210,130,.08)}" +
    ".qs-gn-head{display:flex;align-items:center;gap:9px;margin:0 0 11px}" +
    ".qs-gn-ic{font-size:20px;filter:drop-shadow(0 1px 2px #000)}" +
    ".qs-gn-tx{display:flex;flex-direction:column;line-height:1.2}" +
    ".qs-gn-tx b{font:800 14px Georgia,serif;color:#f0c878;text-shadow:0 1px 2px #000}" +
    ".qs-gn-sub{font:500 11px system-ui;color:#a99169}" +
    ".qs-gn-seg{display:flex;gap:7px}" +
    ".qs-gn-opt{flex:1;display:flex;align-items:center;justify-content:center;gap:6px;cursor:pointer;" +
      "padding:11px 8px;border-radius:11px;border:1px solid rgba(224,162,74,.34);background:rgba(20,13,7,.6);" +
      "color:#d8c39a;font:800 13.5px system-ui;text-shadow:0 1px 2px #000;" +
      "transition:transform .1s,box-shadow .18s,background .18s,color .18s,border-color .18s}" +
    ".qs-gn-opt:hover{background:rgba(224,162,74,.12);color:#f6ead2}" +
    ".qs-gn-opt:active{transform:translateY(1px)}" +
    ".qs-gn-sym{font-size:18px;line-height:1}" +
    ".qs-gn-opt.m.on{background:linear-gradient(180deg,#5a86c8,#37589a);border-color:#7ea6e0;color:#fff;" +
      "box-shadow:0 3px 11px rgba(60,110,200,.42),inset 0 1px 0 rgba(255,255,255,.25)}" +
    ".qs-gn-opt.f.on{background:linear-gradient(180deg,#d08bb4,#a55684);border-color:#e6a6cc;color:#fff;" +
      "box-shadow:0 3px 11px rgba(190,90,150,.42),inset 0 1px 0 rgba(255,255,255,.25)}" +
    ".qs-gn-opt:disabled{opacity:.6;cursor:default}" +
    ".qs-gn-auto{display:block;margin:10px auto 0;cursor:pointer;border:0;background:none;" +
      "font:700 11.5px system-ui;color:#a99169;text-decoration:underline;text-underline-offset:2px}" +
    ".qs-gn-auto:hover{color:#e4b65c}.qs-gn-auto:disabled{opacity:.5;cursor:default}" +
    // сегмент выбора источника модели (персональная/классовая) + заблокированный пол + подсказка
    ".qs-gn-opt.src.on{background:linear-gradient(180deg,#caa24e,#9c7a2e);border-color:#e4c37a;color:#20160a;" +
      "box-shadow:0 3px 11px rgba(200,160,70,.4),inset 0 1px 0 rgba(255,240,200,.35)}" +
    ".qs-gn-seg.off{opacity:.5}" +
    ".qs-gn-note{margin:8px 4px 0;font:600 11px system-ui;color:#a99169;text-align:center;line-height:1.35}" +
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
    // свиток «Держатели жетонов ТОП-3» — сверху справа, для всех
    ".qs-tboard{margin:6px 0 4px auto;width:min(340px,100%);border-radius:13px;overflow:hidden;" +
      "background:linear-gradient(180deg,#33240e,#1f1408);border:1px solid rgba(240,190,100,.5);" +
      "box-shadow:0 6px 22px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,224,160,.15)}" +
    ".qs-tb-head{width:100%;display:flex;align-items:center;gap:8px;padding:9px 12px;cursor:pointer;border:0;" +
      "background:linear-gradient(180deg,#3f2c10,#2a1c0a);color:#ffd98a;font:800 12.5px system-ui;text-align:left}" +
    ".qs-tb-head:hover{filter:brightness(1.08)}" +
    ".qs-tb-coin{width:22px;height:22px;object-fit:contain;flex:0 0 auto;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))}" +
    ".qs-tb-title{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
    ".qs-tb-cnt{font:700 11px system-ui;color:#caa66a}" +
    ".qs-tb-arrow{font-size:12px;color:#f0c878}" +
    ".qs-tb-body{max-height:300px;overflow-y:auto;padding:6px 8px 8px}" +
    ".qs-tb-empty{padding:10px;font-size:12px;color:#c0a878;font-style:italic;text-align:center}" +
    ".qs-tb-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px}" +
    ".qs-tb-row:nth-child(odd){background:rgba(255,220,150,.05)}" +
    ".qs-tb-row.top{background:rgba(245,200,120,.12);border:1px solid rgba(240,190,100,.28)}" +
    ".qs-tb-rank{min-width:26px;font:800 14px system-ui;color:#ffd98a;text-align:center}" +
    ".qs-tb-nick{flex:1;font:700 13px system-ui;color:#f6ead2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
    ".qs-tb-coins{display:flex;align-items:center}" +
    ".qs-tb-mini{width:15px;height:15px;object-fit:contain;margin-left:-5px}" +
    ".qs-tb-mini:first-child{margin-left:0}" +
    ".qs-tb-n{font:800 12.5px system-ui;color:#ffe4a0;min-width:26px;text-align:right}" +
    // личное уведомление «не хватило доблести» — тёплый свиток-предупреждение
    ".qs-notice{position:relative;margin:10px 0 8px;padding:16px 18px 15px;border-radius:16px;" +
      "background:linear-gradient(180deg,#3a2410,#25160a 70%,#1c1006);" +
      "border:1px solid rgba(240,180,90,.6);box-shadow:0 10px 34px rgba(0,0,0,.55)," +
      "inset 0 1px 0 rgba(255,224,160,.18),0 0 30px rgba(230,150,60,.12)}" +
    ".qs-nt-x{position:absolute;top:9px;right:11px;background:none;border:0;color:#caa66a;font-size:17px;cursor:pointer;line-height:1}" +
    ".qs-nt-x:hover{color:#fff}" +
    ".qs-nt-head{font:800 15px Georgia,serif;color:#ffd98a;text-shadow:0 1px 3px #000;margin:0 0 7px}" +
    ".qs-nt-lead{font-size:13px;line-height:1.55;color:#f0e0c4;margin:0 0 11px}" +
    ".qs-nt-lead b{color:#ffe0a0}" +
    ".qs-nt-list{display:flex;flex-direction:column;gap:7px;margin:0 0 12px}" +
    ".qs-nt-row{display:flex;align-items:center;gap:11px;padding:8px 11px;border-radius:11px;" +
      "background:rgba(255,220,150,.06);border:1px solid rgba(240,180,90,.28)}" +
    ".qs-nt-ic{width:38px;height:38px;object-fit:contain;flex:0 0 auto;filter:drop-shadow(0 2px 4px rgba(0,0,0,.5))}" +
    ".qs-nt-txt{min-width:0}" +
    ".qs-nt-res{font-size:13.5px;color:#f6ead2}.qs-nt-res b{color:#ffe0a0}" +
    ".qs-nt-qty{font-weight:800;color:#ffd98a}" +
    ".qs-nt-q{font-size:11.5px;color:#c0a878}" +
    ".qs-nt-need{font-size:12px;color:#d8c39f;margin-top:2px}" +
    ".qs-nt-thr{color:#ffcf8a}.qs-nt-had{color:#ff9a86}" +
    ".qs-nt-foot{font-size:12.5px;line-height:1.55;color:#cbe6c0;padding-top:10px;border-top:1px solid rgba(240,180,90,.22)}" +
    ".qs-nt-foot b{color:#bfe6a8}" +
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
    // «мой кошелёк жетонов ТОП-3»
    ".qs-mytok{display:flex;align-items:center;gap:13px;margin:6px 0;min-width:0}" +
    ".qs-mt-wallet{position:relative;flex:0 0 auto;width:min(300px,52vw);line-height:0}" +
    ".qs-mt-frame{width:100%;height:auto;display:block;filter:drop-shadow(0 4px 10px rgba(0,0,0,.45))}" +
    // прорезь под жетоны — бархатное окно рамки (центр-право)
    ".qs-mt-slot{position:absolute;left:31%;right:8%;top:27%;bottom:27%;display:flex;align-items:center;justify-content:center;gap:2px}" +
    ".qs-mt-coins{display:flex;align-items:center}" +
    ".qs-mt-coin{height:82%;width:auto;max-height:34px;object-fit:contain;margin-left:-10px;filter:drop-shadow(0 0 5px rgba(255,210,120,.7))}" +
    ".qs-mt-coin:first-child{margin-left:0}" +
    ".qs-mt-x{font:900 17px system-ui;color:#ffe4a0;margin-left:4px;text-shadow:0 1px 2px #000,0 0 6px rgba(255,200,120,.6)}" +
    ".qs-mt-empty{font:700 12px system-ui;color:#c0a878;font-style:italic}" +
    ".qs-mt-info{min-width:0}" +
    ".qs-mt-n{font:800 14.5px system-ui;color:#ffe08a}.qs-mt-n b{color:#fff}" +
    ".qs-mt-sub{font:500 12px system-ui;color:#d8c39f;margin-top:1px}" +
    "@media(max-width:640px){.qs-mt-wallet{width:180px}.qs-mt-x{font-size:14px}}" +
    ".qs-cnt-line{margin:0 0 4px}" +
    ".qs-cnt{display:inline-block;padding:2px 9px;border-radius:8px;font:700 11px system-ui;color:#fff;" +
      "background:rgba(20,13,7,.82);border:1px solid var(--gc);text-shadow:0 1px 2px #000}" +
    ".qs-item{position:absolute;height:calc(7% * var(--qs-item-scale,1));width:auto;" +
      "transform:translate(-50%,-100%);pointer-events:none;filter:drop-shadow(0 3px 4px rgba(0,0,0,.4))}" +
    ".qs-mount{position:absolute;height:calc(22% * var(--qs-mount-scale,1));width:auto;" +
      "transform:translate(-50%,-100%);pointer-events:none;" +
      "filter:drop-shadow(0 6px 8px rgba(0,0,0,.5))}" +
    // лавки и фонтан — выравнены по основанию (translate -50%/-100%), размер через CSS-переменную
    ".qs-lavka{position:absolute;height:calc(30% * var(--qs-lavka-scale,1));width:auto;" +
      "transform:translate(-50%,-100%);pointer-events:none;" +
      /* базовая тень + цветное свечение цветом очереди (--gc); мягкое «дыхание» */
      "filter:drop-shadow(0 5px 8px rgba(0,0,0,.5)) drop-shadow(0 0 7px var(--gc,transparent)) drop-shadow(0 0 20px var(--gc,transparent));" +
      "animation:qLavkaGlow 3.6s ease-in-out infinite}" +
    "@keyframes qLavkaGlow{" +
      "0%,100%{filter:drop-shadow(0 5px 8px rgba(0,0,0,.5)) drop-shadow(0 0 6px var(--gc,transparent)) drop-shadow(0 0 15px var(--gc,transparent))}" +
      "50%{filter:drop-shadow(0 5px 8px rgba(0,0,0,.5)) drop-shadow(0 0 10px var(--gc,transparent)) drop-shadow(0 0 28px var(--gc,transparent))}}" +
    /* легендарная лавка — по её свечению НЕПРЕРЫВНО переливается «электричество»:
       аура плавно перетекает между фиолетовым и электрик-бело-голубым (цвета молний),
       два слоя двигаются в противофазе → энергия струится вокруг, без резких вспышек */
    ".qs-lavka.lav-lightning{animation:qLavkaBolt 3s ease-in-out infinite}" +
    "@keyframes qLavkaBolt{" +
      "0%,100%{filter:drop-shadow(0 5px 8px rgba(0,0,0,.5)) drop-shadow(0 0 6px #c07be0) drop-shadow(0 0 17px #a878ff)}" +
      "25%{filter:drop-shadow(0 5px 8px rgba(0,0,0,.5)) drop-shadow(0 0 9px #cbb0ff) drop-shadow(0 0 24px #7db8ff)}" +
      "50%{filter:drop-shadow(0 5px 8px rgba(0,0,0,.5)) drop-shadow(0 0 8px #b6e2ff) drop-shadow(0 0 21px #c07be0)}" +
      "75%{filter:drop-shadow(0 5px 8px rgba(0,0,0,.5)) drop-shadow(0 0 10px #ece0ff) drop-shadow(0 0 26px #9a6cff)}}" +
    "@media(prefers-reduced-motion:reduce){.qs-lavka{animation:none}}" +
    ".qs-fountain{position:absolute;height:calc(24% * var(--qs-fountain-scale,1));width:auto;" +
      "transform:translate(-50%,-100%);pointer-events:none;filter:drop-shadow(0 5px 9px rgba(0,0,0,.5))}" +
    ".qs-stage.place .qs-lavka,.qs-stage.place .qs-fountain{pointer-events:auto;cursor:move}" +
    // админ-подпись объекта (какая очередь) — видит только админ в расстановке
    ".qs-adm-tag{position:absolute;transform:translate(-50%,-125%);z-index:99990;pointer-events:none;" +
      "font:800 10px system-ui;color:#fff;background:rgba(20,13,7,.9);border:1px solid rgba(240,200,120,.6);" +
      "padding:2px 7px;border-radius:7px;white-space:nowrap;text-shadow:0 1px 2px #000;box-shadow:0 2px 6px rgba(0,0,0,.5)}" +
    // правая панель управления объектами сцены (только админ)
    ".qs-objp{position:fixed;right:8px;top:78px;z-index:100001;width:236px;max-height:82vh;display:flex;" +
      "flex-direction:column;background:linear-gradient(180deg,rgba(38,24,10,.98),rgba(20,12,5,.98));" +
      "border:1px solid rgba(224,162,74,.5);border-radius:12px;box-shadow:0 10px 34px rgba(0,0,0,.6);overflow:hidden}" +
    ".qs-objp-head{display:flex;align-items:center;justify-content:space-between;padding:8px 11px;cursor:default;" +
      "background:linear-gradient(180deg,#3a2610,#241608);border-bottom:1px solid rgba(224,162,74,.3);" +
      "font:800 12.5px system-ui;color:#f0c878}" +
    ".qs-objp-tog{background:none;border:0;color:#f0c878;font-size:15px;cursor:pointer;line-height:1;padding:0 4px}" +
    ".qs-objp.closed .qs-objp-body{display:none}" +
    ".qs-objp-body{overflow:auto;padding:8px}" +
    ".qs-objp-pm{width:100%;margin-bottom:8px;padding:6px;border-radius:8px;cursor:pointer;border:1px solid rgba(224,162,74,.4);" +
      "background:rgba(60,40,16,.7);color:#f6ead2;font:700 11px system-ui}" +
    ".qs-objp-pm.on{background:linear-gradient(180deg,#f3d489,#d09b2e);color:#1b1006;border-color:#f3d489}" +
    ".qs-objp-row{padding:6px 5px;border-radius:8px;margin-bottom:5px;background:rgba(255,240,200,.05);" +
      "border:1px solid rgba(224,162,74,.18)}" +
    ".qs-objp-nm{display:flex;align-items:center;gap:7px;font:700 11px system-ui;color:#ffe0a0;margin-bottom:5px}" +
    ".qs-objp-th{width:34px;height:34px;object-fit:contain;flex:0 0 auto;border-radius:6px;" +
      "background:rgba(0,0,0,.25);border:1px solid rgba(224,162,74,.25);padding:1px;" +
      "filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))}" +
    ".qs-objp-em{width:34px;height:34px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;" +
      "font-size:20px;border-radius:6px;background:rgba(0,0,0,.25);border:1px solid rgba(224,162,74,.25)}" +
    ".qs-objp-ctl{display:flex;align-items:center;gap:8px;flex-wrap:wrap}" +
    ".qs-objp-pad{display:inline-grid;grid-template-columns:repeat(3,1fr);gap:1px;justify-items:center}" +
    ".qs-objp-lr{display:flex;gap:1px;grid-column:1/4}" +
    ".qs-objp button{cursor:pointer;border:1px solid rgba(224,162,74,.35);background:rgba(30,20,9,.85);" +
      "color:#f0dcb4;border-radius:6px;font:800 11px system-ui;min-width:22px;height:22px;line-height:1;padding:0 4px}" +
    ".qs-objp button:hover{background:rgba(80,54,20,.95);color:#fff}" +
    ".qs-objp-sz{display:flex;align-items:center;gap:3px}" +
    ".qs-objp-szv{font:800 11px system-ui;color:#9fe0a0;min-width:34px;text-align:center}" +
    ".qs-objp-z{display:flex;gap:2px}" +
    ".qs-objp-z button{font-size:10px;min-width:0;padding:0 6px}" +
    ".qs-objp button.on{background:linear-gradient(180deg,#f3d489,#d09b2e);color:#1b1006;border-color:#f3d489}" +
    ".qs-objp-flip{font-size:13px}" +
    // менеджер моделей (модалка)
    ".qs-mm{padding:14px 16px 18px}" +
    ".qs-mm-lead{font-size:11.5px;line-height:1.5;color:#c9b48f;background:rgba(224,162,74,.08);" +
      "border:1px solid rgba(224,162,74,.22);border-radius:9px;padding:8px 11px;margin-bottom:6px}" +
    ".qs-mm-h{font:800 13.5px Georgia,serif;color:#ffd98a;margin:14px 0 8px;padding-bottom:5px;border-bottom:1px solid rgba(224,162,74,.25)}" +
    ".qs-mm-h:first-child{margin-top:0}" +
    ".qs-mm-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(215px,1fr));gap:9px}" +
    ".qs-mm-card{display:flex;flex-direction:column;gap:6px;padding:9px;border-radius:11px;" +
      "background:rgba(255,220,150,.05);border:1px solid rgba(224,162,74,.25)}" +
    ".qs-mm-th{width:100%;height:110px;object-fit:contain;background:rgba(0,0,0,.25);border-radius:8px}" +
    ".qs-mm-noimg{display:flex;align-items:center;justify-content:center;color:#8a795a;font-size:12px;font-style:italic}" +
    ".qs-mm-name{font:800 12.5px system-ui;color:#f6ead2}" +
    ".qs-mm-sub{font-size:10.5px;color:#a58c68}" +
    ".qs-mm-rate{font-size:10.5px;margin-top:2px;font-weight:700}" +
    ".qs-mm-rate.good{color:#8fc36a}.qs-mm-rate.mid{color:#e6c48f}.qs-mm-rate.bad{color:#ff9a86}.qs-mm-rate.na{color:#8a795a;font-weight:500;font-style:italic}" +
    ".qs-mm-btns{display:flex;flex-wrap:wrap;gap:4px}" +
    ".qs-mm-btns button{cursor:pointer;border:1px solid rgba(224,162,74,.4);background:rgba(30,20,9,.85);color:#f0dcb4;" +
      "border-radius:7px;font:700 11px system-ui;padding:5px 8px}" +
    ".qs-mm-btns button:hover{background:rgba(80,54,20,.95);color:#fff}" +
    ".qs-mm-btns button.on{background:linear-gradient(180deg,#f3d489,#d09b2e);color:#1b1006;border-color:#f3d489}" +
    ".qs-mm-btns button.danger{color:#ff9a86;border-color:rgba(255,120,100,.5)}" +
    ".qs-mm-btns button.danger:hover{background:rgba(120,30,20,.8);color:#fff}" +
    ".qs-mm-st{font-size:10.5px;color:#e0a86a;min-height:12px}" +
    ".qs-mm-empty{padding:14px;color:#8a795a;font-style:italic;text-align:center;font-size:12.5px}" +
    ".qs-mm-addp{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:0 0 10px}" +
    ".qs-mm-addp input{padding:7px 10px;font-size:13px;color:#f5ecda;background:rgba(0,0,0,.35);" +
      "border:1px solid rgba(224,162,74,.35);border-radius:8px;outline:none;min-width:150px}" +
    ".qs-mm-addbtn{cursor:pointer;border:0;border-radius:8px;padding:8px 12px;font:800 12px system-ui;" +
      "color:#1b1006;background:linear-gradient(180deg,#f3d489,#d09b2e)}" +
    ".qs-mm-addhint{flex:1 1 100%;font:600 10.5px system-ui;color:#8a795a;margin-top:2px}" +
    ".qs-mm-addv{color:#0f2a12 !important;background:linear-gradient(180deg,#a8e6a0,#5aa84a) !important;font-weight:800}" +
    ".qs-mm-addv:hover{filter:brightness(1.07)}" +
    ".qs-objp-bg{margin:2px 0 8px;padding:8px;border-radius:9px;background:rgba(40,60,90,.28);" +
      "border:1px solid rgba(130,180,240,.35);display:flex;flex-direction:column;gap:6px}" +
    ".qs-objp-bgh{font:800 11.5px system-ui;color:#bfe0ff}.qs-objp-bgh b{color:#fff}" +
    ".qs-objp-bgtime{display:flex;gap:4px}" +
    ".qs-objp-bgtime button{flex:1;font-size:11px;padding:5px 4px}" +
    ".qs-objp-bghint{font-size:9.5px;color:#9db4cc;align-self:center}" +
    ".qs-objp-repl{font-size:12px;border-color:rgba(130,200,255,.5)!important;color:#bfe0ff!important}" +
    ".qs-objp-repl:hover{background:rgba(30,60,100,.8)!important;color:#fff!important}" +
    ".qs-objp-opt{font-size:12px;border-color:rgba(150,220,150,.5)!important;color:#a8e6a0!important}" +
    ".qs-objp-opt:hover{background:rgba(30,80,30,.8)!important;color:#fff!important}" +
    ".qs-objp-del{color:#ff9a86;border-color:rgba(255,120,100,.5)!important}" +
    ".qs-objp-del:hover{background:rgba(120,30,20,.8)!important;color:#fff!important}" +
    ".qs-objp-row.hidden{opacity:.6;display:flex;align-items:center;justify-content:space-between;gap:6px}" +
    ".qs-objp-restore{cursor:pointer;border:1px solid rgba(150,220,150,.5);background:rgba(30,60,30,.6);" +
      "color:#9fe0a0;border-radius:7px;font:700 10.5px system-ui;padding:4px 8px;white-space:nowrap}" +
    ".qs-objp-restore:hover{background:rgba(40,90,40,.8);color:#fff}" +
    // блок добавления своего предмета
    ".qs-objp-add{margin-top:8px;padding:9px 8px;border-radius:9px;background:rgba(60,42,16,.5);" +
      "border:1px dashed rgba(224,162,74,.5);display:flex;flex-direction:column;gap:6px}" +
    ".qs-objp-add-h{font:800 11.5px system-ui;color:#ffe0a0}" +
    ".qs-objp-add input[type=text],.qs-objp-add-nm{width:100%;padding:6px 8px;font-size:12px;color:#f5ecda;" +
      "background:rgba(0,0,0,.35);border:1px solid rgba(224,162,74,.35);border-radius:7px;outline:none}" +
    ".qs-objp-add-f{font-size:11px;color:#d8c39f;width:100%}" +
    ".qs-objp-add-go{width:100%;padding:7px;cursor:pointer;font:800 11.5px system-ui;color:#1b1006;" +
      "background:linear-gradient(180deg,#f3d489,#d09b2e);border:0;border-radius:8px}" +
    ".qs-objp-add-go:hover{filter:brightness(1.06)}" +
    ".qs-objp-add-st{min-height:12px;font-size:10.5px;color:#e0a86a}" +
    "@media(max-width:820px){.qs-objp{position:static;right:auto;top:auto;width:100%;max-height:none;margin:10px 0}}" +
    ".qs-join{display:block;margin:6px auto 0;cursor:pointer;font:700 12px system-ui;color:#1b1006;" +
      "border:0;border-radius:9px;padding:7px 12px;background:linear-gradient(180deg,#f3d489,#d09b2e);" +
      "box-shadow:0 3px 10px rgba(245,200,120,.4)}" +
    ".qs-join.leave{background:linear-gradient(180deg,#d7a89a,#a5776b)}" +
    ".qs-join:hover{filter:brightness(1.07)}" +
    ".qs-list{display:block;margin:0 auto;cursor:pointer;font:700 11px system-ui;color:#f6ead2;" +
      "border:1px solid var(--gc);border-radius:8px;padding:4px 10px;background:rgba(20,13,7,.82);" +
      "box-shadow:0 2px 6px rgba(0,0,0,.5);text-shadow:0 1px 2px #000}" +
    ".qs-list-btn{cursor:pointer;border:0;background:none;padding:0;position:relative;display:inline-block;transition:transform .08s}" +
    ".qs-lb-normal,.qs-lb-hover{height:100px;width:auto;object-fit:contain;display:block;filter:drop-shadow(0 4px 7px rgba(0,0,0,.55))}" +
    // кнопка Встать/Выйти НА СЦЕНЕ — тумба (крупнее, чем в полосе)
    ".qs-js{cursor:pointer;border:0;background:none;padding:0;display:flex;flex-direction:column;align-items:center;gap:0;transition:filter .08s}" +
    ".qs-js-tot{position:relative;display:flex;justify-content:center;height:min(106px,11.5cqw)}" +
    ".qs-js-dim,.qs-js-lit{height:min(106px,11.5cqw);width:auto;object-fit:contain;filter:drop-shadow(0 4px 6px rgba(0,0,0,.55))}" +
    ".qs-js-lit{position:absolute;left:50%;top:0;transform:translateX(-50%);opacity:0;transition:opacity .18s}" +
    ".qs-js:hover .qs-js-lit{opacity:1}.qs-js:active{filter:brightness(.9)}" +
    // цветной ореол таблички «Встать/Выйти» — под цвет своей очереди (редкие=золото),
    // мягко пульсирует; на наведении разгорается ярче
    ".qs-js-tot{animation:qsGlow 2.8s ease-in-out infinite}" +
    ".qs-js:hover .qs-js-tot{animation:none;filter:drop-shadow(0 0 11px var(--gc,#7ec46a)) drop-shadow(0 0 24px var(--gc,#7ec46a))}" +
    "@keyframes qsGlow{0%,100%{filter:drop-shadow(0 0 6px var(--gc,#7ec46a)) drop-shadow(0 0 13px var(--gc,#7ec46a))}" +
      "50%{filter:drop-shadow(0 0 10px var(--gc,#7ec46a)) drop-shadow(0 0 21px var(--gc,#7ec46a))}}" +
    "@media(prefers-reduced-motion:reduce){.qs-js-tot{animation:none;filter:drop-shadow(0 0 8px var(--gc,#7ec46a)) drop-shadow(0 0 17px var(--gc,#7ec46a))}}" +
    ".qs-js-tx{margin-bottom:2px;font:800 11px system-ui;font-size:clamp(8px,1.2cqw,11px);color:#f6ead2;text-shadow:0 1px 3px #000,0 0 4px #000;white-space:nowrap}" +
    // счётчик-сфера НА СЦЕНЕ
    ".qs-scnt{position:relative;width:64px;line-height:0;pointer-events:auto}" +
    ".qs-scnt-bg{width:100%;height:auto;display:block;filter:drop-shadow(0 3px 5px rgba(0,0,0,.5))}" +
    ".qs-scnt-n{position:absolute;top:37%;left:50%;transform:translate(-50%,-50%);font:900 19px system-ui;" +
      "color:#7a4a10;text-shadow:0 1px 1px rgba(255,240,200,.55)}" +
    // кошелёк жетонов ТОП-3 на рамке
    ".qs-fwallet{position:absolute;transform:translate(-50%,0);line-height:0;pointer-events:none;" +
      "filter:drop-shadow(0 4px 9px rgba(0,0,0,.55))}" +
    ".qs-frame.place-on .qs-fwallet{pointer-events:auto;cursor:move}" +
    // слой всей очереди (front/back) — прозрачный, клики проходят к сцене, но люди кликабельны
    ".qs-qlayer{position:absolute;inset:0;pointer-events:none}" +
    ".qs-qlayer .qs-char{pointer-events:auto}" +
    ".qs-fw-bg{width:100%;height:auto;display:block}" +
    ".qs-fw-slot{position:absolute;left:30%;right:20%;top:33%;bottom:31%;display:flex;align-items:center;" +
      "justify-content:center;gap:1px;line-height:1}" +
    ".qs-fw-coins{display:flex;align-items:center}" +
    ".qs-fw-coin{height:20px;width:auto;margin-left:-7px;filter:drop-shadow(0 0 4px rgba(255,210,120,.7))}" +
    ".qs-fw-coin:first-child{margin-left:0}" +
    ".qs-fw-x{font:900 15px system-ui;color:#ffe4a0;margin-left:3px;text-shadow:0 1px 2px #000,0 0 5px rgba(255,200,120,.6)}" +
    ".qs-fw-0{font:900 17px system-ui;color:#e8c98a;text-shadow:0 1px 2px #000}" +
    ".qs-fw-cap{position:absolute;left:0;right:0;bottom:-15px;text-align:center;font:800 9px system-ui;" +
      "color:#f0dcb4;text-shadow:0 1px 2px #000;white-space:nowrap}" +
    ".qs-lb-hover{position:absolute;left:0;top:0;opacity:0;transition:opacity .18s}" +
    ".qs-list-btn:hover .qs-lb-hover{opacity:1}" +
    ".qs-list-btn:active{filter:brightness(.9)}" +
    /* ЕДИНАЯ ТАБЛИЧКА: сфера-счётчик (сверху) + «Посмотреть список» + свечение по наведению */
    ".qs-board{cursor:pointer;border:0;background:none;padding:0;position:relative;display:block;line-height:0;pointer-events:auto}" +
    ".qs-board-idle,.qs-board-glow{width:100%;height:auto;display:block;filter:drop-shadow(0 5px 9px rgba(0,0,0,.55))}" +
    ".qs-board-glow{position:absolute;left:0;top:0;opacity:0;transition:opacity .2s}" +
    ".qs-board:hover .qs-board-glow{opacity:1}" +
    ".qs-board:active{filter:brightness(.93)}" +
    // цветное свечение таблички «Посмотреть список» — фоном под цвет своей очереди (редкие=золото)
    ".qs-board-idle{filter:drop-shadow(0 5px 9px rgba(0,0,0,.55)) drop-shadow(0 0 7px var(--gc,#7ec46a)) drop-shadow(0 0 16px var(--gc,#7ec46a))}" +
    ".qs-board:hover .qs-board-idle{filter:drop-shadow(0 5px 9px rgba(0,0,0,.55)) drop-shadow(0 0 11px var(--gc,#7ec46a)) drop-shadow(0 0 25px var(--gc,#7ec46a))}" +
    ".qs-board-n{position:absolute;top:16%;left:50%;transform:translate(-50%,-50%);font-weight:900;font-family:system-ui;" +
      "color:#3a2208;text-shadow:0 1px 2px rgba(255,238,200,.75),0 0 5px rgba(255,200,90,.5);pointer-events:none;z-index:2;white-space:nowrap}" +
    /* мини-табличка в нижней полосе очереди (кликабельная, светится при наведении) */
    ".qs-lane-board{position:relative;display:inline-block;width:78px;flex:0 0 auto;align-self:center;margin:0 1px;line-height:0;cursor:pointer;border:0;background:none;padding:0;vertical-align:middle}" +
    ".qs-lane-board-idle,.qs-lane-board-glow{width:100%;height:auto;display:block;filter:drop-shadow(0 2px 3px rgba(0,0,0,.4))}" +
    ".qs-lane-board-idle{filter:drop-shadow(0 2px 3px rgba(0,0,0,.4)) drop-shadow(0 0 5px var(--gc,#7ec46a)) drop-shadow(0 0 11px var(--gc,#7ec46a))}" +
    ".qs-lane-board:hover .qs-lane-board-idle{filter:drop-shadow(0 2px 3px rgba(0,0,0,.4)) drop-shadow(0 0 8px var(--gc,#7ec46a)) drop-shadow(0 0 17px var(--gc,#7ec46a))}" +
    ".qs-lane-board-glow{position:absolute;left:0;top:0;opacity:0;transition:opacity .18s}" +
    ".qs-lane-board:hover .qs-lane-board-glow{opacity:1}" +
    ".qs-lane-board-n{position:absolute;top:16%;left:50%;transform:translate(-50%,-50%);font-weight:900;" +
      "font-family:system-ui;color:#3a2208;text-shadow:0 1px 1px rgba(255,238,200,.7);pointer-events:none;white-space:nowrap}" +
    /* красивая надпись «Посмотреть список» НАД табличкой при наведении (текст на плакате мелкий) */
    ".qs-board-tip,.qs-lane-board-tip{position:absolute;left:50%;bottom:100%;transform:translate(-50%,4px);" +
      "white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .16s,transform .16s;" +
      "background:linear-gradient(180deg,rgba(44,28,10,.97),rgba(24,15,6,.97));color:#ffe1a0;" +
      "font:800 14px system-ui;padding:4px 12px;border-radius:8px;border:1px solid rgba(228,182,92,.6);" +
      "box-shadow:0 4px 12px rgba(0,0,0,.55);text-shadow:0 1px 2px rgba(0,0,0,.7);z-index:20}" +
    ".qs-board:hover .qs-board-tip,.qs-lane-board:hover .qs-lane-board-tip{opacity:1;transform:translate(-50%,-3px)}" +
    ".qs-list:hover{background:rgba(40,26,12,.92);filter:brightness(1.1)}" +
    /* модалки сцены (выбор ресурса / полный список) */
    ".qs-modal-ov{position:fixed;inset:0;z-index:100000;background:rgba(8,5,2,.72);backdrop-filter:blur(3px);" +
      "display:flex;align-items:center;justify-content:center;padding:20px}" +
    ".qs-modal{max-width:580px;width:100%;max-height:92vh;overflow:auto;background:linear-gradient(180deg,#241608,#160d06);" +
      "border:1px solid rgba(224,162,74,.45);border-radius:16px;box-shadow:0 0 50px rgba(0,0,0,.7);position:relative}" +
    ".qs-modal-head{position:sticky;top:0;z-index:10;display:flex;align-items:center;justify-content:space-between;" +
      "padding:14px 18px;background:linear-gradient(180deg,#2c1c0b,#1c1207);border-bottom:1px solid rgba(224,162,74,.3);" +
      "font:700 16px Georgia,serif;color:#f0c878}" +
    ".qs-modal-x{background:none;border:0;color:#caa66a;font-size:20px;cursor:pointer;line-height:1;position:relative;z-index:11;padding:2px 6px}" +
    ".qs-modal-x:hover{color:#fff}" +
    ".qs-respick{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:8px;padding:12px}" +
    ".qs-rescard{cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:4px;padding:8px 6px;" +
      "background:rgba(0,0,0,.3);border:1px solid rgba(224,162,74,.3);border-radius:11px;color:#f6ead2;" +
      "font:700 12px system-ui;text-align:center}" +
    ".qs-rescard:hover{border-color:#f0c878;background:rgba(224,162,74,.12);transform:translateY(-2px)}" +
    ".qs-rescard.sel{border-color:#7ec46a;background:rgba(126,196,106,.16);box-shadow:0 0 0 1px #7ec46a}" +
    // мультивыбор: галочка в углу + приглушение НЕвыбранных, чтобы было очевидно что снято
    ".qs-rescard{position:relative}" +
    ".qs-rc-check{position:absolute;top:5px;right:5px;width:19px;height:19px;border-radius:6px;" +
      "border:2px solid rgba(224,162,74,.55);background:rgba(0,0,0,.35);display:flex;align-items:center;" +
      "justify-content:center;font:900 13px system-ui;color:transparent;transition:all .12s}" +
    ".qs-rescard.sel .qs-rc-check{background:#7ec46a;border-color:#7ec46a;color:#123}" +
    ".qs-rescard.sel .qs-rc-check::after{content:'✓'}" +
    ".qs-respick.multi .qs-rescard:not(.sel){opacity:.5;filter:grayscale(.45)}" +
    ".qs-respick.multi .qs-rescard:not(.sel):hover{opacity:.85;filter:none}" +
    ".qs-p2-allbar{display:flex;align-items:center;gap:8px;margin:0 0 8px;flex-wrap:wrap}" +
    ".qs-p2-mini{cursor:pointer;font:700 12px system-ui;color:#f0dcb4;padding:6px 11px;border-radius:8px;" +
      "border:1px solid rgba(224,162,74,.4);background:rgba(20,13,7,.7)}" +
    ".qs-p2-mini:hover{background:rgba(224,162,74,.14);color:#fff}.qs-p2-mini:active{transform:scale(.96)}" +
    ".qs-p2-cnt{margin-left:auto;font:700 12px system-ui;color:#8fc36a}" +
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
    ".qs-pick2-foot .qs-join{display:block;margin:0 auto;width:min(330px,82%);aspect-ratio:420/182;height:auto;min-height:0;" +
      "border:0;box-shadow:none;background:url(assets/queue/ui/btn-join-lit.webp?v=3) center/contain no-repeat;" +
      "color:#ffe8bc;font:800 15px/1.15 system-ui;text-shadow:0 1px 3px #000,0 0 5px rgba(0,0,0,.6);" +
      "padding:0 8% 0 25%;filter:drop-shadow(0 4px 9px rgba(0,0,0,.4))}" +
    ".qs-pick2-foot .qs-join:hover{filter:drop-shadow(0 4px 12px rgba(255,200,120,.4)) brightness(1.05)}" +
    ".qs-pick2 .qs-join:disabled{opacity:1;color:#c8b892;cursor:default;" +
      "background:url(assets/queue/ui/btn-join-dim.webp?v=3) center/contain no-repeat;filter:grayscale(.15)}" +
    ".qs-p2-leave{display:block;margin:9px auto 0;cursor:pointer;font:700 13px system-ui;color:#ffcdbf;" +
      "background:linear-gradient(180deg,rgba(150,60,50,.5),rgba(90,35,30,.55));border:1px solid rgba(220,110,90,.6);" +
      "border-radius:10px;padding:9px 18px}" +
    ".qs-p2-leave:hover{background:linear-gradient(180deg,rgba(180,70,55,.7),rgba(110,40,32,.7));color:#fff}" +
    ".qs-p2-leave:disabled{opacity:.6;cursor:default}" +
    // блок «активный жетон ТОП-3» в окне перевыбора обычного места — отдельная сущность, золотое свечение
    ".qs-p2-token{margin:10px 0 4px;padding:11px 13px;border-radius:12px;" +
      "background:linear-gradient(180deg,rgba(64,48,14,.72),rgba(40,28,8,.82));" +
      "border:1px solid rgba(240,205,120,.55);box-shadow:0 0 14px rgba(240,200,110,.18) inset,0 2px 10px rgba(0,0,0,.35)}" +
    ".qs-p2-token-h{font:800 13px system-ui;color:#ffe08a;text-shadow:0 0 8px rgba(255,210,110,.4);margin:0 0 3px}" +
    ".qs-p2-token-tx{font:600 12px/1.4 system-ui;color:#e8d3a0;margin:0 0 9px}" +
    ".qs-p2-token-tx b{color:#ffe6a8}" +
    ".qs-p2-token-sep{display:block;margin-top:2px;font-weight:400;color:#b39a6c;font-size:11px}" +
    ".qs-p2-token-btns{display:flex;gap:8px;flex-wrap:wrap}" +
    ".qs-p2-mini.danger{color:#ffcdbf;border-color:rgba(220,110,90,.6)}" +
    ".qs-p2-mini.danger:hover{background:rgba(180,70,55,.55);color:#fff}" +
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
    ".qs-fl-me{background:linear-gradient(90deg,rgba(126,196,106,.22),rgba(126,196,106,.05));box-shadow:inset 3px 0 0 #8fc36a}" +
    /* СПОКОЙНОЕ плавное появление только что вставшего (сцена/полоса/список) —
       мягкое проявление с лёгким подъёмом и нежным тёплым свечением, БЕЗ вспышек,
       пробегов и покачивания. Проигрывается ПОСЛЕ докрутки. */
    "@keyframes qsAppear{" +
      "0%{opacity:0;transform:translateY(6px) scale(.965);filter:drop-shadow(0 0 0 rgba(255,214,140,0))}" +
      "45%{opacity:1;filter:drop-shadow(0 0 9px rgba(255,214,140,.5))}" +
      "100%{opacity:1;transform:translateY(0) scale(1);filter:none}}" +
    ".qs-appear{animation:qsAppear 1.05s cubic-bezier(.22,.61,.36,1);" +
      "will-change:transform,filter,opacity;position:relative;z-index:4}" +
    "@media(prefers-reduced-motion:reduce){.qs-appear{animation-duration:.5s}}" +
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
    // кнопки управления записью в списке (админ: ▲▼ ✏️ ✕; игрок: изменить свои)
    ".qs-fl-adm{display:inline-flex;gap:3px;flex:0 0 auto;margin-left:4px}" +
    ".qs-fl-adm button{cursor:pointer;border:1px solid rgba(224,162,74,.4);background:rgba(20,13,7,.7);" +
      "color:#e6c48f;border-radius:6px;font:700 11px system-ui;padding:3px 6px;line-height:1}" +
    ".qs-fl-adm button:hover{background:rgba(224,162,74,.16);color:#fff}" +
    ".qs-fl-adm button:disabled{opacity:.35;cursor:default}" +
    ".qs-fl-adm button.del{color:#ff9a8a;border-color:rgba(220,110,90,.45)}" +
    ".qs-fl-adm button.del:hover{background:rgba(180,70,55,.4);color:#fff}" +
    ".qs-fl-adm button.mine{color:#8fc36a;border-color:rgba(126,196,106,.5)}" +
    ".qs-fl-adm button.mine:hover{background:rgba(126,196,106,.18);color:#fff}" +
    ".qs-fl-adm button.skin{color:#3a2600;font-weight:800;background:linear-gradient(180deg,#ffe0a0,#e0a84a);border-color:rgba(224,162,74,.6)}" +
    ".qs-fl-adm button.skin:hover{filter:brightness(1.08);color:#3a2600}" +
    ".qs-fl-row.qs-fl-mine{background:rgba(224,162,74,.08)}" +
    ".qs-char{position:absolute;height:calc(16% * var(--qs-char-scale,1) * var(--qs-mscale,1));transform-origin:bottom center;text-align:center}" +
    // ник над головой масштабируется с шириной сцены (cqw), с минимумом 7px для читаемости
    ".qs-stage .q-char-name{font-size:clamp(7px,1.14cqw,10.5px)}" +
    ".qs-stage .q-char-priv-lbl{font-size:clamp(8px,1.3cqw,12px)}" +
    ".qs-stage .qs-char-res{width:min(23px,2.5cqw);height:min(23px,2.5cqw)}" +
    ".qs-stage .qs-char-res.big{width:min(46px,5cqw);height:min(46px,5cqw)}" +
    // иконка ресурса и счётчик «+N» — В ОДИН РЯД (inline-flex), бейдж СПРАВА от иконки, не наезжает
    ".qs-char-resw{display:inline-flex;align-items:center;gap:3px;line-height:0}" +
    ".qs-char-resn{flex:0 0 auto;background:linear-gradient(180deg,#2a2a2e,#0c0c0e);" +
      "color:#ffe6a8;font:800 max(7px,0.95cqw) system-ui;padding:1px 4px;border-radius:7px;" +
      "border:1px solid rgba(232,202,120,.6);line-height:1.3;text-shadow:0 1px 1px #000}" +
    ".qs-bubble-n{flex:0 0 auto;margin-left:1px;background:linear-gradient(180deg,#2a2a2e,#0c0c0e);" +
      "color:#ffe6a8;font:800 10px system-ui;padding:1px 4px;border-radius:7px;border:1px solid rgba(232,202,120,.6);text-shadow:0 1px 1px #000}" +
    // ПРОВОДНИК: круто-тёмный бейдж «Проводник» над ником + красивое чёрное свечение вокруг
    // модельки (для любого, кто в списке проводников — и будущих тоже).
    ".q-char-guide-lbl{white-space:nowrap;font:800 9.5px system-ui;color:#ffe6a8;" +
      "background:linear-gradient(180deg,#34343c,#0b0b0e);padding:2px 9px;border-radius:8px;" +
      "border:1px solid rgba(232,202,120,.6);text-shadow:0 1px 2px #000;letter-spacing:.3px;" +
      "box-shadow:0 2px 8px rgba(0,0,0,.7),0 0 9px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,230,160,.18)}" +
    ".qs-stage .q-char-guide-lbl{font-size:clamp(7px,1.05cqw,9.5px)}" +
    ".qs-char-guide .qs-char-inner img{animation:qsGuideGlow 2.4s ease-in-out infinite}" +
    "@keyframes qsGuideGlow{0%,100%{filter:drop-shadow(0 5px 5px rgba(0,0,0,.45)) drop-shadow(0 0 5px rgba(0,0,0,.95)) drop-shadow(0 0 12px rgba(0,0,0,.8))}" +
      "50%{filter:drop-shadow(0 5px 5px rgba(0,0,0,.45)) drop-shadow(0 0 9px #000) drop-shadow(0 0 20px rgba(0,0,0,.92))}}" +
    "@media(prefers-reduced-motion:reduce){.qs-char-guide .qs-char-inner img{animation:none;filter:drop-shadow(0 5px 5px rgba(0,0,0,.45)) drop-shadow(0 0 7px #000) drop-shadow(0 0 16px rgba(0,0,0,.85))}}" +
    ".qs-char .q-char-name{position:absolute;bottom:100%;left:50%;transform:translateX(-50%);margin-bottom:2px}" +
    ".qs-char-inner{position:relative;height:100%;display:flex;align-items:flex-end;justify-content:center;" +
      "animation:qsBob 2.6s ease-in-out infinite}" +
    // кнопка смены облика на сцене — видна при наведении на свою модельку
    ".qs-skin-char{opacity:0;transition:opacity .12s;top:0;transform:scale(1.15)}" +
    ".qs-char-me:hover .qs-skin-char,.qs-char-mine-adm:hover .qs-skin-char{opacity:1}" +
    // ☠ АУРА СМЕРТИ — зловещая чёрная дымка вокруг конкретной модели (сцена/полоса/портрет)
    "@keyframes qsDeathAura{0%,100%{opacity:.6;transform:translateX(-50%) scale(1)}50%{opacity:.9;transform:translateX(-50%) scale(1.13)}}" +
    ".q-char-death .qs-char-inner{overflow:visible}" +
    ".q-char-death .qs-char-inner::before{content:'';position:absolute;left:50%;bottom:-4%;transform:translateX(-50%);" +
      "width:175%;height:150%;z-index:0;pointer-events:none;filter:blur(7px);animation:qsDeathAura 3.4s ease-in-out infinite;" +
      "background:radial-gradient(50% 52% at 50% 58%,rgba(34,0,44,.92),rgba(6,0,12,.6) 42%,rgba(0,0,0,0) 72%)}" +
    ".q-char-death .qs-char-inner img{position:relative;z-index:1;" +
      "filter:drop-shadow(0 0 9px rgba(30,0,45,.95)) drop-shadow(0 0 20px rgba(10,0,18,.8)) drop-shadow(0 5px 5px rgba(0,0,0,.55))}" +
    // в полосе (ячейка)
    ".qs-cell.death .qs-cell-mdl{overflow:visible;position:relative}" +
    ".qs-cell.death .qs-cell-mdl::before{content:'';position:absolute;left:50%;bottom:-2px;transform:translateX(-50%);" +
      "width:150%;height:135%;z-index:0;pointer-events:none;filter:blur(5px);animation:qsDeathAura 3.4s ease-in-out infinite;" +
      "background:radial-gradient(50% 52% at 50% 58%,rgba(34,0,44,.9),rgba(6,0,12,.55) 42%,rgba(0,0,0,0) 72%)}" +
    ".qs-cell.death .qs-cell-img{position:relative;z-index:1;filter:drop-shadow(0 0 7px rgba(30,0,45,.9))}" +
    // в портрете подсказки и в окне выбора облика
    ".qtip-portrait.death{background:radial-gradient(125% 88% at 50% 12%,rgba(80,0,110,.32),rgba(10,0,16,0) 60%),linear-gradient(180deg,#1c0722,#0a0410)}" +
    ".qtip-portrait.death .qtip-mdl{filter:drop-shadow(0 0 12px rgba(40,0,60,.95)) drop-shadow(0 0 22px rgba(8,0,14,.85)) drop-shadow(0 7px 11px rgba(0,0,0,.5))}" +
    ".qs-msw-pic.death{background:radial-gradient(120% 80% at 50% 10%,rgba(80,0,110,.3),rgba(10,0,16,0) 60%),linear-gradient(180deg,#1c0722,#0a0410)}" +
    ".qs-msw-pic.death .qs-msw-img{filter:drop-shadow(0 0 13px rgba(40,0,60,.95)) drop-shadow(0 0 24px rgba(8,0,14,.85)) drop-shadow(0 8px 13px rgba(0,0,0,.5))}" +
    ".qs-mm-aura.on{color:#e7d9ff !important;background:linear-gradient(180deg,#3a1050,#12061c) !important;border-color:rgba(150,60,200,.6) !important}" +
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
    ".qtip{position:fixed;z-index:2147483600;pointer-events:none;min-width:180px;max-width:230px;padding:9px 12px;border-radius:11px;" +
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
    // крупный портрет модели в подсказке (шапка-«пьедестал») + разделитель «стоит за»
    ".qtip-portrait{position:relative;margin:-9px -12px 4px;padding:12px 10px 8px;border-radius:11px 11px 0 0;" +
      "min-height:120px;display:flex;justify-content:center;align-items:flex-end;overflow:hidden;" +
      "background:radial-gradient(125% 88% at 50% 12%,rgba(255,210,130,.16),rgba(38,25,9,0) 60%)," +
      "linear-gradient(180deg,#3a2610,rgba(25,15,6,0));border-bottom:1px solid rgba(240,200,120,.22)}" +
    ".qtip-mdl{position:relative;z-index:1;max-height:150px;max-width:190px;width:auto;object-fit:contain;" +
      "filter:drop-shadow(0 7px 11px rgba(0,0,0,.55));image-rendering:auto}" +
    ".qtip-shadow{position:absolute;z-index:0;bottom:9px;left:50%;transform:translateX(-50%);width:80px;height:14px;" +
      "border-radius:50%;background:radial-gradient(50% 50% at 50% 50%,rgba(0,0,0,.55),rgba(0,0,0,0) 72%)}" +
    ".qtip-ph{color:#b8a575;font:700 12px system-ui;padding:24px 6px;text-align:center;opacity:.8}" +
    ".qtip-badge{position:absolute;top:8px;left:50%;transform:translateX(-50%);z-index:2;white-space:nowrap;" +
      "font:800 9.5px system-ui;letter-spacing:.4px;padding:2px 8px;border-radius:9px;text-shadow:0 1px 2px #000}" +
    ".qtip-badge.gold{color:#3a2600;background:linear-gradient(180deg,#ffdf8a,#e6a83a);box-shadow:0 0 10px rgba(255,200,90,.55)}" +
    ".qtip-badge.dark{color:#e7d9ff;background:linear-gradient(180deg,#2a2338,#100c1a);border:1px solid rgba(150,130,200,.5);box-shadow:0 0 10px rgba(20,16,30,.8)}" +
    ".qtip-badge.death-b{color:#e9d6ff;background:linear-gradient(180deg,#3a0f52,#0e0416);border:1px solid rgba(150,50,200,.55);box-shadow:0 0 12px rgba(60,0,90,.85)}" +
    // свечения пьедестала под тип модели: золото — ТОП-3, тёмно-фиолет — проводник
    ".qtip-portrait.priv{background:radial-gradient(125% 88% at 50% 12%,rgba(255,220,120,.3),rgba(38,25,9,0) 62%),linear-gradient(180deg,#4c3611,rgba(25,15,6,0))}" +
    ".qtip-portrait.priv .qtip-mdl{filter:drop-shadow(0 0 13px rgba(255,208,90,.5)) drop-shadow(0 7px 11px rgba(0,0,0,.5))}" +
    ".qtip-portrait.guide{background:radial-gradient(125% 88% at 50% 12%,rgba(120,95,180,.3),rgba(18,14,28,0) 62%),linear-gradient(180deg,#241a33,rgba(18,14,28,0))}" +
    ".qtip-portrait.guide .qtip-mdl{filter:drop-shadow(0 0 14px rgba(10,8,18,.9)) drop-shadow(0 0 6px rgba(60,45,110,.7)) drop-shadow(0 7px 11px rgba(0,0,0,.5))}" +
    ".qtip-divider{display:flex;align-items:center;gap:8px;margin:5px 0 2px;font:800 9px system-ui;letter-spacing:1.3px;" +
      "text-transform:uppercase;color:#b39a6c;white-space:nowrap}" +
    ".qtip-divider::before,.qtip-divider::after{content:'';flex:1;height:1px;" +
      "background:linear-gradient(90deg,rgba(240,200,120,0),rgba(240,200,120,.45),rgba(240,200,120,0))}" +
    // интерактивное окно (когда есть кнопка смены облика) — ловит курсор и клики
    ".qtip.interactive{pointer-events:auto}" +
    // кнопка «Сменить облик» прямо в окне подсказки — крупная, заметная, во всю ширину
    ".qtip-skin{margin:9px -2px 1px;cursor:pointer;font:800 12px system-ui;color:#3a2600;border:0;border-radius:9px;padding:9px 10px;" +
      "background:linear-gradient(180deg,#ffe6a8,#e0a84a);box-shadow:0 2px 8px rgba(0,0,0,.35);display:flex;align-items:center;" +
      "justify-content:center;gap:5px;letter-spacing:.2px}" +
    ".qtip-skin:hover{filter:brightness(1.07)}.qtip-skin:active{transform:scale(.97)}" +
    // ── переключатель облика (модалка) ──
    ".qs-msw{padding:6px 14px 12px;max-width:440px}" +
    ".qs-msw.saving{opacity:.6;pointer-events:none}" +
    ".qs-msw-stage{display:flex;align-items:center;justify-content:center;gap:8px}" +
    ".qs-msw-pic{position:relative;flex:1 1 auto;min-height:220px;display:flex;align-items:flex-end;justify-content:center;" +
      "border-radius:14px;overflow:hidden;padding:14px 8px 10px;" +
      "background:radial-gradient(120% 80% at 50% 10%,rgba(255,210,130,.14),rgba(35,23,8,0) 60%),linear-gradient(180deg,#3a2610,#1a1006)}" +
    ".qs-msw-img{position:relative;z-index:1;max-height:230px;max-width:100%;width:auto;object-fit:contain;" +
      "filter:drop-shadow(0 8px 13px rgba(0,0,0,.55));transition:opacity .12s}" +
    ".qs-msw-shadow{position:absolute;z-index:0;bottom:10px;left:50%;transform:translateX(-50%);width:110px;height:18px;" +
      "border-radius:50%;background:radial-gradient(50% 50% at 50% 50%,rgba(0,0,0,.55),rgba(0,0,0,0) 72%)}" +
    ".qs-msw-arw{flex:0 0 auto;width:40px;height:56px;border-radius:11px;cursor:pointer;font:800 26px system-ui;color:#ffe0a0;" +
      "background:linear-gradient(180deg,rgba(70,50,20,.7),rgba(40,26,10,.75));border:1px solid rgba(240,200,120,.5)}" +
    ".qs-msw-arw:hover{background:rgba(224,162,74,.35);color:#fff}.qs-msw-arw:active{transform:scale(.94)}" +
    ".qs-msw-label{text-align:center;margin:9px 0 4px;font:600 14px Georgia,serif;color:#ffe08a}" +
    ".qs-msw-label .qs-msw-count{margin-left:8px;font:700 11px system-ui;color:#b39a6c}" +
    ".qs-msw-thumbs{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:4px}" +
    ".qs-msw-thumb{position:relative;width:70px;height:88px;border-radius:10px;cursor:pointer;padding:4px 3px 16px;overflow:hidden;" +
      "background:linear-gradient(180deg,rgba(58,38,16,.55),rgba(30,19,8,.7));border:2px solid rgba(240,200,120,.22);" +
      "display:flex;align-items:flex-end;justify-content:center;transition:border-color .12s,transform .12s}" +
    ".qs-msw-thumb:hover{transform:translateY(-2px)}" +
    ".qs-msw-thumb.on{border-color:#ffce6a;box-shadow:0 0 12px rgba(255,200,90,.4)}" +
    ".qs-msw-thumb img{max-height:78px;max-width:100%;object-fit:contain;filter:drop-shadow(0 3px 5px rgba(0,0,0,.5))}" +
    ".qs-msw-thumb.person{border-color:rgba(120,95,180,.4)}.qs-msw-thumb.person.on{border-color:#c7a8ff;box-shadow:0 0 12px rgba(150,120,220,.45)}" +
    ".qs-msw-thumb span{position:absolute;left:0;right:0;bottom:0;padding:2px 2px 3px;font:700 8px system-ui;text-align:center;" +
      "color:#e7d6b7;background:linear-gradient(180deg,rgba(20,12,4,0),rgba(20,12,4,.92));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
    ".qs-msw-hint{margin-top:9px;font:600 11px system-ui;color:#9a8a68;text-align:center}" +
    // кнопка «сменить облик» на модельке владельца (сцена/полоса) + в панели «Моя моделька»
    ".qs-skin-btn{position:absolute;z-index:30;cursor:pointer;border:0;border-radius:50%;width:26px;height:26px;font-size:14px;line-height:1;" +
      "background:radial-gradient(circle at 50% 35%,#ffe6a8,#e0a84a);color:#3a2600;box-shadow:0 2px 7px rgba(0,0,0,.5),0 0 0 2px rgba(30,18,4,.5);" +
      "display:flex;align-items:center;justify-content:center;transition:transform .12s}" +
    ".qs-skin-btn:hover{transform:scale(1.12)}.qs-skin-btn:active{transform:scale(.95)}" +
    ".qs-gn-skin{margin-top:9px;width:100%;cursor:pointer;font:800 12.5px system-ui;color:#3a2600;padding:9px 12px;border:0;border-radius:10px;" +
      "background:linear-gradient(180deg,#ffe0a0,#e6a83a);box-shadow:0 2px 8px rgba(0,0,0,.3)}" +
    ".qs-gn-skin:hover{filter:brightness(1.06)}.qs-gn-skin .n{opacity:.7;font-weight:700}" +
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
    if (mine) openResourcePicker(b, { resource: res, resources: mine.resources, recipient: mine.recipient || "",
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
  var _tipEl = null, _tipHideT = null;
  function setupTip() {
    if (_tipEl) return;
    _tipEl = document.createElement("div");
    _tipEl.className = "qtip"; _tipEl.style.display = "none";
    document.body.appendChild(_tipEl);
    function hideNow() { _tipEl.style.display = "none"; _tipEl.classList.remove("interactive"); }
    function scheduleHide() { clearTimeout(_tipHideT); _tipHideT = setTimeout(hideNow, 280); }
    function cancelHide() { clearTimeout(_tipHideT); }
    function place(t) {
      var r = t.getBoundingClientRect();
      _tipEl.style.display = "flex"; _tipEl.classList.remove("below");
      var tw = _tipEl.offsetWidth, th = _tipEl.offsetHeight;
      var x = Math.max(6, Math.min(r.left + r.width / 2 - tw / 2, window.innerWidth - tw - 6));
      var y = r.top - th - 10;
      if (y < 6) { y = r.bottom + 10; _tipEl.classList.add("below"); }   // не влезло сверху → снизу
      // высокий портрет не должен уезжать за низ экрана — прижимаем в видимую область
      y = Math.max(6, Math.min(y, window.innerHeight - th - 6));
      _tipEl.style.left = x + "px"; _tipEl.style.top = y + "px";
    }
    document.addEventListener("mouseover", function (e) {
      var t = e.target.closest && e.target.closest("[data-tip]");
      if (!t) return;
      cancelHide();
      _tipEl.innerHTML = t.getAttribute("data-tip");
      // окно становится КЛИКАБЕЛЬНЫМ, только если внутри есть кнопка (смена облика) — иначе не мешает
      _tipEl.classList.toggle("interactive", !!_tipEl.querySelector(".qtip-skin"));
      place(t);
    });
    document.addEventListener("mouseout", function (e) {
      var t = e.target.closest && e.target.closest("[data-tip]");
      if (!t) return;
      if (e.relatedTarget && t.contains(e.relatedTarget)) return;                 // ушли внутрь той же модельки
      if (e.relatedTarget && _tipEl.contains(e.relatedTarget)) { cancelHide(); return; }  // ушли В подсказку
      scheduleHide();   // задержка — успеть довести курсор до кнопки в окне
    });
    _tipEl.addEventListener("mouseenter", cancelHide);
    _tipEl.addEventListener("mouseleave", scheduleHide);
    // клик по кнопке смены облика в окне → открыть переключатель для этой записи
    _tipEl.addEventListener("click", function (e) {
      var btn = e.target.closest(".qtip-skin"); if (!btn) return;
      var eid = +btn.getAttribute("data-eid"), ent = null;
      (_lastState.queues || []).forEach(function (arr) { (arr || []).forEach(function (x) { if (x.id === eid) ent = x; }); });
      hideNow(); if (ent) openModelSwitcher(ent);
    });
    window.addEventListener("scroll", function () { if (_tipEl) hideNow(); }, true);
  }

  // ── одна моделька на сцене: позиция %, масштаб по глубине (ниже=крупнее), y-сортировка ──
  function renderChar(e, p, meCanon, boothQ, idx) {
    // Перспектива (ниже на экране = ближе = крупнее) × глобальный размер моделей на
    // сцене (админ-слайдер «Размер моделей»). Даже при уменьшении дефолта перспектива
    // сохраняется — дальние всё равно мельче ближних. Полосу внизу это не затрагивает.
    var scale = (0.5 + (p.y / 100) * 0.62) * getSize("models", 1);
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
    el.className = "qs-char" + (mine ? " q-char-me" : "") + (e.privileged ? " q-char-priv" : "") + (e.is_shooter ? " qs-char-guide" : "") + (modelAura(e) === "death" ? " q-char-death" : "");
    el.dataset.q = boothQ;   // очередь этой модельки — чтобы анимировать ИМЕННО ту, куда встал
    el.dataset.id = e.id || "";
    if (mi) el.dataset.mkey = mi.key;   // для точечной регулировки размера этой модели
    var mscale = (mi && MODEL_SETTINGS[mi.key] && +MODEL_SETTINGS[mi.key].scale) || 1;
    el.style.cssText = "left:" + p.x.toFixed(2) + "%;top:" + p.y.toFixed(2) + "%;--qs-mscale:" + mscale + ";" +
      "transform:translate(-50%,-100%) scale(" + scale.toFixed(3) + ");z-index:" + (e.privileged ? 8800 : Math.round(p.y * 12)) + ";";
    // всплывающая подсказка (ник + ресурс, для привилегии — пояснение)
    el.setAttribute("data-tip", tipHtml(e));
    // над головой (сверху вниз): ресурс(ы) → метка ТОП-3 → ник. Обычная/редкая — мультивыбор:
    // показываем первый ресурс + «+N», полный список — в подсказке (tipHtml).
    var resList = (e.resources && e.resources.length) ? e.resources : (e.resource ? [e.resource] : []);
    var resIcon = resList.length
      ? '<span class="qs-char-resw">' +
          '<img class="qs-char-res' + (resList[0] === "mount-cilin" ? " big" : "") + '" src="' + resImg(resList[0]) + '" alt="" title="">' +
          (resList.length > 1 ? '<span class="qs-char-resn">+' + (resList.length - 1) + "</span>" : "") +
        "</span>"
      : "";
    el.innerHTML =
      (_isAdmin ? '<button class="q-char-x" title="Убрать">✕</button>' : "") +
      '<div class="q-char-head">' +
        resIcon +                                        // ресурс — САМЫЙ ВЕРХ
        (e.privileged ? '<div class="q-char-priv-lbl">⚡ Жетон ТОП-3</div>' : "") +   // жетон вне очереди — только если применён, выше «Проводника»
        (e.is_shooter ? '<div class="q-char-guide-lbl">✦ Проводник</div>' : "") +    // «Проводник» — прямо над ником
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
  function openResourcePicker(b, edit, presel, src) {   // src: 'scene' (список) | 'lane' (полоса)
    var isPriv = !!(edit && edit.privileged);                 // меняем ресурс жетона ТОП-3 (отдельная запись)
    var items = (BOOTH_ITEMS[b.q] || []).filter(function (it) {
      return !isPriv || (REWARDS_META[it] || {}).mode !== "pack";   // жетон — только обычные стаковые
    });
    // Обычная (0) и редкая (1) очередь — МУЛЬТИвыбор (каждый ресурс по стаку). Легендарная (2)
    // и жетон ТОП-3 — один ресурс (как раньше).
    var multi = (b.q === 0 || b.q === 1) && !isPriv;
    var sel = edit ? (edit.resource || "") : (presel || "");  // одиночный (q2/жетон)
    var selSet = {};                                          // мульти-выбор (q0/q1)
    if (multi) {
      var pre = (edit && edit.resources && edit.resources.length) ? edit.resources
              : (edit && edit.resource ? [edit.resource] : items.slice());   // новый вход → все выбраны
      pre.forEach(function (x) { if (items.indexOf(x) >= 0) selSet[x] = true; });
    }
    var planArr = (edit && edit.plan ? edit.plan.slice() : []);
    // Если человек ОДНОВРЕМЕННО взял жетоном ТОП-3 (отдельная запись вне очереди) — покажем это
    // прямо в окне перевыбора обычного места, чтобы было ясно: место в очереди и жетон — РАЗНЫЕ вещи.
    // Показываем только когда правим СВОЁ обычное место (не в жетонном окне, не в админ-правке чужого).
    var _isAdminAs = _isAdmin && !_meAcc;                                  // админ тестирует как Лирия!
    var _selfCanon = _meAcc ? canon(_meAcc.main_nick) : (_isAdminAs ? canon(ADMIN_NICK) : "");
    var myPrivE = null;
    if (!isPriv && !(edit && edit.adminEid) && _selfCanon) {
      ((_lastState && _lastState.queues && _lastState.queues[b.q]) || []).forEach(function (e) {
        if (e.privileged && canon(e.main_nick) === _selfCanon) myPrivE = e;
      });
    }
    var _tokAmt = myPrivE ? ((myPrivE.priv_stacks || 1) * ((REWARDS_META[myPrivE.resource] || {}).unit || 0)) : 0;
    var tokenBlock = myPrivE
      ? '<div class="qs-p2-token">' +
          '<div class="qs-p2-token-h">⚡ У тебя активен жетон ТОП-3</div>' +
          '<div class="qs-p2-token-tx">Берёшь <b>ВНЕ очереди</b>: ' + esc(resName(myPrivE.resource)) +
            (_tokAmt ? ' <b>×' + _tokAmt + '</b>' : "") +
            '<span class="qs-p2-token-sep">Это отдельно от твоего места в очереди — оно остаётся ниже. Жетон можно сменить или вернуть в кошелёк.</span></div>' +
          '<div class="qs-p2-token-btns">' +
            '<button type="button" id="qs-tok-res" class="qs-p2-mini">✎ Сменить ресурс жетона</button>' +
            '<button type="button" id="qs-tok-back" class="qs-p2-mini danger">↩️ Вернуть жетон</button>' +
          "</div></div>"
      : "";
    var body = document.createElement("div");
    body.className = "qs-pick2";
    var defRcpt = edit ? (edit.recipient || "")
      : (SPOUSE_BY_NICK[canon(_meAcc && _meAcc.main_nick)] || "");
    var planOpts = items.map(function (it) { return '<option value="' + esc(it) + '">' + esc(resName(it)) + "</option>"; }).join("");
    // необязательные настройки открыты сразу только если они уже заданы (правка)
    var openMore = !!(edit && (edit.recipient || edit.auto_repeat || (edit.plan && edit.plan.length)));
    body.innerHTML =
      tokenBlock +
      '<div class="qs-p2-lbl">' + (myPrivE ? "Твоё место в очереди — " : "") + (multi ? (myPrivE ? "о" : "1 · О") + "тметь нужные ресурсы <span style=\"color:#8a795a;font-weight:400\">(нажми на карточку, чтобы убрать или вернуть — каждый по 1 стаку)</span>:" : (myPrivE ? "в" : "1 · В") + "ыбери ресурс:") + "</div>" +
      (multi ? '<div class="qs-p2-allbar"><button type="button" id="qs-p2-all" class="qs-p2-mini">✓ Выбрать все</button>' +
        '<button type="button" id="qs-p2-none" class="qs-p2-mini">✕ Снять все</button><span class="qs-p2-cnt" id="qs-p2-cnt"></span></div>' : "") +
      '<div class="qs-respick' + (multi ? " multi" : "") + '" id="qs-p2-grid"></div>' +
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
      '<div class="qs-pick2-foot"><button class="qs-join" id="qs-p2-go"></button>' +
        ((edit && edit.adminEid) ? ""
          : isPriv ? '<button type="button" class="qs-p2-leave" id="qs-p2-leave">↩️ Вернуть жетон в кошелёк</button>'
          : edit ? '<button type="button" class="qs-p2-leave" id="qs-p2-leave">🚪 Выйти из очереди</button>' : "") +
      "</div>";
    // карточки-выбор
    var grid = body.querySelector("#qs-p2-grid");
    function paintCards() {
      [].forEach.call(grid.children, function (c) {
        var r = c.dataset.res;
        c.classList.toggle("sel", multi ? !!selSet[r] : (r === sel));
      });
      var go = body.querySelector("#qs-p2-go");
      var n = multi ? Object.keys(selSet).length : (sel ? 1 : 0);
      var cnt = body.querySelector("#qs-p2-cnt");
      if (cnt) cnt.textContent = "Отмечено: " + n + " из " + items.length;
      // мульти: нужен минимум 1 ресурс (пустой список = «все», поэтому 0 не даём сохранить).
      go.textContent = (multi && n === 0) ? "Выбери хотя бы 1 ресурс"
        : edit ? (multi ? "💾 Сохранить (" + n + ")" : "💾 Сохранить")
        : (n ? (multi ? ("Встать за " + n + " ресурс" + (n === 1 ? "ом" : "ами")) : "Встать в очередь") : "Сначала выбери ресурс");
      go.disabled = multi ? (n === 0) : (!sel && !edit);
      var warn = body.querySelector("#qs-res-warn");        // предупреждения по «капризным» ресурсам
      if (warn) {
        var wr = (multi ? Object.keys(selSet) : (sel ? [sel] : [])).filter(function (r) { return RES_WARN[r]; });
        if (wr.length) {
          warn.innerHTML = wr.map(function (r) { return "⚠️ <b>" + esc(resName(r)) + ".</b> " + esc(RES_WARN[r]); }).join("<br>");
          warn.style.display = "block";
        } else warn.style.display = "none";
      }
    }
    items.forEach(function (it) {
      var card = document.createElement("button");
      card.className = "qs-rescard"; card.dataset.res = it; card.type = "button";
      var rm = REWARDS_META[it] || {};
      var stack = rm.text ? '<span class="qs-rc-stack">' + esc(rm.text) + "</span>" : "";
      var total = (rm.total != null && rm.total > 0) ? '<span class="qs-rc-total">накоплено: ' + rm.total + "</span>" : "";
      card.innerHTML = (multi ? '<span class="qs-rc-check" aria-hidden="true"></span>' : "") +
        '<img src="' + resImg(it) + '" alt="" loading="lazy"><span class="qs-rc-name">' + esc(resName(it)) + "</span>" + stack + total;
      card.addEventListener("click", function () {
        if (multi) { if (selSet[it]) delete selSet[it]; else selSet[it] = true; }
        else { sel = it; }
        paintCards();
      });
      grid.appendChild(card);
    });
    // мульти: быстрые кнопки «Выбрать все / Снять все» (снял все → отметь нужные, минимум 1)
    if (multi) {
      var allBtn = body.querySelector("#qs-p2-all"), noneBtn = body.querySelector("#qs-p2-none");
      if (allBtn) allBtn.addEventListener("click", function () { items.forEach(function (x) { selSet[x] = true; }); paintCards(); });
      if (noneBtn) noneBtn.addEventListener("click", function () { selSet = {}; paintCards(); });
    }
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
    var m = sceneModal(((edit && edit.adminEid) ? "Сменить ресурсы игрока — очередь «" : isPriv ? "⚡ Жетон ТОП-3 — сменить ресурс или вернуть — «" : edit ? "Изменить ресурсы или выйти — очередь «" : "Встать в очередь — «") + b.title + "»", body);
    paintCards();
    // Блок «активный жетон ТОП-3»: сменить ресурс жетона / вернуть жетон (отдельно от места в очереди)
    var tokResBtn = body.querySelector("#qs-tok-res");
    if (tokResBtn) tokResBtn.addEventListener("click", function () {
      if (m) m.close();
      openResourcePicker(b, { privileged: true, resource: (myPrivE && myPrivE.resource) || "",
        recipient: (myPrivE && myPrivE.recipient) || "",
        adminPriv: (_isAdminAs && myPrivE) ? myPrivE.id : null }, null, src);   // админ — правка по id
    });
    var tokBackBtn = body.querySelector("#qs-tok-back");
    if (tokBackBtn) tokBackBtn.addEventListener("click", function () {
      if (!confirm("Вернуть жетон ТОП-3 в кошелёк? Твоя запись ВНЕ очереди пропадёт, жетон вернётся. Место в обычной очереди останется.")) return;
      if (m) m.close();
      var pth = _isAdminAs ? "/queue/admin/leave-as" : "/queue/leave";
      var pl = _isAdminAs ? { nick: ADMIN_NICK, queue: b.q, privileged: true } : { queue: b.q, privileged: true };
      q("POST", pth, pl).then(refresh)
        .catch(function (e2) { alert(e2.status === 401 ? "Сессия истекла, войди заново." : ("Ошибка: " + (e2.detail || e2.message))); });
    });
    // Нижняя кнопка: «Выйти из очереди» (обычное место) ИЛИ «Вернуть жетон» (жетонное окно) — с подтверждением
    var leaveBtn = body.querySelector("#qs-p2-leave");
    if (leaveBtn) leaveBtn.addEventListener("click", function () {
      if (isPriv) {   // жетонное окно → вернуть жетон в кошелёк (возврат жетона на бэке)
        if (!confirm("Вернуть жетон ТОП-3 в кошелёк? Запись ВНЕ очереди пропадёт, жетон вернётся.")) return;
        leaveBtn.disabled = true; if (m) m.close();
        var lpth = _isAdminAs ? "/queue/admin/leave-as" : "/queue/leave";
        var lpl = _isAdminAs ? { nick: ADMIN_NICK, queue: b.q, privileged: true } : { queue: b.q, privileged: true };
        q("POST", lpth, lpl).then(refresh).catch(function (e2) {
          leaveBtn.disabled = false;
          alert(e2.status === 401 ? "Сессия истекла, войди заново." : ("Ошибка: " + (e2.detail || e2.message)));
        });
        return;
      }
      if (!confirm("Выйти из очереди «" + b.title + "»? Ты потеряешь своё место в ней.")) return;
      leaveBtn.disabled = true;
      if (m) m.close();
      if (_isAdminAs) {   // админ-тест: убрать ТОЛЬКО обычное место Лирии (жетон, если есть, остаётся)
        q("POST", "/queue/admin/leave-as", { nick: ADMIN_NICK, queue: b.q, privileged: false }).then(refresh)
          .catch(function (e2) { alert("Ошибка: " + (e2.detail || e2.message)); });
        return;
      }
      q("POST", "/queue/leave", { queue: b.q }).then(refresh).catch(function (e2) {
        alert(e2.status === 401 ? "Сессия истекла, войди заново." : ("Ошибка: " + (e2.detail || e2.message)));
      });
    });
    // commit
    body.querySelector("#qs-p2-go").addEventListener("click", function () {
      var resources = multi ? Object.keys(selSet) : null;
      var resource = multi ? (resources[0] || "") : sel;
      if (!edit && (multi ? !resources.length : !resource)) { return; }
      var rcpt = (rcptEl.value || "").trim();
      if (rcpt && recipientRel(rcpt) === "other" &&
          !confirm("«" + rcpt + "» не твин и не супруг. Всё равно передать ресурс ему?")) return;
      if (m) m.close();
      // АДМИН меняет ресурсы чужой записи (по id) — через админ-эндпоинт
      if (edit && edit.adminEid) {
        var ap = { entry_id: edit.adminEid };
        if (multi) ap.resources = resources; else ap.resource = resource;
        q("POST", "/queue/admin/set-entry", ap).then(refresh).catch(function (e2) { alert("Ошибка: " + (e2.detail || e2.message)); });
        return;
      }
      // смена ресурса ЖЕТОННОЙ записи (отдельная, privileged=1) — всегда один ресурс
      if (isPriv) {
        if (edit && edit.adminPriv) {   // админ-тест: правим жетон Лирии по id записи
          q("POST", "/queue/admin/set-entry", { entry_id: edit.adminPriv, resource: resource })
            .then(refresh).catch(function (e2) { alert("Ошибка: " + (e2.detail || e2.message)); });
          return;
        }
        q("POST", "/queue/set-entry", { queue: b.q, resource: resource, privileged: true })
          .then(refresh).catch(function (e2) { alert(e2.status === 400 ? "Жетоном — только обычные ресурсы." : ("Ошибка: " + (e2.detail || e2.message))); });
        return;
      }
      // Админ без игрового аккаунта встаёт/меняет ресурсы ОТ ИМЕНИ Лирия! (тест)
      if (_isAdmin && !_meAcc) {
        var aj = { nick: ADMIN_NICK, queue: b.q, recipient: rcpt };
        if (multi) aj.resources = resources; else aj.resource = resource;
        q("POST", "/queue/admin/join-as", aj)
          .then(function () { _justJoined = { q: b.q, canon: canon(ADMIN_NICK), src: src || "scene" }; refresh(); })
          .catch(function (e2) { alert("Ошибка: " + (e2.detail || e2.message)); });
        return;
      }
      var payload = { queue: b.q, recipient: rcpt,
                      auto_repeat: body.querySelector("#qs-repeat").checked, plan: planArr };
      if (multi) payload.resources = resources; else payload.resource = resource;
      var path = edit ? "/queue/set-entry" : "/queue/join";
      q("POST", path, payload).then(function () {
        if (!edit && _meAcc) _justJoined = { q: b.q, canon: canon(_meAcc.main_nick), src: src || "scene" };
        refresh();
      }).catch(function (e2) {
        alert(e2.status === 409 ? "Ты уже стоишь в этой очереди." :
              e2.status === 401 ? "Сессия истекла, войди заново." :
              e2.status === 404 ? "Тебя нет в этой очереди." : ("Ошибка: " + (e2.detail || e2.message)));
      });
    });
  }
  // полный список очереди (все — они же на сцене и в полосе) с модельками
  function openFullList(b, entries, focusIdx) {
    var meCanon = _meAcc ? canon(_meAcc.main_nick) : "";
    var body = document.createElement("div");
    body.className = "qs-fulllist";
    if (!entries.length) {
      body.innerHTML = '<div style="padding:22px;text-align:center;color:#c9b48f">Очередь пуста.</div>';
    } else { var flLimit = Math.max(1, Math.round(getSize("limit", 6)));
      entries.forEach(function (e, i) {
      var mi = modelInfo(e), waiting = i >= flLimit;   // за лимитом показа = ждёт (не на сцене)
      var isMine = !!(meCanon && canon(e.main_nick) === meCanon && !e.privileged);
      var rl = (e.resources && e.resources.length) ? e.resources : (e.resource ? [e.resource] : []);
      var resHtml = rl.length
        ? '<img class="qs-fl-res" src="' + resImg(rl[0]) + '" title="' + esc(rl.map(resName).join(", ")) + '" alt="">' +
          '<span class="qs-fl-rname">' + esc(resName(rl[0])) + (rl.length > 1 ? ' <b>+' + (rl.length - 1) + "</b>" : "") + "</span>"
        : '<span class="qs-fl-rname" style="opacity:.5">— ресурс не выбран</span>';
      // кнопка смены облика — своя моделька (игрок/админ-тест) ИЛИ любой админ (меняет всем), если обликов несколько
      var skinBtn = ((isMyModel(e) || _isAdmin) && modelVariants(e).length > 1)
        ? '<button data-act="skin" class="skin" title="сменить облик модельки">🔄 облик</button>' : "";
      var ctrls = "";
      if (_isAdmin) {                                   // админ-управление записью
        ctrls = '<span class="qs-fl-adm">' +
          '<button data-act="up"' + (i === 0 ? " disabled" : "") + ' title="выше">▲</button>' +
          '<button data-act="down"' + (i === entries.length - 1 ? " disabled" : "") + ' title="ниже">▼</button>' +
          (!e.privileged ? '<button data-act="res" title="сменить ресурсы">✏️</button>' : "") +
          skinBtn +
          '<button data-act="del" class="del" title="убрать">✕</button></span>';
      } else if (isMine) {                              // игрок — изменить свои ресурсы / облик
        ctrls = '<span class="qs-fl-adm"><button data-act="mine" class="mine" title="изменить мои ресурсы">✏️ изменить</button>' +
          skinBtn + "</span>";
      } else if (skinBtn) {                             // своя моделька без прочих кнопок (напр. чужая очередь)
        ctrls = '<span class="qs-fl-adm">' + skinBtn + "</span>";
      }
      var row = document.createElement("div");
      row.className = "qs-fl-row" + (waiting ? " waiting" : "") + (i === focusIdx ? " qs-fl-me" : "") + (isMine ? " qs-fl-mine" : "");
      row.dataset.idx = i;
      row.innerHTML =
        '<span class="qs-fl-num">' + (i + 1) + "</span>" +
        (mi ? '<img class="qs-fl-mdl" src="' + esc(mi.url) + '" alt="">' : '<span class="qs-fl-mdl ph">?</span>') +
        '<span class="qs-fl-nick">' + esc(e.nick) + "</span>" +
        resHtml +
        (e.recipient ? '<span class="qs-fl-rcpt" title="кому передать"' +
            (e.recipient_ok === false ? ' style="color:#e0a86a;border-color:rgba(224,168,106,.5);background:rgba(224,168,106,.12)"' : "") +
            '>→ ' + esc(e.recipient) + (e.recipient_ok === false ? " ⚠" : "") + "</span>" : "") +
        '<span class="qs-fl-flags">' +
          (e.auto_repeat ? '<span class="qs-fl-flag" style="background:rgba(126,196,106,.16);color:#8fc36a" title="повторяет каждую неделю">🔁</span>' : "") +
          (e.auto_plan && e.auto_plan.length ? '<span class="qs-fl-flag" style="background:rgba(224,162,74,.16);color:#e6c48f" title="план на ' + e.auto_plan.length + ' нед.">📅' + e.auto_plan.length + "</span>" : "") +
        "</span>" +
        (waiting ? '<span class="qs-fl-tag wait">ждёт</span>' : '<span class="qs-fl-tag shown">на сцене</span>') +
        ctrls;
      body.appendChild(row);
    }); }
    autoCropAll(body, ".qs-fl-mdl");
    var m = sceneModal("Очередь «" + b.title + "» — всего " + entries.length + " чел." + (_isAdmin ? " · управление" : ""), body);
    // клики по кнопкам управления (админ: двигать/сменить ресурсы/убрать; игрок: изменить свои)
    body.addEventListener("click", function (ev) {
      var btn = ev.target.closest("[data-act]"); if (!btn) return;
      var act = btn.dataset.act, rowEl = btn.closest(".qs-fl-row");
      var idx = rowEl ? +rowEl.dataset.idx : -1, e = entries[idx];
      if (!e) return;
      if (act === "up" || act === "down") {
        q("POST", "/queue/admin/move", { entry_id: e.id, queue: b.q, position: Math.max(0, idx + (act === "up" ? -1 : 1)) })
          .then(function () { if (m) m.close(); refresh(); }).catch(admErr);
      } else if (act === "del") {
        if (!confirm("Убрать «" + e.nick + "» из очереди?")) return;
        q("POST", "/queue/admin/remove", { entry_id: e.id }).then(function () { if (m) m.close(); refresh(); }).catch(admErr);
      } else if (act === "res") {   // админ меняет ресурсы записи
        if (m) m.close();
        openResourcePicker(b, { adminEid: e.id, resource: e.resource || "", resources: e.resources,
          recipient: e.recipient || "", auto_repeat: e.auto_repeat, plan: e.auto_plan || [] });
      } else if (act === "mine") {  // игрок меняет свои ресурсы
        if (m) m.close();
        openResourcePicker(b, { resource: e.resource || "", resources: e.resources,
          recipient: e.recipient || "", auto_repeat: e.auto_repeat, plan: e.auto_plan || [] });
      } else if (act === "skin") {  // сменить облик своей модельки
        if (m) m.close();
        openModelSwitcher(e);
      }
    });
    // только что встал и за лимитом показа → промотать список к своей строке + анимация появления
    if (focusIdx != null && focusIdx >= 0) {
      setTimeout(function () {
        var me = body.querySelector(".qs-fl-me");
        if (me) {
          var modal = body.closest(".qs-modal");
          me.scrollIntoView({ behavior: "smooth", block: "center" });
          // СНАЧАЛА список докручивается вниз, ПОТОМ — анимация появления строки
          if (modal) whenScrollSettles(modal, "scrollTop", function () { playAppear(me); }, 1200);
          else setTimeout(function () { playAppear(me); }, 400);
        }
      }, 160);
    }
  }

  // ── сцена: рамка + фон день/ночь + будки (свечение, предметы, счётчик, кнопка) + модельки ──
  function renderStage(state) {
    var frame = document.createElement("div");
    frame.className = "qs-frame" + (_placeMode ? " place-on" : "");
    var stage = document.createElement("div");
    stage.className = "qs-stage " + (isNight() ? "night" : "day") + (_isAdmin ? " admin" : "") + (_placeMode ? " place" : "");
    stage.style.setProperty("--qs-char-scale", getSize("char", 1));
    stage.style.setProperty("--qs-mount-scale", getSize("mount", 1));
    stage.style.setProperty("--qs-merch-scale", getSize("merch", 1));
    stage.style.setProperty("--qs-lavka-scale", getSize("lavka", 1));
    stage.style.setProperty("--qs-fountain-scale", getSize("fountain", 1));
    stage.style.inset = getSize("inset", 15) + "%";   // край рамки (сохраняется, макс ~15.5%)
    // центральная картинка (фон день/ночь): загруженная замена + зум/сдвиг, если заданы
    var bgSlot = isNight() ? "bg-night" : "bg-day";
    var bgOv = uploadedUrl(overrideKey(bgSlot));
    if (bgOv) stage.style.backgroundImage = "url('" + bgOv + "')";
    var bgZ = parseFloat(CONFIG["bgzoom:" + bgSlot]);
    if (isFinite(bgZ) && bgZ > 0 && bgZ !== 100) {
      stage.style.backgroundSize = bgZ.toFixed(0) + "% " + bgZ.toFixed(0) + "%";
      stage.style.backgroundPosition = (CONFIG["bgx:" + bgSlot] || "50") + "% " + (CONFIG["bgy:" + bgSlot] || "50") + "%";
    }
    var meCanon = _meAcc ? canon(_meAcc.main_nick) : "";

    BOOTHS.forEach(function (b) {
      var entries = state.queues[b.q] || [];
      // свечение будки
      var glow = document.createElement("div");
      glow.className = "qs-glow";
      glow.style.cssText = "left:" + b.bx + "%;top:" + b.by + "%;--gc:" + b.accent;
      stage.appendChild(glow);
      // лавка (торговый прилавок) этой очереди — перекрывает старые будки, день и ночь.
      // Перетаскивается; размер через getSize("lavka"); слой front/back правым кликом.
      if (!isHidden("lavka:" + b.q)) {
      var lkpos = placedPos("lavka:" + b.q, b.merchant.x, b.merchant.y + 3);
      var lavka = document.createElement("img");
      lavka.className = "qs-lavka" + (b.lightning ? " lav-lightning" : "");
      lavka.alt = ""; lavka.decoding = "async"; lavka.loading = "lazy";
      lavka.src = objImgSrc("lavka:" + b.q, "assets/queue/scene/lavka-" + b.q + ".webp?v=4");
      lavka.style.cssText = "left:" + lkpos.x.toFixed(2) + "%;top:" + lkpos.y.toFixed(2) +
        "%;height:calc(30% * " + objSize("lavka:" + b.q, getSize("lavka", 1)).toFixed(3) +
        ");z-index:" + zOf("lavka:" + b.q, lkpos.y) +
        ";transform:" + flipTf("lavka:" + b.q, "translate(-50%,-100%)") +
        ";--gc:" + (b.glow || b.accent);   // цвет свечения лавки (редкие=золото)
      if (_placeMode) makeDraggable(lavka, "lavka:" + b.q);
      stage.appendChild(lavka);
      if (_isAdmin && _placeMode) stage.appendChild(admTag(lkpos, "Лавка · " + b.title));
      }
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
      // ЛИМИТ показа: на сцене рисуем только первых N (у будки) по админ-настройке,
      // даже если в очереди сотни. Остальные — в очереди (счётчик/список), но не на картинке.
      var showLimit = Math.max(1, Math.round(getSize("limit", 6)));
      var visible = entries.slice(0, showLimit);    // передняя часть очереди
      var shown = visible.length;                   // на сцене — не больше лимита
      // слой всей очереди: front/back переносит ВСЕХ людей очереди (с предметами над головами)
      // на передний/задний план; auto — обычная глубина по y (люди вперемешку с объектами).
      var qz = CONFIG["qz:" + b.q] || "";
      var charTarget = stage;
      if (qz === "front" || qz === "back") {
        var qlayer = document.createElement("div");
        qlayer.className = "qs-qlayer";
        qlayer.style.cssText = "z-index:" + (qz === "front" ? 9500 : 2);
        stage.appendChild(qlayer);
        charTarget = qlayer;
      }
      visible.forEach(function (e, i) {
        // передний (i=0, дошёл до лавок) стоит РОВНО на финишном круге (t=1, как qs-endspot),
        // в т.ч. когда в очереди всего один человек; остальные — назад по пути.
        var t = shown <= 1 ? 1 : 1 - (i / (shown - 1)) * spread;
        charTarget.appendChild(renderChar(e, pathPoint(pth, t), meCanon, b.q, i));
      });
      // UI: кнопки «Список», «Встать/Выйти» и (когда стоишь) «✎ ресурс/кому».
      // Каждую можно перетащить (в режиме «Расставить предметы»); позиция сохраняется.
      var myEntry = null, myPriv = null;
      // «в очереди» = ОБЫЧНОЕ место; жетонную (privileged) запись учитываем отдельно,
      // НО кнопка тоже краснеет, если стоишь через жетон ТОП-3 (Лир, 2026-07-19).
      entries.forEach(function (e) {
        if (canon(e.main_nick) === meCanon) { if (e.privileged) myPriv = e; else myEntry = e; }
      });
      var iAmIn = !!myEntry, iAmPriv = !!myPriv;
      var adminCanon = (_isAdmin && !_meAcc) ? canon(ADMIN_NICK) : "";   // админ тестирует как Лирия!
      // ОБЫЧНОЕ место Лирии и её жетон — считаем раздельно (как у игрока iAmIn/iAmPriv)
      var adminRegIn = adminCanon && entries.some(function (e) { return canon(e.main_nick) === adminCanon && !e.privileged; });
      var adminPrivIn = adminCanon && entries.some(function (e) { return canon(e.main_nick) === adminCanon && e.privileged; });
      // Красная «Выйти» — только для ОБЫЧНОГО места (и админ-теста). Жетон ТОП-3 — отдельная
      // сущность (светящийся клон + панель «Взять вне очереди»), обычную кнопку не перекрашивает.
      var showLeave = iAmIn || adminRegIn;
      // Кнопка «Список» объединена с шаром-счётчиком в единую ТАБЛИЧКУ (ниже, ключ cnt:).
      // кнопка «Встать/Выйти» на СЦЕНЕ — тумба-указатель. По умолчанию — в НАЧАЛЕ (хвосте)
      // очереди (перетаскивается в режиме расстановки).
      if (!isHidden("btn-join:" + b.q)) {
      var qStart = pathPoint(pth, 0);
      var jp = placedPos("btn-join:" + b.q, qStart.x - 6, qStart.y + 3);
      var joinBtn = document.createElement("button");
      joinBtn.className = "qs-js qs-btn-abs" + (showLeave ? " leave" : "");
      // масштаб по глубине сцены (та же формула, что у моделек: ниже=ближе=крупнее)
      joinBtn.style.cssText = "left:" + jp.x.toFixed(2) + "%;top:" + jp.y.toFixed(2) +
        "%;--jd:" + (0.5 + (jp.y / 100) * 0.62).toFixed(3) + ";--gc:" + (b.glow || b.accent);
      var jsc = showLeave ? "join-red" : "join-green";
      // Надпись — всегда как у обычных игроков (даже когда админ тестирует как Лирия!).
      // В очереди с обычным местом — «Изменить / выйти» (клик открывает меню, не выходит сразу).
      var btnTx = (iAmIn || (adminRegIn && _isAdmin && !_meAcc)) ? "Изменить / выйти" : (showLeave ? "Выйти из очереди" : ((iAmPriv || adminPrivIn) ? "Встать в очередь ⚡" : "Встать в очередь"));
      joinBtn.innerHTML =
        '<span class="qs-js-tx">' + btnTx + "</span>" +   // надпись НАД табличкой
        '<span class="qs-js-tot"><img class="qs-js-dim" src="assets/queue/ui/' + jsc + '-dim.webp?v=3" alt="">' +
        '<img class="qs-js-lit" src="assets/queue/ui/' + jsc + '-lit.webp?v=3" alt=""></span>';
      if (_placeMode) makeDraggable(joinBtn, "btn-join:" + b.q);
      else joinBtn.addEventListener("click", function () {
        if (_isAdmin && !_meAcc) {                            // админ тестирует как Лирия!
          // «в очереди» = ОБЫЧНОЕ место Лирии (жетон не считаем — он отдельная запись/блок)
          var ae = entries.filter(function (e) { return canon(e.main_nick) === canon(ADMIN_NICK) && !e.privileged; })[0];
          if (!ae) { openResourcePicker(b); return; }   // нет обычного места → встать (жетон покажется блоком)
          openResourcePicker(b, { resource: ae.resource || "", resources: ae.resources,
            recipient: ae.recipient || "", auto_repeat: ae.auto_repeat, plan: ae.auto_plan || [] });
          return;
        }
        if (!_meAcc) { alert("Чтобы встать в очередь, войди как игрок (по своему нику)."); return; }
        if (iAmIn) {   // в очереди → меню «изменить ресурсы или выйти» (не выходим сразу!)
          openResourcePicker(b, { resource: myEntry.resource || "", resources: myEntry.resources,
            recipient: myEntry.recipient || "", auto_repeat: myEntry.auto_repeat, plan: myEntry.auto_plan || [] });
          return;
        }
        openResourcePicker(b);   // не в обычной очереди → встать; активный жетон покажется блоком в окне
      });
      stage.appendChild(joinBtn);
      if (_isAdmin && _placeMode) stage.appendChild(admTag(jp, "Встать/Выйти · " + b.title));
      }
      // ЕДИНАЯ ТАБЛИЧКА на СЦЕНЕ: сфера-счётчик (число очереди) СВЕРХУ + «Посмотреть список»
      // (клик открывает список) + свечение сферы по наведению. Заменяет прежние отдельные шар
      // и кнопку «Список». Ключ cnt: сохранён — наследует прежнюю (центральную) позицию.
      if (!isHidden("cnt:" + b.q)) {
      var cnDef = [{ x: 44, y: 44 }, { x: 50, y: 50 }, { x: 56, y: 56 }][b.q] || { x: 50, y: 50 };
      var cp = placedPos("cnt:" + b.q, cnDef.x, cnDef.y);
      var csz = objSize("cnt:" + b.q, 1);
      var cnz = (PLACEMENTS["cnt:" + b.q] && PLACEMENTS["cnt:" + b.q].z) ? zOf("cnt:" + b.q, cp.y) : 9000;
      var cntEl = document.createElement(_placeMode ? "div" : "button");
      cntEl.className = "qs-board qs-btn-abs";
      // ширина таблички: на ПК — исходные px (как было), на узкой сцене (телефон) — ужимается cqw.
      // min(px,cqw): пока сцена ≥ базовой ширины → px (ПК не меняется), уже → cqw.
      cntEl.style.cssText = "left:" + cp.x.toFixed(2) + "%;top:" + cp.y.toFixed(2) +
        "%;width:min(" + (128 * csz).toFixed(1) + "px," + (13.9 * csz).toFixed(2) + "cqw);z-index:" + cnz +
        ";--gc:" + (b.glow || b.accent) +
        ";transform:" + flipTf("cnt:" + b.q, "translate(-50%,-50%)");
      cntEl.title = entries.length + " чел в очереди «" + b.title + "» — открыть список";
      // шрифт числа: clamp(пол, cqw, исходный_px) — ПК как было, телефон мельче (мельче для 3-значных)
      var _big3 = String(entries.length).length >= 3;
      var cntFs = "clamp(8px," + ((_big3 ? 1.41 : 1.95) * csz).toFixed(2) + "cqw," + ((_big3 ? 13 : 18) * csz).toFixed(1) + "px)";
      cntEl.innerHTML =
        '<img class="qs-board-idle" src="assets/queue/ui/board-idle.webp?v=1" alt="">' +
        '<img class="qs-board-glow" src="assets/queue/ui/board-glow.webp?v=1" alt="">' +
        '<b class="qs-board-n" style="font-size:' + cntFs + '">' + entries.length + "</b>" +
        '<span class="qs-board-tip">Посмотреть список</span>';
      if (_placeMode) makeDraggable(cntEl, "cnt:" + b.q);
      else cntEl.addEventListener("click", function () { openFullList(b, entries); });
      stage.appendChild(cntEl);
      if (_isAdmin && _placeMode) stage.appendChild(admTag(cp, "Табличка · " + b.title));
      }
      // кнопка «✎ ресурс/кому» — только когда игрок стоит в этой очереди
      if (iAmIn && !_placeMode && _meAcc) {
        var ep = placedPos("btn-edit:" + b.q, b.ui.x + 9, b.ui.y + 2);
        var editBtn = document.createElement("button");
        editBtn.className = "qs-list qs-btn-abs";
        editBtn.style.cssText = "left:" + ep.x.toFixed(2) + "%;top:" + ep.y.toFixed(2) + "%;--gc:" + b.accent;
        editBtn.title = "Изменить ресурс и кому передать"; editBtn.textContent = "✎ ресурс/кому";
        editBtn.addEventListener("click", function () {
          openResourcePicker(b, { resource: myEntry.resource || "", resources: myEntry.resources, recipient: myEntry.recipient || "",
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
    if (!isHidden("mount")) {
    var mpos = placedPos("mount", 85, 70);
    var mount = document.createElement("img");
    mount.className = "qs-mount"; mount.alt = ""; mount.decoding = "async"; mount.loading = "lazy";
    mount.src = objImgSrc("mount", "assets/queue/scene/item/mount-cilin.webp");
    mount.style.cssText = "left:" + mpos.x.toFixed(2) + "%;top:" + mpos.y.toFixed(2) +
      "%;height:calc(22% * " + objSize("mount", getSize("mount", 1)).toFixed(3) +
      ");z-index:" + zOf("mount", mpos.y) +
      ";transform:" + flipTf("mount", "translate(-50%,-100%)");
    if (_placeMode) makeDraggable(mount, "mount");
    stage.appendChild(mount);
    if (_isAdmin && _placeMode) stage.appendChild(admTag(mpos, "Огненный цилинь"));
    }

    // фонтан: днём — дневная картинка, ночью — ночная; обе одного размера и в одной
    // точке (выравнены по основанию через translate(-50%,-100%)). Размер — objSize("fountain"),
    // слой front/back — правым кликом. Перетаскивается в режиме расстановки.
    if (!isHidden("fountain")) {
    var fpos = placedPos("fountain", 50, 62);
    var fountain = document.createElement("img");
    fountain.className = "qs-fountain"; fountain.alt = ""; fountain.decoding = "async"; fountain.loading = "lazy";
    fountain.src = objImgSrc("fountain", "assets/queue/scene/fountain-" + (isNight() ? "night" : "day") + ".webp?v=1");
    fountain.style.cssText = "left:" + fpos.x.toFixed(2) + "%;top:" + fpos.y.toFixed(2) +
      "%;height:calc(24% * " + objSize("fountain", getSize("fountain", 1)).toFixed(3) +
      ");z-index:" + zOf("fountain", fpos.y) +
      ";transform:" + flipTf("fountain", "translate(-50%,-100%)");
    if (_placeMode) makeDraggable(fountain, "fountain");
    stage.appendChild(fountain);
    if (_isAdmin && _placeMode) stage.appendChild(admTag(fpos, "Фонтан (день/ночь)"));
    }

    // кошелёк жетонов ТОП-3 строим здесь, но вешаем ПОВЕРХ рамки (в .qs-frame после оверлея,
    // см. ниже) — чтобы он был ПЕРЕД рамкой окружения, а не под ней и не обрезался сценой.
    var frameWallet = null;
    if ((_meAcc || _isAdmin) && !isHidden("wallet")) {
      var wpos = placedPos("wallet", 17, 17);
      var wn = _myTokens || 0;
      var wcoins = "";
      for (var wi = 0; wi < Math.min(wn, 3); wi++) wcoins += '<img class="qs-fw-coin" src="assets/queue/ui/token.webp?v=2" alt="">';
      frameWallet = document.createElement("div");
      frameWallet.className = "qs-fwallet";
      frameWallet.dataset.fixedz = "1";   // всегда поверх рамки, даже при перетаскивании
      frameWallet.style.cssText = "left:" + wpos.x.toFixed(2) + "%;top:" + wpos.y.toFixed(2) +
        "%;width:calc(15% * " + objSize("wallet", 1).toFixed(3) + ");z-index:100000" +
        ";transform:" + flipTf("wallet", "translate(-50%,0)");
      frameWallet.title = "Твои жетоны ТОП-3: " + wn;
      frameWallet.innerHTML = '<img class="qs-fw-bg" src="' + objImgSrc("wallet", "assets/queue/ui/wallet2.webp?v=1") + '" alt="">' +
        '<div class="qs-fw-slot">' + (wn > 0
          ? '<span class="qs-fw-coins">' + wcoins + '</span><span class="qs-fw-x">×' + wn + "</span>"
          : '<span class="qs-fw-0">0</span>') + "</div>" +
        '<div class="qs-fw-cap">жетоны ТОП-3</div>';
      if (_placeMode) makeDraggable(frameWallet, "wallet");
    }

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
    // кошелёк жетонов — ПОВЕРХ рамки (последний ребёнок frame, z-index 100000): «на рамке»
    if (frameWallet) {
      frame.appendChild(frameWallet);
      if (_isAdmin && _placeMode) {
        var wtag = admTag(placedPos("wallet", 17, 17), "Кошелёк жетонов");
        wtag.style.zIndex = "100001";
        frame.appendChild(wtag);
      }
    }
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

  // Разворачивающееся окно ПРАВИЛ — вверху, для всех. Коротко и понятно + картинки ресурсов.
  function buildRulesPanel() {
    var el = document.createElement("details");
    el.className = "qs-rules";
    function ic(k) { return '<img class="qs-rules-ic" src="' + resImg(k) + '" alt="' + esc(resName(k)) + '" title="' + esc(resName(k)) + '">'; }
    el.innerHTML =
      '<summary class="qs-rules-sum"><span class="qs-rules-ic0">📖</span>' +
        '<b>Как работает очередь и жетоны ТОП-3 — правила</b><span class="qs-rules-arr">▸</span></summary>' +
      '<div class="qs-rules-body">' +
        '<div class="qs-rule"><span class="qs-rule-b" style="color:#7ec46a">🟢 Обычные:</span> выбирай <b>любые</b> ресурсы — каждый по <b>1 стаку</b> (стак = всё накопленное за неделю). Все выдадутся за раз, как подойдёт очередь.<div class="qs-rules-row">' + ic("kamen-doblesti") + ic("meteorit") + ic("zhemchuzhina") + ic("znak-edinstva") + ic("koloda-kart") + ic("kamen-bessmertnyh") + ic("pilyulya") + "</div></div>" +
        '<div class="qs-rule"><span class="qs-rule-b" style="color:#ffd24a">🟠 Редкие (R):</span> так же — можешь выбрать <b>оба</b> ресурса по стаку, выдадутся вместе.<div class="qs-rules-row">' + ic("gramota") + ic("prikaz-feniksa") + "</div></div>" +
        '<div class="qs-rule"><span class="qs-rule-b" style="color:#c07be0">🟣 Легендарные (S):</span> выбираешь <b>1 ресурс</b> и стоишь за ним. Получил — сразу в конец очереди, если стоит галочка «вставать автоматически»; без неё — встань снова.<div class="qs-rules-row">' + ic("drakonya-cheshuya") + ic("sushchnost-karty") + ic("vysshiy-kamen") + ic("mount-cilin") + "</div></div>" +
        '<div class="qs-rule"><b>Не всё досталось?</b> Если каких-то ресурсов не хватило — <b>остаёшься в очереди</b> за ними и получишь, как только появятся. Можно и выйти, встать заново и выбрать всё сразу новой пачкой.</div>' +
        '<div class="qs-rule"><b>🔥 Огненный цилинь и Высший камень</b> падают с шансом/с 6 этапа — на этой неделе их может не быть. Не страшно: ты <b>первый претендент</b> и стоишь в очереди, пока не получишь.</div>' +
        '<div class="qs-rule"><b>✏️ Менять выбор</b> можно в любой момент — нажми на свою модельку в очереди или на нужный ресурс у торговца.</div>' +
        '<div class="qs-rule"><span class="qs-rule-b">📜 Запечатанная грамота Лиги</span> может быть выдана <b>вне очереди</b> проводникам на КХ или тем, у кого не осталось пропусков на КХ — даже если подойдёт твоя очередь. Место при этом не теряешь.</div>' +
        '<div class="qs-rule qs-rule-tok"><b>⚡ Жетон ТОП-3 (вне очереди):</b> работает только на <b>обычные</b> ресурсы — берёшь <b>1 стак одного</b> ресурса. Появляется твой <b>светящийся клон</b>, который берёт ресурс вне очереди, а твоя <b>основная моделька остаётся в очереди</b> и не теряет место. Жетон даётся за попадание в <b>ТОП-3 недели по доблести</b>, копится по 1 и не сгорает.</div>' +
      "</div>";
    return el;
  }

  // «Реклама» жетона ТОП-3 — над всей картинкой, для всех. Коротко: что это и как работает.
  // Личное уведомление «очередь подошла, но не хватило доблести» (свиток-предупреждение).
  function buildNoticeBanner() {
    if (!_meAcc || !_notices || !_notices.length) return null;
    var items = [], nick = (_meAcc && _meAcc.main_nick) || "";
    _notices.filter(function (n) { return n.kind === "low_valor"; }).forEach(function (n) {
      var d = n.data || {}; if (d.nick) nick = d.nick;
      (d.items || []).forEach(function (it) { items.push(it); });
    });
    if (!items.length) return null;
    var box = document.createElement("div");
    box.className = "qs-notice";
    var rows = items.map(function (it) {
      var qty = it.qty ? ' <span class="qs-nt-qty">×' + it.qty + "</span>" : "";
      return '<div class="qs-nt-row">' +
        '<img class="qs-nt-ic" src="' + resImg(it.resource) + '" alt="" onerror="this.style.display=\'none\'">' +
        '<div class="qs-nt-txt"><div class="qs-nt-res"><b>' + esc(it.res_name || it.resource) + "</b>" + qty +
        '<span class="qs-nt-q"> · очередь «' + esc(it.queue_name) + '»</span></div>' +
        '<div class="qs-nt-need">нужно доблести за неделю: <b class="qs-nt-thr">' + it.threshold +
        '</b> · у тебя было: <b class="qs-nt-had">' + it.valor + "</b></div></div></div>";
    }).join("");
    box.innerHTML =
      '<button class="qs-nt-x" title="Понятно, скрыть">✕</button>' +
      '<div class="qs-nt-head">📜 Итоги недели — лично для тебя</div>' +
      '<div class="qs-nt-lead"><b>' + esc(nick) + "</b>, твоя очередь " +
        (items.length > 1 ? "за ресурсами подошла" : "за ресурсом подошла") +
        ", но на этой неделе, к сожалению, <b>не хватило доблести</b>, чтобы получить:</div>" +
      '<div class="qs-nt-list">' + rows + "</div>" +
      '<div class="qs-nt-foot">Ты <b>остаёшься в очереди</b> — место не потеряно. Как только наберёшь ' +
        "нужную доблесть за неделю, получишь свой ресурс. Не сдавайся — у тебя всё получится! 💪</div>";
    box.querySelector(".qs-nt-x").addEventListener("click", function () {
      q("POST", "/queue/notices/seen", {}).catch(function () {});
      _notices = []; box.remove();
    });
    return box;
  }

  // Свиток-список «Держатели жетонов ТОП-3» (виден ВСЕМ, сверху справа, разворачивается кликом)
  function buildTokenBoard() {
    var holders = _tokenBoard || [];
    var box = document.createElement("div");
    box.className = "qs-tboard" + (_tboardOpen ? " open" : "");
    var head = document.createElement("button");
    head.className = "qs-tb-head";
    head.innerHTML =
      '<img class="qs-tb-coin" src="assets/queue/ui/token.webp?v=2" alt="">' +
      '<span class="qs-tb-title">Держатели жетонов ТОП-3</span>' +
      '<span class="qs-tb-cnt">' + (holders.length ? holders.length + " чел." : "нет") + "</span>" +
      '<span class="qs-tb-arrow">' + (_tboardOpen ? "▾" : "▸") + "</span>";
    head.addEventListener("click", function () { _tboardOpen = !_tboardOpen; render(_lastState); });
    box.appendChild(head);
    if (_tboardOpen) {
      var body = document.createElement("div");
      body.className = "qs-tb-body";
      if (!holders.length) {
        body.innerHTML = '<div class="qs-tb-empty">Жетоны пока ни у кого. Попади в ТОП-3 недели по доблести — и он твой!</div>';
      } else {
        body.innerHTML = holders.map(function (h, i) {
          var rank = i + 1;
          var medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : "#" + rank;
          var coins = "";
          for (var c = 0; c < Math.min(h.tokens, 6); c++) coins += '<img class="qs-tb-mini" src="assets/queue/ui/token.webp?v=2" alt="">';
          return '<div class="qs-tb-row' + (rank <= 3 ? " top" : "") + '">' +
            '<span class="qs-tb-rank">' + medal + "</span>" +
            '<span class="qs-tb-nick">' + esc(h.nick) + "</span>" +
            '<span class="qs-tb-coins">' + coins + "</span>" +
            '<span class="qs-tb-n">×' + h.tokens + "</span></div>";
        }).join("");
      }
      box.appendChild(body);
    }
    return box;
  }

  function buildTokenAd() {
    var el = document.createElement("div");
    el.className = "qs-token-ad";
    el.innerHTML =
      '<img class="qs-ta-token" src="assets/queue/ui/token.webp?v=2" alt="Жетон ТОП-3">' +
      '<div class="qs-ta-body">' +
        '<div class="qs-ta-title">Жетон ТОП-3 <span>— награда за доблесть</span></div>' +
        '<div class="qs-ta-tx">Попади в <b>ТОП-3 недели по доблести</b> — получишь <b>жетон</b>. Им берёшь <b>1 стак одного ' +
        'обычного ресурса вне очереди</b> — появляется твой <b>светящийся клон</b> у торговца. При этом твоя <b>основная ' +
        'моделька остаётся в очереди и не теряет место</b> — получаешь ресурс по жетону <b>вдобавок</b>. Копится по 1 за неделю, не сгорает.</div>' +
      "</div>" +
      '<div class="qs-ta-badge">без очереди!</div>';
    return el;
  }

  // «Мой кошелёк жетонов ТОП-3» — сколько их у тебя, картинкой жетона (для всех вошедших)
  function buildMyTokens() {
    if (!_meAcc) return null;                     // личный кошелёк — только у вошедшего игрока
    var n = _myTokens || 0;
    var el = document.createElement("div");
    el.className = "qs-mytok" + (n > 0 ? " has" : "");
    var coins = "";
    var show = Math.min(n, 5);
    for (var i = 0; i < show; i++) coins += '<img class="qs-mt-coin" src="assets/queue/ui/token.webp?v=2" alt="">';
    var slot = n > 0
      ? '<div class="qs-mt-coins">' + coins + '</div><span class="qs-mt-x">×' + n + "</span>"
      : '<span class="qs-mt-empty">пока пусто</span>';
    el.innerHTML =
      '<div class="qs-mt-wallet"><img class="qs-mt-frame" src="assets/queue/ui/wallet.webp?v=2" alt="">' +
        '<div class="qs-mt-slot">' + slot + "</div></div>" +
      '<div class="qs-mt-info">' +
        '<div class="qs-mt-n">' + (n > 0 ? "Твои жетоны ТОП-3: <b>" + n + "</b>" : "Жетонов ТОП-3: <b>0</b>") + "</div>" +
        '<div class="qs-mt-sub">' + (n > 0
          ? "нажми «⚡ Взять вне очереди» — потратишь жетон(ы) и возьмёшь ресурсы сразу"
          : "попади в ТОП-3 недели по доблести — получишь жетон") + "</div>" +
      "</div>";
    return el;
  }

  // Меню «Моя моделька в очереди» — для вошедшего игрока (низ страницы).
  //  • Есть персональная модель → сегмент Персональная/По классу; пол активен ТОЛЬКО когда
  //    выбрана классовая И у класса есть модели обоих полов.
  //  • Нет персональной, класс с двумя полами → переключатель пола (муж/жен) + авто.
  //  • Нет персональной, у класса одна моделька → меню не показываем (менять нечего).
  function buildGenderPicker() {
    if (!_meAcc) return null;
    var keys = [canon(_meAcc.main_nick), canon(_meAcc.reg_nick)].filter(Boolean);
    var pers = personalInfo(keys);                  // есть ли персональная модель
    var ci = myClassInfo();                          // {cls, trueName}
    var both = classHasBothGenders(ci.cls);         // класс поддерживает выбор пола
    if (!pers && !both) return null;                // одна моделька — выбирать нечего

    var usingClass = !pers || _myPreferClass;       // показывается ли сейчас классовая модель
    var genderEnabled = both && usingClass;         // менять пол можно только у классовой с двумя полами
    var eff = (_myGender === "m" || _myGender === "f") ? _myGender : genderOf(ci.cls, ci.trueName);

    var box = document.createElement("div");
    box.className = "qs-gender";
    var html =
      '<div class="qs-gn-head"><span class="qs-gn-ic">🧍</span>' +
        '<div class="qs-gn-tx"><b>Моя моделька в очереди</b>' +
          '<span class="qs-gn-sub">' + (pers ? "персональная или общая по классу" : "как ты выглядишь в очереди") + "</span></div></div>";
    if (pers) {                                      // выбор источника модели — только при наличии персональной
      html +=
        '<div class="qs-gn-seg" role="group" aria-label="Модель">' +
          '<button class="qs-gn-opt src' + (!usingClass ? " on" : "") + '" data-src="0"><span class="qs-gn-sym">★</span>Персональная</button>' +
          '<button class="qs-gn-opt src' + (usingClass ? " on" : "") + '" data-src="1"><span class="qs-gn-sym">☰</span>По классу</button>' +
        "</div>";
    }
    if (both) {                                      // выбор пола — только если у класса есть обе модели
      html +=
        '<div class="qs-gn-seg' + (genderEnabled ? "" : " off") + '" role="group" aria-label="Пол модели"' + (pers ? ' style="margin-top:8px"' : "") + ">" +
          '<button class="qs-gn-opt m' + (eff === "m" ? " on" : "") + '" data-g="m"' + (genderEnabled ? "" : " disabled") + '><span class="qs-gn-sym">♂</span>Мужской</button>' +
          '<button class="qs-gn-opt f' + (eff === "f" ? " on" : "") + '" data-g="f"' + (genderEnabled ? "" : " disabled") + '><span class="qs-gn-sym">♀</span>Женский</button>' +
        "</div>";
      if (genderEnabled && _myGender) html += '<button class="qs-gn-auto" data-g="">↺ по имени (авто)</button>';
      else if (genderEnabled) html += '<div class="qs-gn-note">Пол определён автоматически — можно сменить кнопками.</div>';
      else html += '<div class="qs-gn-note">Пол доступен для общей модели — переключись на «По классу».</div>';
    }
    box.innerHTML = html;

    function resetDisabled() {
      box.querySelectorAll("button").forEach(function (b) { b.disabled = (b.hasAttribute("data-g") && !genderEnabled); });
    }
    function setBusy() { box.querySelectorAll("button").forEach(function (b) { b.disabled = true; }); }
    function pickGender(ng) {
      if (!genderEnabled || _myGender === ng) return;
      setBusy();
      q("POST", "/queue/gender", { gender: ng }).then(function (d) {
        _myGender = (d && d.gender) || ""; refresh();
      }).catch(function (e) { resetDisabled();
        alert(e.status === 401 ? "Сессия истекла, войди заново." : ("Не удалось сменить пол: " + (e.detail || e.message))); });
    }
    function pickSrc(pc) {
      if (_myPreferClass === pc) return;
      setBusy();
      q("POST", "/queue/model-pref", { prefer_class: pc }).then(function (d) {
        _myPreferClass = !!(d && d.prefer_class); refresh();
      }).catch(function (e) { resetDisabled();
        alert(e.status === 401 ? "Сессия истекла, войди заново." : ("Не удалось сменить модель: " + (e.detail || e.message))); });
    }
    box.querySelectorAll("[data-g]").forEach(function (b) { b.addEventListener("click", function () { pickGender(b.getAttribute("data-g")); }); });
    box.querySelectorAll("[data-src]").forEach(function (b) { b.addEventListener("click", function () { pickSrc(b.getAttribute("data-src") === "1"); }); });
    // если доступно несколько обликов (личные + классовые) — кнопка удобного выбора с превью
    try {
      var _vs = modelVariants(myEntryLike());
      if (_vs.length > 1) {
        var skin = document.createElement("button");
        skin.className = "qs-gn-skin";
        skin.innerHTML = "🔄 Сменить облик <span class=\"n\">(" + _vs.length + " на выбор)</span>";
        skin.addEventListener("click", function () { openModelSwitcher(myEntryLike()); });
        box.appendChild(skin);
      }
    } catch (err) {}
    return box;
  }

  // ── переключатель облика: крупный портрет + стрелки + миниатюры всех доступных вариантов ──
  // Открывается владельцем со своей модельки (наведение → кнопка) или из панели «Моя моделька».
  function openModelSwitcher(e) {
    var vs = modelVariants(e);
    if (vs.length < 2) { alert("Пока доступна только одна моделька. Другие облики может добавить админ."); return; }
    var curTok = currentVariantKey(e, vs);
    var idx = 0; for (var i0 = 0; i0 < vs.length; i0++) if (vs[i0].key === curTok) { idx = i0; break; }
    var busy = false;
    var body = document.createElement("div"); body.className = "qs-msw";
    body.innerHTML =
      '<div class="qs-msw-stage">' +
        '<button class="qs-msw-arw" data-d="-1" aria-label="назад">‹</button>' +
        '<div class="qs-msw-pic"><span class="qs-msw-shadow"></span><img class="qs-msw-img" alt=""></div>' +
        '<button class="qs-msw-arw" data-d="1" aria-label="вперёд">›</button>' +
      "</div>" +
      '<div class="qs-msw-label"></div>' +
      '<div class="qs-msw-thumbs"></div>' +
      '<div class="qs-msw-hint">Выбери облик — применится в очереди сразу. Сменить можно в любой момент.</div>';
    var img = body.querySelector(".qs-msw-img"), label = body.querySelector(".qs-msw-label"),
        thumbsEl = body.querySelector(".qs-msw-thumbs"), picEl = body.querySelector(".qs-msw-pic");
    vs.forEach(function (v, i) {
      var t = document.createElement("button");
      t.className = "qs-msw-thumb" + (v.kind === "person" ? " person" : " cls");
      t.dataset.i = i; t.title = v.label;
      var tf = (MODEL_SETTINGS[v.mkey] && MODEL_SETTINGS[v.mkey].flip) ? ' style="transform:scaleX(-1)"' : "";
      t.innerHTML = '<img src="' + esc(v.url) + '"' + tf + ' alt=""><span>' + esc(v.label) + "</span>";
      thumbsEl.appendChild(t);
    });
    function paint() {
      var v = vs[idx], ms = MODEL_SETTINGS[v.mkey] || {};
      img.style.transform = ms.flip ? "scaleX(-1)" : "";
      img.src = v.url;
      if (picEl) picEl.classList.toggle("death", ms.aura === "death");   // зловещая дымка в превью
      label.innerHTML = '<b>' + esc(v.label) + "</b><span class='qs-msw-count'>" + (idx + 1) + " / " + vs.length + "</span>";
      [].forEach.call(thumbsEl.children, function (c, i) { c.classList.toggle("on", i === idx); });
    }
    function commit(tok) {
      if (busy) return; busy = true;
      body.classList.add("saving");
      // СВОЯ моделька → обычный эндпоинт; ЧУЖАЯ и я админ → админ-эндпоинт по нику этого игрока
      var iAmOwner = _meAcc && canon(e.main_nick) === canon(_meAcc.main_nick);
      var path = iAmOwner ? "/queue/model-variant" : "/queue/admin/model-variant-as";
      var pl = iAmOwner ? { key: tok } : { nick: e.main_nick || e.nick, key: tok };
      q("POST", path, pl).then(function (d) {
        if (iAmOwner) _myVariant = (d && d.variant) || "";
        busy = false; body.classList.remove("saving"); refresh();
      }).catch(function (e2) {
        busy = false; body.classList.remove("saving");
        alert(e2.status === 401 ? "Сессия истекла, войди заново." : ("Не удалось сменить облик: " + (e2.detail || e2.message)));
      });
    }
    function go(i) { idx = ((i % vs.length) + vs.length) % vs.length; paint(); commit(vs[idx].key); }
    body.querySelectorAll(".qs-msw-arw").forEach(function (a) {
      a.addEventListener("click", function () { go(idx + (+a.dataset.d)); });
    });
    thumbsEl.addEventListener("click", function (ev) {
      var t = ev.target.closest(".qs-msw-thumb"); if (t) go(+t.dataset.i);
    });
    paint();
    sceneModal("🧍 Моя моделька — выбери облик (" + vs.length + ")", body);
  }
  // псевдо-запись для владельца (когда открываем переключатель из панели, а не с модельки в очереди)
  function myEntryLike() {
    var ci = myClassInfo();
    return { main_nick: _meAcc.main_nick, nick: _meAcc.reg_nick || _meAcc.main_nick, cls: ci.cls,
             true_name: ci.trueName, gender: _myGender, prefer_class: _myPreferClass, variant: _myVariant };
  }

  // класс и игровое имя текущего игрока (для авто-пола и наличия модели) — из очереди либо ростера
  function myClassInfo() {
    var mc = canon(_meAcc.main_nick), rc = canon(_meAcc.reg_nick);
    var qs = _lastState && _lastState.queues;
    if (qs) for (var i = 0; i < qs.length; i++) { var arr = qs[i] || [];
      for (var j = 0; j < arr.length; j++) { var e = arr[j];
        if (canon(e.main_nick) === mc) return { cls: e.cls || "", trueName: e.true_name || "" }; } }
    for (var k = 0; k < _roster.length; k++) { var r = _roster[k];
      if (r && (canon(r.main_nick) === mc || canon(r.nick) === mc || canon(r.nick) === rc))
        return { cls: r.cls || "", trueName: r.true_name || "" }; }
    return { cls: "", trueName: "" };
  }

  function renderQueueStrips(state) {
    var box = document.createElement("div");
    box.className = "qs-strips";
    var meCanon = _meAcc ? canon(_meAcc.main_nick) : "";
    var adminCanon = (_isAdmin && !_meAcc) ? canon(ADMIN_NICK) : "";   // админ тестирует как Лирия!
    BOOTHS.forEach(function (b) {
      var entries = state.queues[b.q] || [];
      var myIdx = -1, iAmIn = false, myEntry = null, myPriv = false;
      // «в очереди» = обычное место (privileged=0); жетонную (privileged) запись
      // учитываем отдельно, но кнопка тоже краснеет при жетоне ТОП-3 (Лир 2026-07-19).
      entries.forEach(function (e, i) {
        if (meCanon && canon(e.main_nick) === meCanon) {
          if (e.privileged) myPriv = true;
          else { myIdx = i; iAmIn = true; myEntry = e; }
        }
      });
      // для админ-теста: ОБЫЧНОЕ место Лирии и её жетон — раздельно (как iAmIn/iAmPriv у игрока)
      var adminRegIn = adminCanon && entries.some(function (e) { return canon(e.main_nick) === adminCanon && !e.privileged; });
      var adminPrivIn = adminCanon && entries.some(function (e) { return canon(e.main_nick) === adminCanon && e.privileged; });
      var adminIn = adminRegIn;
      var lane = document.createElement("div");
      lane.className = "qs-lane"; lane.style.setProperty("--gc", b.accent);
      var head = document.createElement("div"); head.className = "qs-lane-head";
      // шрифт числа в полосе — мельче для 3-значных, чтобы влезло в сферу
      var laneFs = String(entries.length).length >= 3 ? 12 : 15;
      head.innerHTML = '<span class="qs-lane-title">' + esc(b.title) + "</span>" +
        (myIdx >= 0 ? '<span class="qs-lane-you">ты #' + (myIdx + 1) + "</span>" : "");
      // счётчик-табличку НЕ кладём в шапку (задирала высоту строки) — она едет ВБОК,
      // к окну торговца (append в sw ниже). Кликабельна — открывает полный список.
      var boardEl = document.createElement("button");
      boardEl.className = "qs-lane-board";
      boardEl.style.setProperty("--gc", b.glow || b.accent);   // свечение под цвет очереди (редкие=золото)
      boardEl.title = entries.length + " чел в очереди — открыть список";
      boardEl.innerHTML =
        '<img class="qs-lane-board-idle" src="assets/queue/ui/board-idle.webp?v=1" alt="">' +
        '<img class="qs-lane-board-glow" src="assets/queue/ui/board-glow.webp?v=1" alt="">' +
        '<b class="qs-lane-board-n" style="font-size:' + laneFs + 'px">' + entries.length + "</b>" +
        '<span class="qs-lane-board-tip">Посмотреть список</span>';
      (function (bb, ent) {
        boardEl.addEventListener("click", function () { openFullList(bb, ent); });
      })(b, entries);
      var sw = document.createElement("div"); sw.className = "qs-lane-sw";
      // кнопка «Встать/Выйти» в начале очереди (отдельно, не скроллится с людьми)
      var joinCell = document.createElement("button");
      var inNow = iAmIn || adminIn;   // красная «Выйти» — только обычное место; жетон отдельно (клон + панель)
      joinCell.className = "qs-lane-join" + (inNow ? " leave" : "");
      // Надпись — всегда как у обычных игроков (даже когда админ тестирует как Лирия!).
      // В очереди — «Изменить / выйти» (клик открывает меню, а не выходит сразу).
      var joinTx = (iAmIn || (adminRegIn && _isAdmin && !_meAcc)) ? "Изменить / выйти" : (inNow ? "Выйти из очереди" : ((myPriv || adminPrivIn) ? "Встать в очередь ⚡" : "Встать в очередь"));
      var jcolor = inNow ? "join-red" : "join-green";
      joinCell.innerHTML =
        '<span class="qs-lane-join-tot">' +
          '<img class="qs-jt-dim" src="assets/queue/ui/' + jcolor + '-dim.webp?v=3" alt="">' +
          '<img class="qs-jt-lit" src="assets/queue/ui/' + jcolor + '-lit.webp?v=3" alt="">' +
        "</span>" +
        '<span class="qs-lane-join-tx">' + joinTx + "</span>";
      joinCell.addEventListener("click", function () {
        // Админ без игрового аккаунта — тест от имени Лирия!
        if (_isAdmin && !_meAcc) {
          if (!adminIn) { openResourcePicker(b, null, null, "lane"); return; }
          var ae2 = entries.filter(function (e) { return canon(e.main_nick) === canon(ADMIN_NICK) && !e.privileged; })[0];
          openResourcePicker(b, { resource: (ae2 && ae2.resource) || "", resources: (ae2 && ae2.resources),
            recipient: (ae2 && ae2.recipient) || "", auto_repeat: ae2 && ae2.auto_repeat, plan: (ae2 && ae2.auto_plan) || [] }, null, "lane");
          return;
        }
        if (!_meAcc) { alert("Чтобы встать в очередь, войди как игрок (по своему нику)."); return; }
        if (iAmIn) {   // в очереди → меню «изменить ресурсы или выйти» (не выходим сразу!)
          openResourcePicker(b, { resource: myEntry.resource || "", resources: myEntry.resources,
            recipient: myEntry.recipient || "", auto_repeat: myEntry.auto_repeat, plan: myEntry.auto_plan || [] }, null, "lane");
          return;
        }
        openResourcePicker(b, null, null, "lane");   // не в обычной очереди → встать; жетон покажется блоком в окне
      });
      var lArr = document.createElement("button"); lArr.className = "qs-lane-arrow"; lArr.textContent = "◀"; lArr.title = "назад";
      var strip = document.createElement("div"); strip.className = "qs-lane-strip"; strip.dataset.q = b.q;
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
        cell.className = "qs-cell" + (mine ? " me" : "") + (e.privileged ? " priv" : "") + (modelAura(e) === "death" ? " death" : "");
        cell.setAttribute("data-tip", tipHtml(e) + (mine ? '<span class="qtip-hint">нажми, чтобы сменить ресурс</span>' : ""));
        // облачко над головой — ТОЛЬКО картинка ресурса (без названия); имя и кол-во в подсказке.
        // Иконки автокропятся ниже → цилинь заполняет облачко без пустого пространства.
        var bl = (e.resources && e.resources.length) ? e.resources : (e.resource ? [e.resource] : []);
        var bubble = bl.length
          ? '<div class="qs-bubble' + (e.privileged ? " priv" : "") + '"><img class="qs-bubble-ic" src="' +
            resImg(bl[0]) + '" alt="">' + (bl.length > 1 ? '<span class="qs-bubble-n">+' + (bl.length - 1) + "</span>" : "") + "</div>"
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
            openResourcePicker(b, { resource: e.resource || "", resources: e.resources, recipient: e.recipient || "",
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
      var resCount = {};   // считаем по ВСЕМ выбранным ресурсам записи (мультивыбор), не только по первому
      entries.forEach(function (e) {
        var rl = (e.resources && e.resources.length) ? e.resources : (e.resource ? [e.resource] : []);
        rl.forEach(function (r) { resCount[r] = (resCount[r] || 0) + 1; });
      });
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
        if (_isAdmin && !_meAcc) { openResourcePicker(b, null, it, "lane"); return; }   // админ встаёт как Лирия!
        if (!_meAcc) { alert("Чтобы встать в очередь, войди как игрок (по своему нику)."); return; }
        if (iAmIn) openResourcePicker(b, { resource: it, resources: (myEntry && myEntry.resources), recipient: (myEntry && myEntry.recipient) || "",
          auto_repeat: myEntry && myEntry.auto_repeat, plan: (myEntry && myEntry.auto_plan) || [] });
        else openResourcePicker(b, null, it, "lane");
      });

      lArr.addEventListener("click", function () { strip.scrollBy({ left: -260, behavior: "smooth" }); });
      rArr.addEventListener("click", function () { strip.scrollBy({ left: 260, behavior: "smooth" }); });
      // запоминаем позицию прокрутки этой полосы, чтобы при перерисовке (удаление в ЛЮБОЙ
      // очереди пересобирает всё) она не «прыгала» вправо, а осталась на месте
      strip.addEventListener("scroll", function () { _stripScroll[b.q] = strip.scrollLeft; });
      sw.appendChild(joinCell); sw.appendChild(lArr); sw.appendChild(strip);
      sw.appendChild(rArr); sw.appendChild(boardEl); sw.appendChild(merchBox);
      lane.appendChild(head); lane.appendChild(sw);
      box.appendChild(lane);
      autoCropAll(strip, ".qs-cell-img");                  // центровка моделей
      autoCropAll(strip, ".qs-bubble-ic");                 // ресурс заполняет облачко (цилинь без пустот)
      autoCropAll(merchBox, ".qs-mres img");               // иконки ресурсов заполняют бокс (цилинь крупнее)
      setTimeout(function () {
        if (_stripScroll[b.q] != null) { strip.scrollLeft = _stripScroll[b.q]; return; }  // вернуть, где было
        var c = strip.querySelector(".qs-cell.me");        // ПЕРВЫЙ показ: к своей ячейке…
        if (c) strip.scrollLeft = c.offsetLeft - strip.clientWidth / 2 + c.clientWidth / 2;
        else strip.scrollLeft = strip.scrollWidth;         // …иначе к голове очереди (у торговца)
        _stripScroll[b.q] = strip.scrollLeft;              // ЗАПОМНИТЬ — чтобы дальше не дёргалось к голове каждый рендер
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
      '<img class="qs-super-token" src="assets/queue/ui/token.webp?v=2" alt="">' +
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
      var goBtn = body.querySelector("#qpc-go");
      if (goBtn.disabled) return;                 // защита от двойного клика (жетоны не спишутся дважды)
      goBtn.disabled = true;
      var path = admin ? "/queue/admin/priv-claim-as" : "/queue/priv-claim";
      var payload = admin ? { nick: ADMIN_NICK, resource: sel, stacks: stacks() } : { resource: sel, stacks: stacks() };
      q("POST", path, payload).then(function (d) {
        if (!admin) _myTokens = d.tokens; if (m) m.close(); refresh();
      }).catch(function (e) {
        goBtn.disabled = false;
        alert(e.status === 409 ? "Не хватает жетонов." : e.status === 400 ? "Только обычные ресурсы (не пачечные)." :
              e.status === 401 ? "Войди как игрок." : ("Ошибка: " + (e.detail || e.message)));
      });
    });
  }

  var _roster = [], _isAdmin = false, _role = "", _officerName = "", _meAcc = null, _myTokens = 0, _myGender = "", _myPreferClass = false, _myVariant = "", _lastState = { queues: [[], [], []] };
  var _notices = [];       // персональные уведомления игрока (напр. «не хватило доблести»)
  var _tokenBoard = [];    // держатели жетонов ТОП-3 (для всех) — [{nick, tokens}]
  var _tboardOpen = false; // раскрыт ли свиток «Держатели жетонов»
  var _stripScroll = {};   // позиция горизонтальной прокрутки каждой полосы (чтобы не прыгала при перерисовке)
  var _justJoined = null;  // {q, canon} — только что встал в очередь: прокрутить к себе + анимация появления
  var _secOpen = {};       // раскрытость админ-секций (по индексу) — чтобы не схлопывались при перерисовке
  var _scnPanelOpen = true; // раскрыта ли правая панель управления объектами сцены
  var _scnScroll = 0;       // позиция прокрутки правой панели (чтобы не прыгала наверх при перерисовке)

  // ── АДМИН-ПАНЕЛЬ управления объектами сцены (справа): точное перемещение,
  //    размер, слой (перёд/зад). Работает без режима таскания — правит размещения напрямую.
  //    Видна ТОЛЬКО админу.
  function sceneObjPanel() {
    var objs = [];
    // очереди целиком (все люди с предметами над головами) — только слой перёд/зад/авто
    BOOTHS.forEach(function (b) { objs.push({ queue: b.q, name: "Очередь · " + b.title + " (все люди)" }); });
    BOOTHS.forEach(function (b) { objs.push({ key: "lavka:" + b.q, name: "Лавка · " + b.title, dx: b.merchant.x, dy: b.merchant.y + 3, sz: true, base: getSize("lavka", 1), flip: true, repl: true }); });
    var cnDef = [{ x: 44, y: 44 }, { x: 50, y: 50 }, { x: 56, y: 56 }];
    BOOTHS.forEach(function (b) { objs.push({ key: "cnt:" + b.q, name: "Табличка · " + b.title, dx: cnDef[b.q].x, dy: cnDef[b.q].y, sz: true, base: 1, flip: true }); });
    objs.push({ key: "mount", name: "Огненный цилинь", dx: 85, dy: 70, sz: true, base: getSize("mount", 1), flip: true, repl: true });
    objs.push({ key: "fountain", name: "Фонтан (день/ночь)", dx: 50, dy: 62, sz: true, base: getSize("fountain", 1), flip: true, repl: true });
    objs.push({ key: "wallet", name: "Кошелёк жетонов", dx: 17, dy: 17, sz: true, base: 1, flip: true, repl: true });
    BOOTHS.forEach(function (b) { var p0 = getPath(b.q)[0] || { x: 45, y: 60 }; objs.push({ key: "btn-join:" + b.q, name: "Встать/Выйти · " + b.title, dx: p0.x - 6, dy: p0.y + 3, sz: false, flip: true }); });
    // (Отдельная кнопка «Список» убрана — объединена с табличкой-счётчиком выше.)
    // добавленные админом предметы окружения (загруженные картинки) — тоже управляемы отсюда
    ENV.forEach(function (o) { objs.push({ env: o, name: "Предмет · " + o.key.slice(4) }); });
    // защита от дублей: один ключ — одна строка
    var _seen = {}; objs = objs.filter(function (o) {
      var id = o.queue !== undefined ? "q" + o.queue : o.env ? "e" + o.env.id : o.key;
      if (_seen[id]) return false; _seen[id] = 1; return true;
    });

    var panel = document.createElement("div");
    panel.className = "qs-objp" + (_scnPanelOpen ? "" : " closed");
    var head = document.createElement("div");
    head.className = "qs-objp-head";
    head.innerHTML = '<span>🛠 Объекты сцены</span><button class="qs-objp-tog">' + (_scnPanelOpen ? "▾" : "▸") + "</button>";
    head.querySelector(".qs-objp-tog").addEventListener("click", function () { _scnPanelOpen = !_scnPanelOpen; render(_lastState); });
    panel.appendChild(head);

    var bodyEl = document.createElement("div");
    bodyEl.className = "qs-objp-body";
    bodyEl.addEventListener("scroll", function () { _scnScroll = bodyEl.scrollTop; });
    // переключатель режима таскания/подписей
    var pm = document.createElement("button");
    pm.className = "qs-objp-pm" + (_placeMode ? " on" : "");
    pm.textContent = _placeMode ? "🎯 Расстановка ВКЛ (подписи видны)" : "🎯 Вкл. таскание+подписи";
    pm.addEventListener("click", function () { _placeMode = !_placeMode; if (_placeMode) _pathMode = false; render(_lastState); });
    bodyEl.appendChild(pm);
    // кнопка редактора ФОРМЫ очередей (пути) — та функция, что добавляли ранее
    var pe = document.createElement("button");
    pe.className = "qs-objp-pm" + (_pathMode ? " on" : "");
    pe.textContent = _pathMode ? "✏️ Форма очередей: ВКЛ (тащи точки)" : "✏️ Редактировать форму очередей";
    pe.addEventListener("click", function () { _pathMode = !_pathMode; if (_pathMode) _placeMode = false; render(_lastState); });
    bodyEl.appendChild(pe);

    // ── ЦЕНТР СЦЕНЫ (фон день/ночь): переключатель времени, замена картинки, зум и сдвиг ──
    var bgSlot2 = isNight() ? "bg-night" : "bg-day";
    var slotName = isNight() ? "ночь" : "день";
    var curTime = CONFIG["forceTime"] || "auto";
    var bgZoom = parseFloat(CONFIG["bgzoom:" + bgSlot2]) || 100;
    var bg = document.createElement("div");
    bg.className = "qs-objp-bg";
    bg.innerHTML =
      '<div class="qs-objp-bgh">🖼 Центр сцены — фон (сейчас: <b>' + slotName + "</b>)</div>" +
      '<div class="qs-objp-bgtime">' +
        '<button data-t="day" class="' + (curTime === "day" ? "on" : "") + '">☀️ день</button>' +
        '<button data-t="night" class="' + (curTime === "night" ? "on" : "") + '">🌙 ночь</button>' +
        '<button data-t="auto" class="' + (curTime === "auto" ? "on" : "") + '">🕓 авто</button>' +
      "</div>" +
      '<div class="qs-objp-ctl">' +
        '<button data-b="repl" class="qs-objp-repl">🖼 заменить фон (' + slotName + ")</button>" +
        (uploadedUrl(overrideKey(bgSlot2)) ? '<button data-b="opt" class="qs-objp-opt" title="оптимизировать загруженный фон">🗜</button>' : "") +
        '<span class="qs-objp-sz"><button data-b="z-">−</button><b class="qs-objp-szv">' + bgZoom.toFixed(0) +
          '%</b><button data-b="z+">+</button></span>' +
      "</div>" +
      '<div class="qs-objp-ctl"><span class="qs-objp-pad">' +
        '<button data-b="up">▲</button>' +
        '<span class="qs-objp-lr"><button data-b="left">◀</button><button data-b="ctr" title="центр">◎</button>' +
        '<button data-b="right">▶</button></span><button data-b="down">▼</button>' +
      '</span><span class="qs-objp-bghint">сдвиг фона работает при зуме больше 100%</span></div>';
    bg.addEventListener("click", function (e) {
      var btn = e.target.closest("button"); if (!btn) return;
      if (btn.dataset.t) { saveCfg("forceTime", btn.dataset.t); render(_lastState); return; }
      var b = btn.dataset.b, sl = isNight() ? "bg-night" : "bg-day";
      var z = parseFloat(CONFIG["bgzoom:" + sl]) || 100;
      var bx = parseFloat(CONFIG["bgx:" + sl]); if (!isFinite(bx)) bx = 50;
      var by = parseFloat(CONFIG["bgy:" + sl]); if (!isFinite(by)) by = 50;
      if (b === "repl") { replaceModel(overrideKey(sl)); return; }
      else if (b === "opt") { optimizeObj(overrideKey(sl), "фон (" + (sl === "bg-night" ? "ночь" : "день") + ")"); return; }
      else if (b === "z+") saveCfg("bgzoom:" + sl, Math.min(300, z + 5));
      else if (b === "z-") saveCfg("bgzoom:" + sl, Math.max(50, z - 5));
      else if (b === "up") saveCfg("bgy:" + sl, Math.max(0, by - 4));
      else if (b === "down") saveCfg("bgy:" + sl, Math.min(100, by + 4));
      else if (b === "left") saveCfg("bgx:" + sl, Math.max(0, bx - 4));
      else if (b === "right") saveCfg("bgx:" + sl, Math.min(100, bx + 4));
      else if (b === "ctr") { saveCfg("bgx:" + sl, 50); saveCfg("bgy:" + sl, 50); }
      else return;
      render(_lastState);
    });
    bodyEl.appendChild(bg);
    // кнопка менеджера моделей (классы + персональные): превью, замена, зеркало, оптимизация
    var mmBtn = document.createElement("button");
    mmBtn.className = "qs-objp-pm";
    mmBtn.textContent = "🎭 Модели классов и персональные";
    mmBtn.addEventListener("click", function () { openModelManager(); });
    bodyEl.appendChild(mmBtn);

    // Заменить модель: подгрузить новую картинку — старая меняется РОВНО на месте (позиция/размер
    // сохраняются). uploadKey: для встроенных — overrideKey(ключ), для ENV — их собственный ключ.
    function replaceModel(uploadKey) {
      var f = document.createElement("input");
      f.type = "file"; f.accept = "image/png,image/webp,image/jpeg";
      f.addEventListener("change", function () {
        var file = f.files[0]; if (!file) return;
        fileToDataURL(file, function (dataUrl) {
          // авто-оптимизация при замене (ужать до оптимальных параметров)
          optimizeDataUrl(dataUrl, function (opt) {
            q("POST", "/queue/admin/model-upload", { key: uploadKey, data: opt || dataUrl }).then(function () {
              UPLOADED[uploadKey] = Date.now();   // меняющийся ?v — сбить кэш, показать новую картинку
              render(_lastState);
            }).catch(function (e) { alert("Не удалось заменить модель: " + (e.detail || e.message)); });
          });
        }, function (m) { alert(m); });
      });
      f.click();
    }
    // оптимизировать УЖЕ загруженную замену объекта (по ключу override), с уведомлением
    function optimizeObj(uploadKey, label) {
      if (!uploadedUrl(uploadKey)) { alert("У «" + label + "» нет загруженной картинки для оптимизации (встроенная уже оптимальна)."); return; }
      optimizeExisting(uploadKey, function (okk) {
        if (okk) render(_lastState); else alert("Не удалось оптимизировать «" + label + "».");
      });
    }

    var MStep = 1.5, SStep = 0.1;
    // картинка-миниатюра объекта для строки панели (учитывает загруженную замену модели)
    function objThumb(o) {
      if (o.env) return uploadedUrl(o.env.key) || "";
      var k = o.key || "", d = "";
      if (k.indexOf("lavka:") === 0) d = "assets/queue/scene/lavka-" + k.slice(6) + ".webp?v=3";
      else if (k.indexOf("cnt:") === 0) d = "assets/queue/ui/board-idle.webp?v=1";
      else if (k === "mount") d = "assets/queue/scene/item/mount-cilin.webp";
      else if (k === "fountain") d = "assets/queue/scene/fountain-" + (isNight() ? "night" : "day") + ".webp?v=1";
      else if (k === "wallet") d = "assets/queue/ui/wallet2.webp?v=1";
      else if (k.indexOf("btn-join:") === 0) d = "assets/queue/ui/join-green-dim.webp?v=3";
      else if (k.indexOf("btn-list:") === 0) d = "assets/queue/ui/list-normal.webp?v=2";
      else return "";
      return objImgSrc(k, d);
    }
    // html имени строки с миниатюрой слева (эмодзи-заглушка, если картинки нет/битая — напр. очередь)
    function nameHtml(o, emoji) {
      var t = objThumb(o), ic;
      if (!t) ic = emoji ? '<span class="qs-objp-em">' + emoji + "</span>" : "";
      else if (emoji) {
        // есть картинка + запасной эмодзи: если картинка битая, прячем img и показываем эмодзи
        ic = '<span class="qs-objp-ic"><img class="qs-objp-th" src="' + esc(t) + '" alt="" ' +
          'onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'">' +
          '<span class="qs-objp-em" style="display:none">' + emoji + "</span></span>";
      } else {
        // встроенный объект: картинка всегда есть; на всякий случай прячем img при ошибке
        ic = '<img class="qs-objp-th" src="' + esc(t) + '" alt="" onerror="this.style.display=\'none\'">';
      }
      return '<div class="qs-objp-nm">' + ic + "<span>" + fmtName(o.name) + "</span></div>";
    }
    // имя строки: тип (до «·») — золотом и жирным, очередь/деталь — тускло (чтобы не путать строки)
    function fmtName(name) {
      var i = name.indexOf(" · ");
      if (i < 0) return esc(name);
      return '<b style="color:#ffe0a0">' + esc(name.slice(0, i)) + '</b><span style="color:#b89a6a"> · ' + esc(name.slice(i + 3)) + "</span>";
    }
    // подсветка активной кнопки слоя: on-класс, если текущий слой совпадает
    function zBtns(curZ) {
      return '<span class="qs-objp-z">' +
        '<button data-a="front" class="' + (curZ === "front" ? "on" : "") + '" title="на передний план">перёд</button>' +
        '<button data-a="back" class="' + (curZ === "back" ? "on" : "") + '" title="на задний план">зад</button>' +
        '<button data-a="auto" class="' + (!curZ ? "on" : "") + '" title="авто по глубине">авто</button>' +
      "</span>";
    }
    objs.forEach(function (o) {
      var row = document.createElement("div");
      row.className = "qs-objp-row";
      // ── строка ОЧЕРЕДИ: только слой (перёд/зад/авто) для всех людей очереди ──
      if (o.queue !== undefined) {
        var qz = CONFIG["qz:" + o.queue] || "";
        row.innerHTML = nameHtml(o, "👥") +
          '<div class="qs-objp-ctl">' + zBtns(qz) + "</div>";
        row.addEventListener("click", function (e) {
          var btn = e.target.closest("button"); if (!btn) return;
          var a = btn.dataset.a;
          if (a === "front") saveCfg("qz:" + o.queue, "front");
          else if (a === "back") saveCfg("qz:" + o.queue, "back");
          else if (a === "auto") saveCfg("qz:" + o.queue, "");
          else return;
          render(_lastState);
        });
        bodyEl.appendChild(row);
        return;
      }
      // ── строка ENV-предмета (загруженная картинка): перемещение + размер(w) + зеркало + слой + удалить ──
      if (o.env) {
        var ev = o.env;
        var evz = (PLACEMENTS["env:" + ev.id] && PLACEMENTS["env:" + ev.id].z) || ev.z || "depth";
        var evzn = evz === "front" ? "front" : evz === "back" ? "back" : "";   // depth == авто
        row.innerHTML =
          nameHtml(o, "📦") +
          '<div class="qs-objp-ctl">' +
            '<span class="qs-objp-pad">' +
              '<button data-a="up" title="выше">▲</button>' +
              '<span class="qs-objp-lr"><button data-a="left" title="левее">◀</button>' +
              '<button data-a="ctr" title="в центр">◎</button>' +
              '<button data-a="right" title="правее">▶</button></span>' +
              '<button data-a="down" title="ниже">▼</button>' +
            "</span>" +
            '<span class="qs-objp-sz"><button data-a="sz-" title="меньше">−</button>' +
              '<b class="qs-objp-szv">' + ((+ev.w) || 18) + '%</b><button data-a="sz+" title="больше">+</button></span>' +
            '<button data-a="flip" class="qs-objp-flip' + (ev.flip ? " on" : "") + '" title="зеркалить">⇋</button>' +
            '<button data-a="repl" class="qs-objp-repl" title="заменить модель (новая встанет на то же место)">🖼</button>' +
            '<button data-a="opt" class="qs-objp-opt" title="оптимизировать картинку">🗜</button>' +
            zBtns(evzn) +
            '<button data-a="del" class="qs-objp-del" title="убрать из сцены">✕</button>' +
          "</div>";
        row.addEventListener("click", function (e) {
          var btn = e.target.closest("button"); if (!btn) return;
          var a = btn.dataset.a, ek = "env:" + ev.id, p = curPlace(ek, 50, 55);
          if (a === "repl") { replaceModel(ev.key); return; }   // замена картинки того же ключа — на месте
          if (a === "opt") { optimizeObj(ev.key, o.name); return; }   // оптимизировать этот предмет
          if (a === "up") savePlacement(ek, p.x, p.y - MStep, p.z);
          else if (a === "down") savePlacement(ek, p.x, p.y + MStep, p.z);
          else if (a === "left") savePlacement(ek, p.x - MStep, p.y, p.z);
          else if (a === "right") savePlacement(ek, p.x + MStep, p.y, p.z);
          else if (a === "ctr") savePlacement(ek, 50, 50, p.z);
          else if (a === "front") { savePlacement(ek, p.x, p.y, "front"); ev.z = "front"; saveEnv(); }
          else if (a === "back") { savePlacement(ek, p.x, p.y, "back"); ev.z = "back"; saveEnv(); }
          else if (a === "auto") { savePlacement(ek, p.x, p.y, ""); ev.z = "depth"; saveEnv(); }
          else if (a === "sz+") { ev.w = Math.min(80, ((+ev.w) || 18) + 2); saveEnv(); }
          else if (a === "sz-") { ev.w = Math.max(3, ((+ev.w) || 18) - 2); saveEnv(); }
          else if (a === "flip") { ev.flip = ev.flip ? 0 : 1; saveEnv(); }
          else if (a === "del") { if (!confirm("Убрать предмет из сцены?")) return; ENV = ENV.filter(function (x) { return x.id !== ev.id; }); saveEnv(); }
          else return;
          render(_lastState);
        });
        bodyEl.appendChild(row);
        return;
      }
      // ── СКРЫТЫЙ встроенный объект: компактная строка с кнопкой «вернуть» ──
      if (isHidden(o.key)) {
        row.className = "qs-objp-row hidden";
        row.innerHTML = nameHtml(o, "🚫") +
          '<button data-a="show" class="qs-objp-restore">↩ вернуть на сцену</button>';
        row.addEventListener("click", function (e) {
          if (!e.target.closest("button")) return;
          saveCfg("hide:" + o.key, "0"); render(_lastState);
        });
        bodyEl.appendChild(row);
        return;
      }
      // ── строка ОБЪЕКТА: перемещение + размер + зеркало + слой + удалить(скрыть) ──
      var szTxt = o.sz ? objSize(o.key, o.base).toFixed(2) + "×" : "";
      var curZ = (PLACEMENTS[o.key] && PLACEMENTS[o.key].z) || "";
      row.innerHTML =
        nameHtml(o) +
        '<div class="qs-objp-ctl">' +
          '<span class="qs-objp-pad">' +
            '<button data-a="up" title="выше">▲</button>' +
            '<span class="qs-objp-lr"><button data-a="left" title="левее">◀</button>' +
            '<button data-a="ctr" title="в центр">◎</button>' +
            '<button data-a="right" title="правее">▶</button></span>' +
            '<button data-a="down" title="ниже">▼</button>' +
          "</span>" +
          (o.sz ? '<span class="qs-objp-sz"><button data-a="sz-" title="меньше">−</button>' +
            '<b class="qs-objp-szv">' + szTxt + '</b><button data-a="sz+" title="больше">+</button></span>' : "") +
          (o.flip ? '<button data-a="flip" class="qs-objp-flip' + (isFlipped(o.key) ? " on" : "") + '" title="зеркалить">⇋</button>' : "") +
          (o.repl ? '<button data-a="repl" class="qs-objp-repl" title="заменить модель (новая встанет на то же место)">🖼</button>' : "") +
          (o.repl && uploadedUrl(overrideKey(o.key)) ? '<button data-a="opt" class="qs-objp-opt" title="оптимизировать загруженную картинку">🗜</button>' : "") +
          zBtns(curZ) +
          '<button data-a="hide" class="qs-objp-del" title="убрать со сцены (можно вернуть)">✕</button>' +
        "</div>";
      row.addEventListener("click", function (e) {
        var btn = e.target.closest("button"); if (!btn) return;
        var a = btn.dataset.a, p = curPlace(o.key, o.dx, o.dy);
        if (a === "opt") { optimizeObj(overrideKey(o.key), o.name); return; }
        if (a === "repl") { replaceModel(overrideKey(o.key)); return; }   // заменить встроенную модель на месте
        if (a === "up") savePlacement(o.key, p.x, p.y - MStep, p.z);
        else if (a === "down") savePlacement(o.key, p.x, p.y + MStep, p.z);
        else if (a === "left") savePlacement(o.key, p.x - MStep, p.y, p.z);
        else if (a === "right") savePlacement(o.key, p.x + MStep, p.y, p.z);
        else if (a === "ctr") savePlacement(o.key, 50, 50, p.z);
        else if (a === "front") savePlacement(o.key, p.x, p.y, "front");
        else if (a === "back") savePlacement(o.key, p.x, p.y, "back");
        else if (a === "auto") savePlacement(o.key, p.x, p.y, "");
        else if (a === "sz+") saveCfg("size:" + o.key, Math.min(3, objSize(o.key, o.base) + SStep).toFixed(2));
        else if (a === "sz-") saveCfg("size:" + o.key, Math.max(0.3, objSize(o.key, o.base) - SStep).toFixed(2));
        else if (a === "flip") saveCfg("flip:" + o.key, isFlipped(o.key) ? "0" : "1");
        else if (a === "hide") saveCfg("hide:" + o.key, "1");
        else return;
        render(_lastState);
      });
      bodyEl.appendChild(row);
    });

    // ── добавить свой предмет: загрузить картинку (PNG с вырезанным фоном) и сразу в сцену ──
    var add = document.createElement("div");
    add.className = "qs-objp-add";
    add.innerHTML =
      '<div class="qs-objp-add-h">➕ Добавить предмет в сцену</div>' +
      '<input class="qs-objp-add-nm" placeholder="название (дерево, бочка…)" autocomplete="off">' +
      '<input class="qs-objp-add-f" type="file" accept="image/png,image/webp,image/jpeg">' +
      '<button class="qs-objp-add-go">Загрузить и поставить</button>' +
      '<div class="qs-objp-add-st"></div>';
    var stEl = add.querySelector(".qs-objp-add-st");
    function aSt(m, ok) { stEl.textContent = m || ""; stEl.style.color = ok ? "#9fe0a0" : "#ff9a86"; }
    add.querySelector(".qs-objp-add-f").addEventListener("change", function () {
      var f = this.files[0]; if (f) assessImage(f, function (m, ok) { aSt("Оценка: " + m, ok); });
    });
    add.querySelector(".qs-objp-add-go").addEventListener("click", function () {
      var nm = add.querySelector(".qs-objp-add-nm").value.trim();
      var slug = envSlug(nm);
      if (!slug) { aSt("Укажи название."); return; }
      var file = add.querySelector(".qs-objp-add-f").files[0];
      if (!file) { aSt("Выбери картинку."); return; }
      aSt("Загрузка…", true);
      fileToDataURL(file, function (dataUrl) {
        optimizeDataUrl(dataUrl, function (opt) {   // авто-оптимизация нового предмета
          q("POST", "/queue/admin/model-upload", { key: "env-" + slug, data: opt || dataUrl }).then(function () {
            UPLOADED["env-" + slug] = Date.now();
            ENV.push({ id: envNextId(), key: "env-" + slug, w: 18, flip: 0, rotate: 0, z: "depth" });
            saveEnv();
            _scnScroll = 999999;   // прокрутить к новому предмету (он внизу списка)
            render(_lastState);
          }).catch(function (e) { aSt("Ошибка: " + (e.detail || e.message)); });
        });
      }, aSt);
    });
    bodyEl.appendChild(add);

    panel.appendChild(bodyEl);
    return panel;
  }

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
    // окно ПРАВИЛ — вверху, разворачивается, для всех
    if (!_pathMode && !_placeMode) wrap.appendChild(buildRulesPanel());
    // личное уведомление «не хватило доблести» — самым верхом, чтобы игрок сразу увидел
    if (!_pathMode && !_placeMode) { var _nb = buildNoticeBanner(); if (_nb) wrap.appendChild(_nb); }
    // свиток «Держатели жетонов ТОП-3» — сверху справа, виден всем, разворачивается кликом
    if (!_pathMode && !_placeMode) wrap.appendChild(buildTokenBoard());
    if (!_pathMode && !_placeMode) wrap.appendChild(buildTokenAd());  // «реклама» жетона ТОП-3 (всем)
    if (!_pathMode && !_placeMode) { var mt = buildMyTokens(); if (mt) wrap.appendChild(mt); }  // мои жетоны (сколько их)
    var sup = renderSuperAbility(); if (sup) wrap.appendChild(sup);   // суперспособность топ-3
    wrap.appendChild(renderStage(state));
    if (!_pathMode && !_placeMode) wrap.appendChild(buildChangeBanner());   // «можно менять ресурс до вс 16:00»
    wrap.appendChild(renderQueueStrips(state));   // 3 полосы полных очередей (всем)
    // переключатель пола своей модельки — внизу, для каждого вошедшего игрока
    if (!_pathMode && !_placeMode) { var _gp = buildGenderPicker(); if (_gp) wrap.appendChild(_gp); }
    if (_isAdmin) wrap.appendChild(adminPanel(state));
    else if (_role === "officer") {          // офицеру — связки + отметка «не забрал»
      wrap.appendChild(buildOfficerHeader());   // подпись «Офицерская панель — только у офицеров»
      wrap.appendChild(buildSpousePanel(true));
      wrap.appendChild(buildDuePanel(true));
      wrap.appendChild(buildHistoryPanel(true));
    }
    // правая fixed-панель управления объектами сцены — только админу (внутри wrap, чтобы
    // очищалась вместе со сценой и не плодила дубли; position:fixed не зависит от родителя).
    // Показываем и в режиме формы очередей — там её кнопка «Форма очередей» гасит режим.
    if (_isAdmin) wrap.appendChild(sceneObjPanel());
    host.appendChild(wrap);
    // вернуть прокрутку правой админ-панели (кнопки вызывают render — иначе перематывает наверх)
    var _pb = wrap.querySelector(".qs-objp-body"); if (_pb) _pb.scrollTop = _scnScroll;
    updatePageBg();   // ещё раз — теперь рамка в DOM, выравниваем фон-мир по её центру
    // Восстановить горизонтальную прокрутку полос СИНХРОННО (до отрисовки). Без этого при
    // ЛЮБОЙ перерисовке (join/leave в любой очереди) ВСЕ полосы вспыхивали прокруткой с 0
    // к сохранённой позиции — казалось, что «проматываются все разом».
    document.querySelectorAll(".qs-lane-strip").forEach(function (s) {
      var sq = s.dataset.q;
      if (sq != null && _stripScroll[sq] != null) s.scrollLeft = _stripScroll[sq];
    });
    // только что встал в очередь → прокрутить к себе + анимация появления (после отрисовки)
    if (_justJoined) { var _jj = _justJoined; _justJoined = null; setTimeout(function () { handleJustJoined(_jj); }, 150); }
  }

  // Прокрутка к только что вставшему + анимация появления. На СЦЕНЕ: если моделька в
  // пределах лимита показа — подсветить её; если за лимитом (её не видно) — открыть
  // список и промотать к ней. В ПОЛОСЕ: промотать влево к своей ячейке + анимация.
  // запустить cb, когда прокрутка el по свойству prop (scrollLeft/scrollTop) ОСТАНОВИТСЯ
  // (стабилизируется) — чтобы анимация появления показывалась ПОСЛЕ докрутки, а не во время.
  function whenScrollSettles(el, prop, cb, maxMs) {
    var last = -999999, stable = 0, t0 = Date.now();
    (function chk() {
      var pos = el[prop];
      if (pos === last) { if (++stable >= 3) { cb(); return; } }
      else { stable = 0; last = pos; }
      if (Date.now() - t0 > (maxMs || 1000)) { cb(); return; }
      requestAnimationFrame(chk);
    })();
  }

  function playAppear(el) {
    if (!el) return;
    el.classList.remove("qs-appear"); void el.offsetWidth; el.classList.add("qs-appear");
  }

  function handleJustJoined(jj) {
    if (!jj || !jj.canon) return;
    var entries = (_lastState.queues && _lastState.queues[jj.q]) || [];
    var myIdx = -1;
    for (var i = 0; i < entries.length; i++) {
      if (!entries[i].privileged && canon(entries[i].main_nick) === jj.canon) { myIdx = i; break; }
    }
    if (myIdx < 0) return;

    if (jj.src === "lane") {
      // ВСТАЛ ВНИЗУ: НЕ открывать список. Промотать ТОЛЬКО эту полосу к САМОМУ ЛЕВОМУ краю
      // (новенький рисуется слева) + анимация появления со свечением.
      var strip = document.querySelector('.qs-lane-strip[data-q="' + jj.q + '"]');
      if (strip) {
        var c = strip.querySelector(".qs-cell.me");
        // цель прокрутки — левый край моей ячейки (новенький слева). Надёжнее, чем «0».
        var target = c ? Math.max(0, c.offsetLeft - 6) : 0;
        _stripScroll[jj.q] = target;                // запомнить цель, чтобы не откатывалось
        strip.scrollTo({ left: target, behavior: "smooth" });
        // анимация появления — ПОСЛЕ того как полоса реально доехала
        if (c) whenScrollSettles(strip, "scrollLeft", function () { playAppear(c); }, 1100);
      }
      return;
    }

    // ВСТАЛ НА КАРТИНКЕ (касается ТОЛЬКО этой очереди): если моделька в пределах лимита
    // показа — просто нарисовать её с анимацией появления; если за лимитом (её не видно) —
    // открыть список ИМЕННО этой очереди и промотать вниз к своей строке с анимацией.
    var limit = Math.max(1, Math.round(getSize("limit", 6)));
    var meChar = document.querySelector('.qs-char.q-char-me[data-q="' + jj.q + '"]');
    if (myIdx < limit && meChar) {
      playAppear(meChar.querySelector(".qs-char-inner") || meChar);   // видна на картинке → просто анимация
    } else if (BOOTHS[jj.q]) {
      openFullList(BOOTHS[jj.q], entries, myIdx);
    }
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
    pbg.style.backgroundImage = "url('assets/queue/scene/world-" + (isNight() ? "night" : "day") + ".webp?v=4')";
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
            '<input type="number" id="qa-test-n" value="6" min="1" max="500" style="width:70px">' +
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
            '<label style="display:flex;flex-direction:column;gap:2px;font-size:11px;color:#caa66a" ' +
              'title="Размер моделей игроков на СЦЕНЕ по умолчанию. Перспектива (дальше=меньше) сохраняется. Полосу внизу не меняет.">' +
              'Размер моделей на сцене: <b id="qa-models-v">' + getSize("models", 1).toFixed(2) + '</b>' +
              '<input type="range" id="qa-models" min="0.4" max="1.6" step="0.05" value="' + getSize("models", 1) + '" style="width:240px"></label>' +
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
          '<div style="font-size:11.5px;color:#c9b48f;line-height:1.5;margin:-4px 0 8px;padding:7px 10px;' +
            'background:rgba(224,162,74,.08);border:1px solid rgba(224,162,74,.22);border-radius:9px">' +
            '👉 <b>Расставить предметы</b> — тащи мышкой предметы, торговца, питомца (позиция сохраняется). ' +
            '<b>Правый клик</b> по объекту в этом режиме — <b>слой: на передний план → на задний → авто</b>. ' +
            '<b>Форма очередей</b> — тащи точки пути очереди.</div>' +
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
            sizeSlider("mount", "Питомец") + sizeSlider("merch", "Торговцы") +
            sizeSlider("lavka", "Лавки", 0.4, 3) + sizeSlider("fountain", "Фонтан", 0.4, 3) +
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
      var n = Math.max(1, Math.min(500, +box.querySelector("#qa-test-n").value || 6));
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
    // объекты с inline-размером (перекрывают CSS-переменную) — обновляем перерисовкой по отпусканию
    var INLINE_SZ = { mount: 1, lavka: 1, fountain: 1 };
    ["frame", "char", "mount", "merch", "lavka", "fountain"].forEach(function (key) {
      var el = box.querySelector("#qa-sz-" + key), vl = box.querySelector("#qa-sz-" + key + "-v"), t;
      el.addEventListener("input", function () {
        var v = +el.value; vl.textContent = v.toFixed(2) + "×";
        if (key === "frame") { var w = document.querySelector(".qs-wrap"); if (w) w.style.maxWidth = Math.round(1340 * v) + "px"; }
        else { var s = document.querySelector(".qs-stage"); if (s) s.style.setProperty("--qs-" + key + "-scale", v); }
        clearTimeout(t); t = setTimeout(function () { saveCfg("size:" + key, v); }, 300);
      });
      // для inline-объектов — перерисовать после отпускания, чтобы размер применился к картинке
      if (INLINE_SZ[key]) el.addEventListener("change", function () { saveCfg("size:" + key, +el.value); render(_lastState); });
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
    // глобальный размер моделей на СЦЕНЕ (× перспектива). Полосу внизу не трогает.
    var mEl = box.querySelector("#qa-models"), mV = box.querySelector("#qa-models-v");
    if (mEl) {
      mEl.addEventListener("input", function () { mV.textContent = (+mEl.value).toFixed(2); });
      mEl.addEventListener("change", function () { saveCfg("size:models", +mEl.value); render(_lastState); });
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
    // СОХРАНЯЕМ раскрытость секций между перерисовками: при клике любой кнопки render()
    // пересобирает панель — без этого все разделы схлопывались каждый раз.
    [].forEach.call(box.querySelectorAll("details.q-sec"), function (d, i) {
      if (_secOpen[i] !== undefined) d.open = _secOpen[i];
      d.addEventListener("toggle", function () { _secOpen[i] = d.open; });
    });
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
  // насколько «оптимальна» модель по её деталям (из /queue/models-info)
  function optRating(info) {
    if (!info) return { cls: "na", txt: "нет данных", pct: 0 };
    var kb = Math.round((info.bytes || 0) / 1024), mx = Math.max(info.w || 0, info.h || 0);
    if (kb > 350 || mx > 1800) return { cls: "bad", txt: "⚠ тяжёлая · " + kb + " КБ · " + info.w + "×" + info.h, pct: 30 };
    if (kb > 180 || mx > 1300) return { cls: "mid", txt: "◐ норм, можно легче · " + kb + " КБ · " + info.w + "×" + info.h, pct: 65 };
    return { cls: "good", txt: "✓ оптимально · " + kb + " КБ · " + info.w + "×" + info.h, pct: 100 };
  }
  // ужать картинку (dataURL) до целевых параметров: ≤1000 px по большей стороне, WebP q0.85
  function optimizeDataUrl(dataUrl, cb) {
    var img = new Image();
    img.onload = function () {
      var w = img.naturalWidth, h = img.naturalHeight, mx = Math.max(w, h);
      var s = Math.min(1, 1000 / (mx || 1)), nw = Math.round(w * s), nh = Math.round(h * s);
      var cv = document.createElement("canvas"); cv.width = nw; cv.height = nh;
      cv.getContext("2d").drawImage(img, 0, 0, nw, nh);
      var out = cv.toDataURL("image/webp", 0.85);
      cb(out, { w: nw, h: nh, kb: Math.round(out.length * 0.75 / 1024) });
    };
    img.onerror = function () { cb(null); };
    img.src = dataUrl;
  }
  // оптимизировать УЖЕ загруженную модель по ключу (перекодировать и залить обратно)
  function optimizeExisting(key, cb) {
    var url = uploadedUrl(key); if (!url) { cb(false); return; }
    var img = new Image(); img.crossOrigin = "anonymous";
    img.onload = function () {
      var w = img.naturalWidth, h = img.naturalHeight, s = Math.min(1, 1000 / (Math.max(w, h) || 1));
      var nw = Math.round(w * s), nh = Math.round(h * s);
      var cv = document.createElement("canvas"); cv.width = nw; cv.height = nh;
      cv.getContext("2d").drawImage(img, 0, 0, nw, nh);
      var out = cv.toDataURL("image/webp", 0.85);
      q("POST", "/queue/admin/model-upload", { key: key, data: out })
        .then(function () { UPLOADED[key] = Date.now(); cb(true); })
        .catch(function () { cb(false); });
    };
    img.onerror = function () { cb(false); };
    img.src = url;
  }
  // ── МЕНЕДЖЕР МОДЕЛЕЙ (админ): все классовые + персональные — превью, оптимизация,
  //    замена, зеркало, удаление. Открывается кнопкой из правой панели. ──
  function openModelManager() {
    var body = document.createElement("div");
    body.className = "qs-mm";
    body.innerHTML = '<div class="qs-mm-empty">Загрузка моделей…</div>';
    sceneModal("🎭 Модели персонажей и классов", body);
    var INFO = {};
    function loadInfo(cb) {
      q("GET", "/queue/models-info").then(function (d) {
        INFO = {}; (d.models || []).forEach(function (x) { INFO[x.key] = x; }); cb();
      }).catch(function () { cb(); });
    }
    function nickByCanon(cn) {
      var p = (_roster || []).filter(function (r) { return canon(r.nick) === cn || canon(r.main_nick || "") === cn; })[0];
      return p ? p.nick : cn;
    }
    function pickFile(onData, stEl) {
      var f = document.createElement("input"); f.type = "file"; f.accept = "image/png,image/webp,image/jpeg";
      f.addEventListener("change", function () {
        var file = f.files[0]; if (!file) return;
        fileToDataURL(file, function (du) { optimizeDataUrl(du, function (opt) { onData(opt || du); }); },
          function (m) { if (stEl) stEl.textContent = m; });
      });
      f.click();
    }
    // o: {uploadKey, staticKey, title, sub, kind:'class'|'person'}
    function card(o) {
      var up = UPLOADED[o.uploadKey];                 // загружена ли своя (override)
      var sKey = up ? o.uploadKey : (o.staticKey || o.uploadKey);   // ключ настроек = как рендерится
      var thumb = up ? uploadedUrl(o.uploadKey) : (o.staticKey ? webpUrl(o.staticKey) : "");
      var ms = MODEL_SETTINGS[sKey] || {};
      var rateHtml;
      if (up) { var r = optRating(INFO[o.uploadKey]); rateHtml = '<div class="qs-mm-rate ' + r.cls + '">' + r.txt + " · <b>своя</b></div>"; }
      else if (o.staticKey) rateHtml = '<div class="qs-mm-rate na">📦 встроенная (общая) модель</div>';
      else rateHtml = '<div class="qs-mm-rate na">— нет модели</div>';
      var el = document.createElement("div"); el.className = "qs-mm-card";
      el.innerHTML =
        (thumb ? '<img class="qs-mm-th" src="' + esc(thumb) + '" alt="" onerror="this.style.visibility=\'hidden\'">'
               : '<div class="qs-mm-th qs-mm-noimg">нет модели</div>') +
        '<div class="qs-mm-info"><div class="qs-mm-name">' + esc(o.title) + "</div>" +
          (o.sub ? '<div class="qs-mm-sub">' + esc(o.sub) + "</div>" : "") + rateHtml + "</div>" +
        '<div class="qs-mm-btns">' +
          '<button data-a="repl">📤 ' + (up ? "заменить" : "загрузить свою") + "</button>" +
          (thumb ? '<button data-a="flip" class="' + (ms.flip ? "on" : "") + '" title="зеркалить ' +
                   (o.kind === "class" ? "(всех этого класса)" : "(этого персонажа)") + '">⇋</button>' : "") +
          (thumb ? '<button data-a="aura" class="qs-mm-aura' + (ms.aura === "death" ? " on" : "") +
                   '" title="зловещая чёрная дымка вокруг этой модели (аура смерти) — видна, когда игрок на неё сменится">☠ дымка</button>' : "") +
          (up ? '<button data-a="opt" title="ужать до оптимальных параметров">🗜 оптимизировать</button>' +
                '<button data-a="del" class="danger" title="удалить свою (вернётся встроенная)">✕</button>' : "") +
          (o.kind === "person" ? '<button data-a="addv" class="qs-mm-addv" title="добавить ещё один облик этому игроку — он сам выберет">➕ ещё облик</button>' : "") +
        '</div><div class="qs-mm-st"></div>';
      var stEl = el.querySelector(".qs-mm-st");
      el.addEventListener("click", function (e) {
        var btn = e.target.closest("button"); if (!btn) return;
        var a = btn.dataset.a;
        if (a === "repl") {
          pickFile(function (data) {
            stEl.textContent = "Загрузка…";
            q("POST", "/queue/admin/model-upload", { key: o.uploadKey, data: data }).then(function () {
              UPLOADED[o.uploadKey] = Date.now(); refresh(); loadInfo(rebuild);
            }).catch(function (er) { stEl.textContent = "Ошибка: " + (er.detail || er.message); });
          }, stEl);
        } else if (a === "flip") {
          var cur = MODEL_SETTINGS[sKey] || {}, nf = cur.flip ? 0 : 1;
          MODEL_SETTINGS[sKey] = { flip: nf, rotate: cur.rotate || 0, scale: cur.scale || 1, aura: cur.aura || "" };
          q("POST", "/queue/admin/model", { key: sKey, flip: nf, rotate: cur.rotate || 0, scale: cur.scale || 1, aura: cur.aura || "" })
            .then(function () { refresh(); rebuild(); });
        } else if (a === "aura") {   // включить/выключить зловещую чёрную дымку у этой модели
          var cua = MODEL_SETTINGS[sKey] || {}, na = cua.aura === "death" ? "" : "death";
          MODEL_SETTINGS[sKey] = { flip: cua.flip || 0, rotate: cua.rotate || 0, scale: cua.scale || 1, aura: na };
          q("POST", "/queue/admin/model", { key: sKey, flip: cua.flip || 0, rotate: cua.rotate || 0, scale: cua.scale || 1, aura: na })
            .then(function () { refresh(); rebuild(); });
        } else if (a === "opt") {
          stEl.textContent = "Оптимизирую…";
          optimizeExisting(o.uploadKey, function (okk) { if (okk) { refresh(); loadInfo(rebuild); } else stEl.textContent = "Не удалось оптимизировать"; });
        } else if (a === "del") {
          if (!confirm("Удалить загруженную модель «" + o.title + "»? Вернётся встроенная (если есть).")) return;
          q("POST", "/queue/admin/model-delete", { key: o.uploadKey }).then(function () {
            delete UPLOADED[o.uploadKey]; refresh(); loadInfo(rebuild);
          });
        } else if (a === "addv") {   // добавить ЕЩЁ один облик этому же игроку (следующий слот)
          var mm = o.uploadKey.match(/^person-(.+?)(?:--\d+)?$/);
          var cn = mm ? mm[1] : o.uploadKey.slice(7);
          var base = "person-" + cn, key, n = 2;
          if (!UPLOADED[base] && !PERSONAL[cn]) key = base;
          else { while (UPLOADED[base + "--" + n]) n++; key = base + "--" + n; }
          pickFile(function (data) {
            stEl.textContent = "Загрузка…";
            q("POST", "/queue/admin/model-upload", { key: key, data: data }).then(function () {
              UPLOADED[key] = Date.now(); refresh(); loadInfo(rebuild);
            }).catch(function (er) { stEl.textContent = "Ошибка: " + (er.detail || er.message); });
          }, stEl);
        }
      });
      return el;
    }
    function rebuild() {
      body.innerHTML = "";
      body.appendChild((function () { var d = document.createElement("div"); d.className = "qs-mm-lead";
        d.innerHTML = "«Загрузить свою» кладёт индивидуальную картинку поверх встроенной. " +
          "📦 встроенная — общая модель класса. Зеркало общей модели отражает всех персонажей этого класса."; return d; })());
      // ── ОБЩИЕ (классовые) модели ──
      var clsSet = {};
      ["Воин", "Жрец", "Маг", "Друид", "Стрелок", "Оборотень", "Странник"].forEach(function (c) { clsSet[c] = 1; });
      (_roster || []).forEach(function (p) { if (p.cls) clsSet[p.cls] = 1; });
      var h1 = document.createElement("div"); h1.className = "qs-mm-h"; h1.textContent = "🛡 Общие модели — по классам (муж/жен)";
      body.appendChild(h1);
      var g1 = document.createElement("div"); g1.className = "qs-mm-grid";
      Object.keys(clsSet).sort().forEach(function (cls) {
        var set = CLASS_MODEL[(cls || "").toLowerCase()];
        classGenders(cls).forEach(function (g) {
          var fn = set ? (set[g] || set.m || set.f) : null;
          g1.appendChild(card({
            uploadKey: "class-" + cls + "-" + g, staticKey: fn ? "class/" + fn : null,
            title: cls + " (" + (g === "m" ? "муж" : "жен") + ")", kind: "class"
          }));
        });
      });
      body.appendChild(g1);
      // ── ПЕРСОНАЛЬНЫЕ модели ──
      var h2 = document.createElement("div"); h2.className = "qs-mm-h"; h2.textContent = "👤 Персональные модели (игроку и его твинам)";
      body.appendChild(h2);
      var add = document.createElement("div"); add.className = "qs-mm-addp";
      // список ВСЕХ ников из реестра/доблести (мэйны и твины) — можно выбрать заранее, даже если
      // человек ещё не в очереди. Модель привязывается к МЭЙН-аккаунту (и достаётся всем его твинам).
      var rosterOpts = (_roster || []).slice().sort(function (a, b) {
        return (a.nick || "").localeCompare(b.nick || "", "ru");
      }).map(function (p) {
        var lbl = p.is_twin ? ("твин · мэйн " + (p.main_nick || "")) : (p.cls || "мэйн");
        return '<option value="' + esc(p.nick) + '">' + esc(lbl) + "</option>";
      }).join("");
      add.innerHTML = '<input class="qs-mm-nick" list="qs-mm-roster-dl" placeholder="ник из реестра/доблести…" autocomplete="off">' +
        '<datalist id="qs-mm-roster-dl">' + rosterOpts + "</datalist>" +
        '<button class="qs-mm-addbtn">➕ добавить персональную</button>' +
        '<span class="qs-mm-addhint">выбери ник из списка (мэйны и твины) — можно ЗАРАНЕЕ, даже если он ещё не в очереди. ' +
          'Модель привяжется к мэйн-аккаунту и достанется всем его твинам. Можно добавить несколько — игрок сам выберет облик.</span>' +
        '<span class="qs-mm-addres" style="flex:1 1 100%;font:600 11px system-ui;color:#8fc36a;min-height:14px"></span>';
      var addRes = add.querySelector(".qs-mm-addres");
      var addInp = add.querySelector(".qs-mm-nick");
      // подсказка: к какому мэйну привяжется (обновляется при вводе)
      function resolveMain(nk) {
        var p = (_roster || []).filter(function (r) {
          return canon(r.nick) === canon(nk) || canon(r.main_nick || "") === canon(nk);
        })[0];
        return p ? { nick: (p.main_nick || p.nick), found: true, twin: p.is_twin && canon(p.nick) === canon(nk) } : { nick: nk, found: false };
      }
      addInp.addEventListener("input", function () {
        var nk = addInp.value.trim();
        if (!nk) { addRes.textContent = ""; return; }
        var r = resolveMain(nk);
        addRes.style.color = r.found ? "#8fc36a" : "#e0a86a";
        addRes.textContent = r.found
          ? ("✓ привяжется к мэйну: " + r.nick + (r.twin ? " (ты выбрал твина — модель будет у мэйна и всех твинов)" : ""))
          : "⚠ ника нет в реестре/доблести — проверь написание (можно выбрать из списка)";
      });
      add.querySelector(".qs-mm-addbtn").addEventListener("click", function () {
        var nk = addInp.value.trim(); if (!nk) return;
        var r = resolveMain(nk);
        if (!r.found && !confirm("Ник «" + nk + "» не найден в реестре/доблести. Всё равно добавить модель по этому нику?")) return;
        var cn = canon(r.nick), base = "person-" + cn;   // ключ по МЭЙН-канону
        // следующий свободный слот: базовая, затем --2, --3… (не затираем ни встроенную, ни прежние)
        var key;
        if (!UPLOADED[base] && !PERSONAL[cn]) key = base;
        else { var n = 2; while (UPLOADED[base + "--" + n]) n++; key = base + "--" + n; }
        pickFile(function (data) {
          addRes.style.color = "#8fc36a"; addRes.textContent = "Загрузка…";
          q("POST", "/queue/admin/model-upload", { key: key, data: data }).then(function () {
            UPLOADED[key] = Date.now(); addInp.value = ""; addRes.textContent = "✓ добавлено мэйну: " + r.nick;
            refresh(); loadInfo(rebuild);
          }).catch(function (er) { addRes.style.color = "#e0a86a"; addRes.textContent = "Ошибка: " + (er.detail || er.message); });
        });
      });
      body.appendChild(add);
      // встроенные (PERSONAL_SRC) + загруженные (person-<canon> и слоты --N) — КАЖДЫЙ вариант отдельной карточкой
      var persMap = {};   // uploadKey -> карточка
      Object.keys(PERSONAL_SRC).forEach(function (name) {
        var cn = canon(name), uk = "person-" + cn;
        persMap[uk] = { uploadKey: uk, staticKey: "personal/" + PERSONAL_SRC[name], title: name, kind: "person" };
      });
      Object.keys(UPLOADED).filter(function (k) { return k.indexOf("person-") === 0; }).forEach(function (k) {
        var mm = k.match(/^person-(.+?)(?:--(\d+))?$/);
        var cn = mm ? mm[1] : k.slice(7), slot = (mm && mm[2]) ? mm[2] : "";
        if (!persMap[k]) persMap[k] = { uploadKey: k, staticKey: null,
          title: nickByCanon(cn) + (slot ? " · вариант " + slot : ""), kind: "person" };
      });
      var g2 = document.createElement("div"); g2.className = "qs-mm-grid";
      var pk = Object.keys(persMap);
      if (!pk.length) { var e = document.createElement("div"); e.className = "qs-mm-empty"; e.textContent = "Персональных моделей нет — добавь по нику выше."; g2.appendChild(e); }
      pk.sort(function (a, b) { return persMap[a].title.localeCompare(persMap[b].title, "ru"); })
        .forEach(function (uk) { var o = persMap[uk]; o.sub = "персональная"; g2.appendChild(card(o)); });
      body.appendChild(g2);
    }
    loadInfo(rebuild);
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
      '<div id="qdue-list" style="display:flex;flex-direction:column;gap:5px;max-height:280px;overflow:auto"></div>' +
      '<div style="margin-top:10px;padding-top:8px;border-top:1px dashed rgba(224,162,74,.25)">' +
        '<div style="font-size:12px;color:#caa66a">↩ Получившие на прошлой финализации — вернуть, если не забрал</div>' +
        '<div style="font-size:11.5px;color:#8a795a;margin:2px 0 8px">Если отметить «не забрал» не успели до вс 00:00 и человек уже вышел из очереди — верни его: встанет на СВОЁ прежнее место.</div>' +
        '<div id="qsrv-list" style="display:flex;flex-direction:column;gap:5px;max-height:220px;overflow:auto"></div>' +
      "</div>";
    var listHost = wrap.querySelector("#qdue-list");
    var srvHost = wrap.querySelector("#qsrv-list");
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
    function reloadServed() {
      q("GET", "/queue/served-last").then(function (d) {
        var served = d.served || [];
        srvHost.innerHTML = "";
        if (!served.length) {
          srvHost.innerHTML = '<span style="font-size:11.5px;color:#8a795a">Пусто — снимок появится после финализации недели (вс 00:00).</span>';
          return;
        }
        served.forEach(function (s) {
          var row = document.createElement("div");
          row.style.cssText = "display:flex;align-items:center;gap:9px;font-size:12.5px;color:#f6ead2;" +
            "padding:5px 8px;border:1px solid rgba(143,195,106,.22);border-radius:8px";
          var info = document.createElement("span"); info.style.cssText = "flex:1;min-width:0";
          info.innerHTML = '<b>' + esc(s.nick) + '</b> <span style="color:#a58c68">· ' + esc(QN[s.queue] || "") +
            "</span>" + (s.resource ? ' · ' + esc(s.resource) : "");
          row.appendChild(info);
          var btn = document.createElement("button");
          btn.className = "sec"; btn.textContent = "↩ Не забрал — вернуть";
          btn.addEventListener("click", function () {
            btn.disabled = true;
            q("POST", "/queue/restore-uncollected", { served_id: s.id }).then(function () {
              status("✓ " + s.nick + " возвращён в очередь на своё место", true);
              reloadServed(); refresh();
            }).catch(function (e) { btn.disabled = false; status("Ошибка: " + (e.detail || e.message)); });
          });
          row.appendChild(btn);
          srvHost.appendChild(row);
        });
      }).catch(function () {});
    }
    wrap.querySelector("#qdue-refresh").addEventListener("click", function () { reload(); reloadServed(); });
    reload();
    reloadServed();
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
      '<div class="q-admin-row" style="gap:6px;align-items:center;flex-wrap:wrap;background:rgba(224,162,74,.06);' +
        'border:1px dashed rgba(224,162,74,.3);border-radius:8px;padding:7px 9px">' +
        '<span style="font-size:11.5px;color:#caa66a">📨 Отчёты по диапазону этапов КХ ' +
          '<span style="color:#8a795a">(до 00:00 могут закрыть ещё этап — пришлю отчёт по каждому варианту в личку):</span></span>' +
        '<span style="font-size:12px;color:#f0dcb4">от <input type="number" id="qd-rng-from" min="0" max="7" value="' + stages + '" style="width:56px"> ' +
          'до <input type="number" id="qd-rng-to" min="0" max="7" value="' + Math.min(7, stages + 2) + '" style="width:56px"></span>' +
        '<button class="sec" id="qd-rng-send">📨 Прислать отчёты</button>' +
      "</div>" +
      '<div class="q-admin-row" style="flex-direction:column;align-items:stretch;gap:6px;margin-top:4px">' +
        '<div style="font-size:12px;color:#caa66a">🌟 Суперспособность топ-3 (жетоны «вне очереди») ' +
          '<button class="sec" id="qd-priv-btn" style="padding:2px 8px">↻ показать</button></div>' +
        '<div class="q-admin-row" style="gap:6px;align-items:center;flex-wrap:wrap">' +
          '<span style="font-size:11px;color:#8a795a">🎫 Выдать/снять жетоны ТОП-3 по никам мэйнов ' +
          '(можно несколько через запятую или с новой строки):</span>' +
          '<textarea id="qd-priv-nick" placeholder="ГромМэйн, ТихийОмут, Лирия!…" autocomplete="off" ' +
          'rows="2" style="min-width:220px;flex:1;resize:vertical"></textarea>' +
          '<input id="qd-priv-n" type="number" value="1" min="-50" max="50" style="width:64px" title="сколько жетонов каждому (минус — снять)">' +
          '<button class="sec" id="qd-priv-give">± выдать/снять каждому</button>' +
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
      var raw = wrap.querySelector("#qd-priv-nick").value.trim();
      var n = parseInt(wrap.querySelector("#qd-priv-n").value, 10) || 0;
      var nicks = raw.split(/[\n,;]+/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (!nicks.length || !n) { status("Укажи хотя бы один ник и число жетонов."); return; }
      status("Выдаю жетоны (" + nicks.length + ")…", true);
      var okList = [], errList = [];
      // последовательно, чтобы порядок и лог были предсказуемы
      var chain = Promise.resolve();
      nicks.forEach(function (nk) {
        chain = chain.then(function () {
          return q("POST", "/queue/admin/grant-token", { nick: nk, count: n })
            .then(function (d) { okList.push(d.nick + " → " + d.tokens); })
            .catch(function (e) { errList.push(nk + " (" + (e.status === 404 ? "не найден" : (e.detail || e.message)) + ")"); });
        });
      });
      chain.then(function () {
        var msg = (okList.length ? "✓ " + (n > 0 ? "выдано" : "снято") + ": " + okList.join(", ") : "");
        if (errList.length) msg += (msg ? " · " : "") + "⚠ ошибки: " + errList.join(", ");
        status(msg || "Ничего не изменено.", errList.length === 0);
        loadPriv();
      });
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
    wrap.querySelector("#qd-rng-send").addEventListener("click", function () {
      var f = Math.max(0, Math.min(7, parseInt(wrap.querySelector("#qd-rng-from").value, 10) || 0));
      var t = Math.max(0, Math.min(7, parseInt(wrap.querySelector("#qd-rng-to").value, 10) || 0));
      status("Готовлю отчёты по этапам " + Math.min(f, t) + "–" + Math.max(f, t) + "…");
      q("POST", "/queue/admin/distribute/send-range", { from_stages: f, to_stages: t }).then(function (d) {
        status("✓ Прислал в личку (@pw_spamer_bot) отчётов: " + ((d.sent || []).length), true);
      }).catch(function (e) { status("Ошибка: " + (e.detail || e.message)); });
    });
    wrap.querySelector("#qd-advance").addEventListener("click", function () {
      var curStages = parseInt(wrap.querySelector("#qd-stages").value, 10) || 0;
      var curPet = parseInt(wrap.querySelector("#qd-pet").value, 10) || 0;
      var testOn = wrap.querySelector("#qd-testmode").checked;
      if (!confirm("Финализировать неделю?\n\n⚠️ ПРОВЕРЬ ФИНАЛЬНЫЕ ЗНАЧЕНИЯ (можно менять хоть после 00:00 — пересчёт идёт от них):\n• Закрыто этапов КХ: " + curStages + "\n• Огненных цилиней: " + curPet + "\n\nЕсли позже закрыли ещё этап или уточнил цилиней — СНАЧАЛА поправь поля выше, потом финализируй.\n\nЧто произойдёт:\n1) убрать вылетевших из клана\n2) отчёт: " + (testOn ? "ТОЛЬКО тебе в личку @pw_spamer_bot (пробный режим)" : "в офицерский чат TG + VK") + "\n3) жетоны ТОП-3 — раздать\n4) сдвиг очереди: «не забрал» остаются; получившие с 🔁/планом — в конец, разово — выходят")) return;
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
    var hint = document.createElement("div");
    hint.style.cssText = "font:700 11px system-ui;color:#e6c48f;margin:2px 0 2px";
    hint.textContent = "↔ прокрути ленту вправо — там все модели (" + ALL_MODELS.length + " шт)";
    wrap.appendChild(hint);
    var strip = document.createElement("div");
    strip.className = "qa-model-strip";
    strip.style.cssText = "display:flex;gap:8px;overflow-x:auto;padding:8px 4px 10px;align-items:flex-end;max-width:100%;" +
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
          q("POST", "/queue/admin/model", { key: m.key, flip: s.flip, rotate: s.rotate, scale: s.scale,
            aura: (MODEL_SETTINGS[m.key] || {}).aura || "" }).catch(function () {});
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
    // заодно освежаем жетоны и свиток держателей (параллельно со /state, один render) —
    // чтобы возврат жетона (выход из записи ТОП-3) и любые изменения были видны сразу.
    var jobs = [q("GET", "/queue/state")];
    if (_meAcc) jobs.push(q("GET", "/queue/me")
      .then(function (m) { _myTokens = (m && m.tokens) || 0; _myGender = (m && m.gender) || ""; _myPreferClass = !!(m && m.prefer_class); _myVariant = (m && m.variant) || ""; }).catch(function () {}));
    jobs.push(q("GET", "/queue/token-board")
      .then(function (d) { if (d && d.holders) _tokenBoard = d.holders; }).catch(function () {}));
    return Promise.all(jobs).then(function (r) { render(r[0]); }).catch(function (e) {
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
        q("GET", "/auth/me").then(function (m) { _role = (m && m.role) || ""; _isAdmin = _role === "admin"; _officerName = (m && m.name) || ""; })
          .catch(function () { _role = ""; _isAdmin = false; _officerName = ""; }),
        q("GET", "/queue/me").then(function (m) { _myTokens = (m && m.tokens) || 0; _myGender = (m && m.gender) || ""; _myPreferClass = !!(m && m.prefer_class); _myVariant = (m && m.variant) || ""; }).catch(function () { _myTokens = 0; _myGender = ""; _myPreferClass = false; _myVariant = ""; }),
        q("GET", "/queue/notices").then(function (d) { _notices = (d && d.notices) || []; }).catch(function () { _notices = []; }),
        q("GET", "/queue/token-board").then(function (d) { _tokenBoard = (d && d.holders) || []; }).catch(function () { _tokenBoard = []; })
      ]).then(function () {
        // ОФИЦЕР может вставать в очередь как игрок (по своему нику из офиц. сессии) —
        // раньше ему писало «войди как игрок». Даём синтетический аккаунт, офиц.панель остаётся.
        if (!_meAcc && _role === "officer" && _officerName) {
          _meAcc = { main_nick: _officerName, main_canon: canon(_officerName), reg_nick: _officerName };
        }
        loadEnv(); refresh();
      });
    }
  };
})();
