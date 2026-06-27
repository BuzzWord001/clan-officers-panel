/* magic-social.js — соцсети единой «магической» линией вокруг заголовка.
   ВАРИАНТ B (2026-06-27): композиция универсальна на любом разрешении.
   Принцип: один параметрический расклад вместо трёх веток. Линия (корона над
   заголовком + хвост к девочке + спуск вдоль иконок) строится относительно
   ТЕКУЩЕГО заголовка; иконки сажаются ПРЯМО на линию через getPointAtLength —
   поэтому физически не могут с неё «слезть» при любой ширине. Девочка крепится
   к кончику хвоста (палец на бусине). Два режима — wide (десктоп/ноут, как ПК)
   и compact (планшет-портрет/телефон, тот же стиль компактно). Заголовок
   остаётся HTML (.glitch) и служит якорем — корона всегда обвивает его буквы.
   Совместимо с редактором magic-edit.js (window.__magicLine). */
(function () {
  "use strict";

  // порядок сверху вниз: Telegram, Чат ВК, TeamSpeak, Группа ВК
  var LINKS = [
    { key: "tg",       label: "Telegram",  glow: "#2aa6e4",
      href: "https://t.me/+6U3XCSrrZgo1YTMy", disp: "t.me/+6U3XCSrrZgo1YTMy",
      img: "assets/social/tg.png" },
    { key: "vk-chat",  label: "Чат ВК",    glow: "#f56a24",
      href: "https://vk.me/join/rya0CI_hEnkgsCQdahj2jIb3r0wD6OHIA_E=",
      disp: "vk.me/join/rya0CI_hEnkgsCQdahj2jIb3r0wD6OHIA_E=",
      img: "assets/social/vk-chat.png" },
    { key: "ts",       label: "TeamSpeak", glow: "#ff5e1c",
      href: "ts3server://melodybum.ts3.se", disp: "melodybum.ts3.se",
      img: "assets/social/ts.png" },
    { key: "vk-group", label: "Группа ВК", glow: "#f57a26",
      href: "https://vk.com/club38888207", disp: "vk.com/club38888207",
      img: "assets/social/vk-group.png" }
  ];

  var ICON = 58;            // базовый размер иконки (wide); compact уменьшает
  var WIDE_MIN = 980;       // ширина окна, с которой показываем «широкий» (ПК) расклад
  var REF_W = 652;          // опорная ширина заголовка, на которой оттюнен ПК-вид
  var SVGNS = "http://www.w3.org/2000/svg";
  var GIRL_AR = 760 / 343;  // соотношение сторон girl.png (h/w)
  var GIRL_TIPX = 0.111, GIRL_TIPY = 0.047; // доля от ширины/высоты до искры на пальце

  function el(tag, attrs) {
    var e = document.createElementNS(SVGNS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function copyToClipboard(text, btn) {
    function ok() {
      var o = btn.textContent; btn.textContent = "Скопировано ✓"; btn.classList.add("ok");
      setTimeout(function () { btn.textContent = o; btn.classList.remove("ok"); }, 1500);
    }
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.focus(); ta.select();
      try { document.execCommand("copy"); } catch (e) {}
      ta.remove();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(ok, function () { fallback(); ok(); });
    } else { fallback(); ok(); }
  }

  function glow(id, dev) {
    var f = el("filter", { id: id, x: "-90%", y: "-90%", width: "280%", height: "280%" });
    f.appendChild(el("feGaussianBlur", { stdDeviation: dev, result: "b" }));
    var m = el("feMerge", {});
    m.appendChild(el("feMergeNode", { in: "b" }));
    m.appendChild(el("feMergeNode", { in: "SourceGraphic" }));
    f.appendChild(m);
    return f;
  }

  // сглаживание (Catmull-Rom → Безье), идентично боевому и редактору
  function smooth(pts) {
    if (pts.length < 2) return pts.length ? "M" + pts[0].x + " " + pts[0].y : "";
    var d = "M" + pts[0].x + " " + pts[0].y;
    for (var i = 0; i < pts.length - 1; i++) {
      var p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || pts[i + 1];
      d += " C" + (p1.x + (p2.x - p0.x) / 6) + " " + (p1.y + (p2.y - p0.y) / 6) +
           " "  + (p2.x - (p3.x - p1.x) / 6) + " " + (p2.y - (p3.y - p1.y) / 6) +
           " "  + p2.x + " " + p2.y;
    }
    return d;
  }

  function titleRect() {
    var g = document.querySelector(".glitch");
    if (!g) return null;
    var range = document.createRange();
    range.selectNodeContents(g);
    var r = range.getBoundingClientRect();
    if (!r.width) return null;
    var sx = window.scrollX, sy = window.scrollY;
    var L = r.left + sx, R = r.right + sx, T = r.top + sy, B = r.bottom + sy;
    return { L: L, R: R, T: T, B: B, W: r.width, H: r.height,
             cx: L + r.width / 2, cy: T + r.height / 2 };
  }

  function buildOnce() {
    if (document.getElementById("magic-social")) return;

    var style = document.createElement("style");
    style.textContent =
      "#magic-social{position:absolute;top:0;left:0;width:100%;z-index:40;" +
        "pointer-events:none;display:none}" +
      "#magic-social.on{display:block}" +
      "#magic-social svg{position:absolute;top:0;left:0;width:100%;height:100%;overflow:visible}" +
      ".ms-aura{fill:none;stroke:#ff9a2e;stroke-width:13;stroke-linecap:round;" +
        "stroke-linejoin:round;filter:url(#msAura);opacity:.32}" +
      ".ms-spine{fill:none;stroke:url(#msGrad);stroke-width:5.5;stroke-linecap:round;" +
        "stroke-linejoin:round;filter:url(#msGlow);opacity:.97}" +
      ".ms-core{fill:none;stroke:#fff3d2;stroke-width:1.6;stroke-linecap:round;" +
        "stroke-linejoin:round;opacity:.85}" +
      ".ms-flow{fill:none;stroke:#fff6da;stroke-width:3;stroke-linecap:round;" +
        "filter:url(#msGlowS);stroke-dasharray:2 24;animation:msFlow 2.4s linear infinite}" +
      ".ms-node{fill:#ffe39a;filter:url(#msGlowS);animation:msPulse 2.8s ease-in-out infinite}" +
      ".ms-orb{filter:url(#msGlow);animation:msPulse 2.6s ease-in-out infinite}" +
      ".ms-orb-core{fill:#fff6e0;filter:url(#msGlowS)}" +
      // девочка на ПЕРЕДНЕМ плане (в оверлее z-40, позади линии — бусина на пальце).
      // На узких экранах НЕ прижимается к краю: уходит за правый край и обрезается
      // (html overflow-x:clip) — расположение 1-в-1 как на ПК (Лир 2026-06-27).
      ".ms-girl{position:absolute;pointer-events:none;display:none;height:auto;" +
        "filter:drop-shadow(0 5px 14px rgba(0,0,0,.5));z-index:0}" +
      ".ms-spark{fill:url(#msSpark);filter:url(#msGlowS)}" +
      "@keyframes msFlow{to{stroke-dashoffset:-39}}" +
      "@keyframes msPulse{0%,100%{opacity:.45}50%{opacity:1}}" +
      ".ms-ico{position:absolute;width:" + ICON + "px;height:" + ICON + "px;pointer-events:auto;" +
        "border-radius:14px;display:block;transition:transform .18s ease,filter .18s ease;" +
        "filter:drop-shadow(0 0 7px rgba(224,140,40,.5)) drop-shadow(0 3px 7px rgba(0,0,0,.6))}" +
      ".ms-ico img{width:100%;height:100%;display:block;-webkit-user-drag:none;user-select:none}" +
      ".ms-ico:hover{transform:scale(1.15);" +
        "filter:drop-shadow(0 0 18px var(--gc)) drop-shadow(0 0 7px var(--gc)) " +
        "drop-shadow(0 4px 9px rgba(0,0,0,.65))}" +
      ".ms-lbl{position:absolute;pointer-events:none;transform:translateX(-50%);" +
        "white-space:nowrap;padding:2px 9px;border-radius:8px;" +
        "background:rgba(20,13,7,.8);border:1px solid rgba(224,140,40,.45);" +
        "color:#f4dcb0;font:700 11px/1.25 system-ui,sans-serif;letter-spacing:.3px;" +
        "text-shadow:0 1px 2px #000;box-shadow:0 0 10px rgba(224,140,40,.25)}" +
      ".ms-pop{position:absolute;z-index:60;display:flex;align-items:center;gap:7px;" +
        "padding:6px 7px 6px 11px;border-radius:10px;max-width:265px;" +
        "background:rgba(18,12,7,.97);border:1px solid rgba(224,140,40,.5);" +
        "box-shadow:0 6px 20px rgba(0,0,0,.55),0 0 14px rgba(224,140,40,.22);" +
        "opacity:0;pointer-events:none;transform:translateY(-50%) translateX(-6px);" +
        "transition:opacity .16s ease,transform .16s ease}" +
      ".ms-pop.show{opacity:1;pointer-events:auto;transform:translateY(-50%) translateX(0)}" +
      ".ms-pop-url{font:600 11px/1.3 ui-monospace,Consolas,monospace;color:#f0d9af;" +
        "word-break:break-all;max-width:188px}" +
      ".ms-pop-copy{flex:none;cursor:pointer;border:1px solid rgba(224,140,40,.55);" +
        "background:linear-gradient(180deg,#3a2a14,#241809);color:#f4dcb0;" +
        "font:700 10px/1 system-ui,sans-serif;padding:7px 9px;border-radius:7px;white-space:nowrap}" +
      ".ms-pop-copy:hover{filter:brightness(1.15)}" +
      ".ms-pop-copy.ok{color:#cde8ac;border-color:#6fae5a}";
    document.head.appendChild(style);

    var root = document.createElement("div");
    root.id = "magic-social";

    // девочка — в оверлее (передний план), первой в DOM → позади линии, бусина
    // ложится на её палец сверху. Как на ПК.
    var girl = document.createElement("img");
    girl.className = "ms-girl";
    girl.alt = "";
    girl.src = "assets/girl.png?v=1794600000";
    root.appendChild(girl);
    root._girl = girl;

    var svg = el("svg", { preserveAspectRatio: "none" });
    var defs = el("defs", {});
    var grad = el("linearGradient", { id: "msGrad", x1: "0", y1: "0", x2: "0", y2: "1" });
    grad.appendChild(el("stop", { offset: "0",  "stop-color": "#ffe6a0" }));
    grad.appendChild(el("stop", { offset: ".35", "stop-color": "#ffae3a" }));
    grad.appendChild(el("stop", { offset: ".7", "stop-color": "#ef7c1e" }));
    grad.appendChild(el("stop", { offset: "1",  "stop-color": "#ff5e0f" }));
    defs.appendChild(grad);
    var sp = el("radialGradient", { id: "msSpark" });
    sp.appendChild(el("stop", { offset: "0", "stop-color": "#fffdf2" }));
    sp.appendChild(el("stop", { offset: ".5", "stop-color": "#ffd98a" }));
    sp.appendChild(el("stop", { offset: "1", "stop-color": "#ff8a1e", "stop-opacity": "0" }));
    defs.appendChild(sp);
    defs.appendChild(glow("msAura", 6));
    defs.appendChild(glow("msGlow", 2.6));
    defs.appendChild(glow("msGlowS", 1.5));
    svg.appendChild(defs);

    var motion = el("path", { id: "ms-motion-path", fill: "none", stroke: "none" });
    var aura  = el("path", { class: "ms-aura" });
    var spine = el("path", { class: "ms-spine", id: "ms-spine-path" });
    var core  = el("path", { class: "ms-core" });
    var flow  = el("path", { class: "ms-flow" });
    [motion, aura, spine, core, flow].forEach(function (p) { svg.appendChild(p); });

    for (var s = 0; s < 2; s++) {
      var c = el("circle", { class: "ms-spark", r: 3.4, cx: 0, cy: 0, opacity: "0" });
      var mo = el("animateMotion", { dur: (4.6 + s * 0.8) + "s", repeatCount: "indefinite",
                                     begin: (s * 2.0) + "s", rotate: "auto" });
      mo.appendChild(el("mpath", { href: "#ms-motion-path" }));
      var op = el("animate", { attributeName: "opacity", dur: (4.6 + s * 0.8) + "s",
                               repeatCount: "indefinite", begin: (s * 2.0) + "s",
                               values: "0;1;1;0", keyTimes: "0;.12;.88;1" });
      c.appendChild(mo); c.appendChild(op);
      svg.appendChild(c);
    }

    root.appendChild(svg);
    root._svg = svg; root._aura = aura; root._spine = spine; root._core = core;
    root._flow = flow; root._motion = motion; root._nodes = [];

    var icons = [];
    LINKS.forEach(function (L) {
      var a = document.createElement("a");
      a.className = "ms-ico";
      a.href = L.href;
      a.setAttribute("aria-label", L.label);
      a.style.setProperty("--gc", L.glow);
      if (L.key !== "ts") { a.target = "_blank"; a.rel = "noopener"; }
      a.innerHTML = '<img src="' + L.img + '?v=1792700000" alt="' + L.label + '">';
      root.appendChild(a);

      var lbl = document.createElement("div");
      lbl.className = "ms-lbl"; lbl.textContent = L.label;
      root.appendChild(lbl);

      var pop = document.createElement("div");
      pop.className = "ms-pop";
      var url = document.createElement("span");
      url.className = "ms-pop-url"; url.textContent = L.disp;
      var btn = document.createElement("button");
      btn.className = "ms-pop-copy"; btn.type = "button"; btn.textContent = "Копировать";
      btn.addEventListener("click", function (ev) {
        ev.preventDefault(); ev.stopPropagation(); copyToClipboard(L.href, btn);
      });
      pop.appendChild(url); pop.appendChild(btn);
      root.appendChild(pop);

      var timer;
      function show() { clearTimeout(timer); pop.classList.add("show"); }
      function hide() { timer = setTimeout(function () { pop.classList.remove("show"); }, 150); }
      a.addEventListener("mouseenter", show); a.addEventListener("mouseleave", hide);
      pop.addEventListener("mouseenter", show); pop.addEventListener("mouseleave", hide);

      icons.push({ a: a, lbl: lbl, pop: pop });
    });
    root._icons = icons;

    document.body.appendChild(root);
    layout();
  }

  // ── СТРОИМ ХРЕБЕТ ЛИНИИ. Возвращает {pts, iconPts, apex, tip, hasGirl}.
  //    Иконки = реальные узлы пути (smooth() проходит ЧЕРЕЗ них) → всегда на линии.
  //    Два расклада по реальному свободному месту:
  //      GUTTER — большой монитор (есть левое поле): корона + хвост к девочке +
  //               колонка иконок в левом жёлобе (как на ПК).
  //      LOOP   — ноут/планшет/телефон: петля (корона сверху + дуга-иконки под
  //               заголовком), девочка справа если есть место, иначе бусина.
  function buildSpine(tr, vw, topbarH, phone) {
    var L = tr.L, R = tr.R, T = tr.T, B = tr.B, cx = tr.cx, cy = tr.cy, W = tr.W;
    var kw = W / REF_W;                       // масштаб формы под размер заголовка
    var apexY = Math.max(T - 22 * kw, topbarH + 10);
    var mainW = Math.min(1360, vw * 0.95);
    var gutterR = (vw - mainW) / 2;           // ширина левого жёлоба (вне контента)
    var mr = vw - R;                          // свободное поле справа (под девочку)

    // средняя часть короны (правое плечо → вершина → левое плечо) — общая
    var crown = [
      { x: R + 24 * kw, y: B - 46 * kw },     // правый бок/стык
      { x: R - 14 * kw, y: B - 74 * kw },     // правый верхний угол
      { x: cx + W * 0.24, y: apexY },
      { x: cx,           y: apexY },          // вершина короны
      { x: cx - W * 0.24, y: apexY },
      { x: L - 4 * kw,   y: T - 8 * kw },     // левый верхний угол
      { x: L - 16 * kw,  y: cy }              // левая база
    ];

    // ── РАЗМЕЩЕНИЕ ДЕВОЧКИ + КОНЧИК ЛИНИИ. КЛЮЧЕВОЕ: если девочку приходится
    //    прижать к правому краю (не влезает), кончик линии (tip) пересчитываем
    //    ПОД ФАКТИЧЕСКИЙ палец → бусина всегда ровно на пальце на любом экране.
    function placeGirl() {
      var GW = clamp(Math.round(mr * 0.62), 120, 248);
      var GH = Math.round(GW * GIRL_AR);
      // УНИВЕРСАЛЬНО: левый край девочки = правый край видимой таблицы
      // (contentRight = vw - gutterR). Тело всегда ПРАВЕЕ таблицы и уходит за
      // правый край экрана (html overflow-x:clip обрезает) → таблицу НИКОГДА не
      // перекрывает, на любом ноуте/разрешении. Палец (и кончик линии) — у
      // правого края контента. На ПК позиция почти не меняется (она и так там).
      var contentRight = vw - gutterR;
      var gx = contentRight;
      var tipX = gx + GIRL_TIPX * GW;     // палец = кончик линии (бусина)
      var tipY = B + 86 * kw;
      var gy = tipY - GIRL_TIPY * GH;
      return { GW: GW, GH: GH, gx: gx, gy: gy, tipX: tipX, tipY: tipY, show: true };
    }
    // хвост-завиток от правой базы короны к кончику (пальцу девочки)
    function tail(tipX, tipY) {
      var dx = tipX - R;
      return [
        { x: tipX,            y: tipY },
        { x: R + dx * 0.80,   y: B + 52 * kw },
        { x: R + dx * 0.52,   y: B + 74 * kw },
        { x: R + dx * 0.20,   y: B + 52 * kw },
        { x: R + dx * 0.02,   y: B + 18 * kw },
        { x: R + 14 * kw,     y: B - 6 * kw }
      ];
    }

    var n = LINKS.length;
    // на телефоне (любая ориентация) — всегда LOOP без жёлоба и без девочки
    var GUTTER = !phone && gutterR >= ICON + 20;   // хватает места на колонку слева?

    if (GUTTER) {
      var g = placeGirl();
      var tg = tail(g.tipX, g.tipY);
      // колонка иконок в жёлобе: первая — переход от заголовка вниз-влево,
      // остальные зигзагом в жёлобе (как на ПК: 462/82/231/122 при vw=1904)
      var dTop = T + 40 * kw, step = clamp(190 * kw, 150, 205);
      var fx = [L - L * 0.26, gutterR * 0.30, gutterR * 0.85, gutterR * 0.45];
      var iconPts = [];
      for (var i = 0; i < n; i++) {
        iconPts.push({ x: clamp(fx[i], ICON / 2 + 8, L - ICON / 2 - 6),
                       y: dTop + step * i });
      }
      var pts = tg.concat(crown, iconPts);
      return { pts: pts, iconPts: iconPts, apex: { x: cx, y: apexY },
               tip: { x: g.tipX, y: g.tipY }, girl: g, kw: kw };
    }

    // ── LOOP: иконки на дуге ПОД заголовком (не налезают на контент по бокам)
    var girl = (!phone && mr >= 160) ? placeGirl() : null;
    var head, tip;
    if (girl) {
      head = tail(girl.tipX, girl.tipY); tip = { x: girl.tipX, y: girl.tipY };
    } else {
      var beadX = Math.min(R + 22 * kw, vw - 12), beadY = T - 8 * kw;
      head = [{ x: beadX, y: beadY }]; tip = { x: beadX, y: beadY };
    }
    // дуга под заголовком: иконки слева-направо, провисает к центру.
    // На ТЕЛЕФОНЕ: ряд гарантированно влезает по ширине (spread ≤ vw-isz-16) и
    // опущен НИЖЕ подзаголовка (archY с учётом размера иконки), чтобы не наезжал.
    var isz = phone ? 42 : ICON;
    var archY = B + (phone ? clamp(54 * kw, isz / 2 + 34, 86) : clamp(54 * kw, 40, 72));
    var sag = phone ? clamp(16 * kw, 8, 16) : clamp(20 * kw, 12, 30);
    var spread = phone ? clamp(W * 0.66, 168, vw - isz - 16)
                       : Math.min(W * 0.66, vw * 0.40);   // ширина веера иконок
    var iconPts2 = [];
    for (var j = 0; j < n; j++) {
      var rel = (n === 1) ? 0 : (j / (n - 1)) * 2 - 1;   // -1..1
      iconPts2.push({ x: cx + rel * spread / 2, y: archY + sag * (1 - rel * rel) });
    }
    var leftStub = { x: L - 12 * kw, y: B + 12 * kw };          // от левой базы вниз
    var rightStub = { x: R + 14 * kw, y: B + 20 * kw };          // правый хвостик
    var pts2 = head.concat(crown, [leftStub], iconPts2, [rightStub]);
    return { pts: pts2, iconPts: iconPts2, apex: { x: cx, y: apexY },
             tip: tip, girl: girl, kw: kw, loop: true };
  }

  function layout() {
    var root = document.getElementById("magic-social");
    if (!root) return;
    var tr = titleRect();
    if (!tr) { root.classList.remove("on"); return; }
    root.classList.add("on");

    var vw = window.innerWidth, vh = window.innerHeight;
    // ТЕЛЕФОН = меньшая сторона ≤ 600 (ловит И портрет, И ландшафт телефона —
    // ландшафт широкий, но низкий; по одной ширине его не отличить от ноута).
    var phone = Math.min(vw, vh) <= 600;
    var tbEl = document.querySelector(".topbar");
    var topbarH = tbEl ? Math.round(tbEl.getBoundingClientRect().bottom + window.scrollY) : 72;

    var sp = buildSpine(tr, vw, topbarH, phone);
    var compact = phone;                             // мелкие иконки + подписи скрыты
    var d = smooth(sp.pts);
    root._aura.setAttribute("d", d);
    root._spine.setAttribute("d", d);
    root._core.setAttribute("d", d);
    root._flow.setAttribute("d", d);
    root._motion.setAttribute("d", d);

    // ── ИКОНКИ — на узлах пути (smooth() проходит через них) → строго на линии.
    var isz = compact ? 42 : ICON, half = isz / 2;   // 42 совпадает с расчётом дуги в buildSpine
    var lblUnder = !!sp.loop;                        // в петле подпись под иконкой
    var hideLbl = compact;                           // на телефоне подписи мешают → прячем
    var iconNodes = [];
    root._icons.forEach(function (it, i) {
      var p = sp.iconPts[i] || sp.iconPts[sp.iconPts.length - 1];
      it.a.style.width = isz + "px"; it.a.style.height = isz + "px";
      it.a.style.left = Math.round(p.x - half) + "px";
      it.a.style.top  = Math.round(p.y - half) + "px";
      it.lbl.style.display = hideLbl ? "none" : "";
      if (lblUnder) {
        it.lbl.style.left = Math.round(p.x) + "px";
        it.lbl.style.top  = Math.round(p.y + half + 5) + "px";
        it.lbl.style.transform = "translateX(-50%)";
        it.pop.style.left = Math.round(p.x) + "px";
        it.pop.style.top  = Math.round(p.y - half - 6) + "px";
        it.pop.style.transform = "translate(-50%,-100%)";
      } else {
        it.lbl.style.left = Math.round(p.x + half + 8) + "px";
        it.lbl.style.top  = Math.round(p.y) + "px";
        it.lbl.style.transform = "translateY(-50%)";
        it.pop.style.left = Math.round(p.x + half + 10) + "px";
        it.pop.style.top  = Math.round(p.y) + "px";
        it.pop.style.transform = "translateY(-50%)";
      }
      iconNodes.push({ cx: p.x, cy: p.y });
    });

    // ── ДЕВОЧКА: геометрия уже посчитана в buildSpine (sp.girl), палец ровно на
    //    кончике линии (sp.tip). Просто применяем.
    var girl = root._girl, showGirl = false, GW = 0, GH = 0, gx = 0, gy = 0;
    if (girl) {
      if (sp.girl && sp.girl.show) {
        showGirl = true; GW = sp.girl.GW; GH = sp.girl.GH; gx = sp.girl.gx; gy = sp.girl.gy;
        girl.style.display = "block";
        girl.style.width = GW + "px";
        girl.style.left = Math.round(gx) + "px";
        girl.style.top  = Math.round(gy) + "px";
      } else {
        girl.style.display = "none";
      }
    }

    // ── светящиеся узлы: на иконках + вершина короны + бусина на кончике
    root._nodes.forEach(function (nd) { nd.remove(); });
    root._nodes = [];
    iconNodes.forEach(function (p, i) {
      var c = el("circle", { class: "ms-node", cx: p.cx, cy: p.cy, r: 3 });
      c.style.animationDelay = (i * 0.4) + "s";
      root._svg.appendChild(c); root._nodes.push(c);
    });
    var apex = el("circle", { class: "ms-node", cx: sp.apex.x, cy: sp.apex.y, r: 3.4 });
    var orb = el("circle", { class: "ms-orb", cx: sp.tip.x, cy: sp.tip.y, r: 6, fill: "url(#msSpark)" });
    var orbCore = el("circle", { class: "ms-orb-core", cx: sp.tip.x, cy: sp.tip.y, r: 2.2 });
    root._svg.appendChild(apex); root._svg.appendChild(orb); root._svg.appendChild(orbCore);
    root._nodes.push(apex, orb, orbCore);

    // высота оверлея = ниже самой нижней иконки и/или девочки
    var lowestIcon = iconNodes.length ? Math.max.apply(null, iconNodes.map(function (p) { return p.cy; })) : tr.B;
    var girlBottom = showGirl ? gy + GH * 0.92 : 0;
    root.style.height = Math.round(Math.max(lowestIcon + half + 26, girlBottom, tr.B + 40)) + "px";

    // ── совместимость с magic-edit.js: точки линии относительно заголовка
    window.__magicLine = { R: Math.round(tr.R), B: Math.round(tr.B),
      pts: sp.pts.map(function (p, i) {
        return { dx: Math.round(p.x - tr.R), dy: Math.round(p.y - tr.B),
                 kind: "line" };
      }) };
    // ── диагностика (как было) для сверки на узких экранах
    var mode = sp.loop ? (compact ? "compact" : "loop") : "gutter";
    window.__magicNarrow = {
      mode: mode, girlShown: showGirl,
      viewport: { innerW: vw, innerH: window.innerHeight, dpr: window.devicePixelRatio },
      title: { L: Math.round(tr.L), R: Math.round(tr.R), T: Math.round(tr.T),
               B: Math.round(tr.B), W: Math.round(tr.W), cx: Math.round(tr.cx) },
      topbarH: topbarH, apexY: Math.round(sp.apex.y),
      iconNodes: iconNodes.map(function (p, i) {
        return { i: i, label: root._icons[i] ? root._icons[i].lbl.textContent : "",
                 x: Math.round(p.cx), y: Math.round(p.cy) }; }),
      girl: { x: Math.round(gx), y: Math.round(gy), w: GW, h: GH,
              tipX: Math.round(sp.tip.x), tipY: Math.round(sp.tip.y) },
      spine_d: d
    };
  }

  function init() {
    buildOnce();
    var t;
    window.addEventListener("resize", function () {
      clearTimeout(t); t = setTimeout(layout, 120);
    });
    // повторный layout после загрузки шрифтов (ширина заголовка может измениться)
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () { setTimeout(layout, 30); });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
