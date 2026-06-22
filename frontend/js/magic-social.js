/* magic-social.js — соцсети единой "магической" змейкой по левому краю.
   - position:absolute (как дверца) → уезжает вверх при прокрутке.
   - многослойная анимированная линия, продлённая к заголовку SanTDeviL
     (визуальная связь логотипов со всем сайтом).
   - наведение: свечение под ЦВЕТ логотипа + поповер со ссылкой и кнопкой
     «Копировать». Видно когда слева есть свободное поле. */
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

  var XF = [1.70, 0.30, 0.85, 0.45];
  var TOP_Y = 150, STEP_Y = 200, ICON = 58, MIN_MARGIN = 138;
  var SVGNS = "http://www.w3.org/2000/svg";

  function el(tag, attrs) {
    var e = document.createElementNS(SVGNS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

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
      ".ms-bolt{fill:none;stroke:#ffe7b0;stroke-width:1.9;stroke-linecap:round;" +
        "stroke-linejoin:round;filter:url(#msGlowS);animation:msFlicker 3.4s ease-in-out infinite}" +
      ".ms-tail{stroke:none;fill:url(#msGrad);filter:url(#msGlow);opacity:.96}" +
      ".ms-flow{fill:none;stroke:#fff6da;stroke-width:3;stroke-linecap:round;" +
        "filter:url(#msGlowS);stroke-dasharray:2 24;animation:msFlow 2.4s linear infinite}" +
      ".ms-node{fill:#ffe39a;filter:url(#msGlowS);animation:msPulse 2.8s ease-in-out infinite}" +
      ".ms-orb{filter:url(#msGlow);animation:msPulse 2.6s ease-in-out infinite}" +
      ".ms-orb-core{fill:#fff6e0;filter:url(#msGlowS)}" +
      ".ms-girl{position:absolute;pointer-events:none;display:none;height:auto;" +
        "filter:drop-shadow(0 5px 14px rgba(0,0,0,.5));z-index:0}" +
      ".ms-spark{fill:url(#msSpark);filter:url(#msGlowS)}" +
      "@keyframes msFlow{to{stroke-dashoffset:-39}}" +
      "@keyframes msFlicker{0%,100%{opacity:.5}40%{opacity:.95}52%{opacity:.45}68%{opacity:.85}}" +
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

    // девочка тянется к кончику линии (искра на пальце = конец линии).
    // первой в DOM → рисуется ПОЗАДИ линии, бусина ложится на её палец.
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
    var tail  = el("path", { class: "ms-tail" });
    var spine = el("path", { class: "ms-spine", id: "ms-spine-path" });
    var core  = el("path", { class: "ms-core" });
    var bolt  = el("path", { class: "ms-bolt" });
    var flow  = el("path", { class: "ms-flow" });
    [motion, aura, tail, spine, core, bolt, flow].forEach(function (p) { svg.appendChild(p); });

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
    root._bolt = bolt; root._flow = flow; root._tail = tail; root._motion = motion;
    root._nodes = [];

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

      // показ поповера при наведении на иконку ИЛИ сам поповер
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

  // ---- мобильная версия: на узких экранах боковых полей нет, поэтому
  //      рисуем компактный блок ПОД заголовком: волнистая светящаяся линия →
  //      девочка тянется пальцем к её концу + ряд иконок соцсетей (tap-to-copy).
  function buildMobileOnce() {
    if (document.getElementById("magic-social-mobile")) return;
    var anchor = document.querySelector(".title-block");
    if (!anchor) return;

    var style = document.createElement("style");
    style.textContent =
      "#magic-social-mobile{position:relative;width:100%;margin:2px 0 8px;display:none;" +
        "z-index:5;isolation:isolate}" +
      "#magic-social-mobile.on{display:block}" +
      "#magic-social-mobile svg{position:absolute;top:0;left:0;width:100%;height:62px;" +
        "overflow:visible;pointer-events:none;z-index:1}" +
      ".msm-aura{fill:none;stroke:#ff9a2e;stroke-width:10;stroke-linecap:round;" +
        "filter:url(#msmAura);opacity:.3}" +
      ".msm-spine{fill:none;stroke:url(#msmGrad);stroke-width:4;stroke-linecap:round;" +
        "filter:url(#msmGlow);opacity:.97}" +
      ".msm-core{fill:none;stroke:#fff3d2;stroke-width:1.3;stroke-linecap:round;opacity:.8}" +
      ".msm-flow{fill:none;stroke:#fff6da;stroke-width:2.4;stroke-linecap:round;" +
        "filter:url(#msmGlowS);stroke-dasharray:2 22;animation:msFlow 2.4s linear infinite}" +
      ".msm-orb{filter:url(#msmGlow);animation:msPulse 2.6s ease-in-out infinite}" +
      ".msm-girl{position:absolute;top:0;pointer-events:none;height:auto;" +
        "filter:drop-shadow(0 4px 10px rgba(0,0,0,.5));z-index:0}" +
      ".msm-row{position:relative;z-index:2;display:flex;justify-content:center;" +
        "flex-wrap:wrap;gap:8px 14px;padding-top:62px}" +
      ".msm-item{display:flex;flex-direction:column;align-items:center;gap:5px;width:62px}" +
      ".msm-ic{width:46px;height:46px;display:block;border-radius:12px;pointer-events:auto;" +
        "transition:transform .15s ease;" +
        "filter:drop-shadow(0 0 7px var(--gc)) drop-shadow(0 2px 5px rgba(0,0,0,.6))}" +
      ".msm-ic img{width:100%;height:100%;display:block;-webkit-user-drag:none;user-select:none}" +
      ".msm-ic:active{transform:scale(1.12)}" +
      ".msm-name{cursor:pointer;pointer-events:auto;border:1px solid rgba(224,140,40,.4);" +
        "background:rgba(20,13,7,.72);color:#f4dcb0;font:700 9.5px/1.2 system-ui,sans-serif;" +
        "padding:3px 6px;border-radius:7px;white-space:nowrap;text-shadow:0 1px 2px #000}" +
      ".msm-name.ok{color:#cde8ac;border-color:#6fae5a}";
    document.head.appendChild(style);

    var box = document.createElement("div");
    box.id = "magic-social-mobile";

    var girl = document.createElement("img");
    girl.className = "msm-girl"; girl.alt = "";
    girl.src = "assets/girl.png?v=1794600000";
    box.appendChild(girl);
    box._girl = girl;

    var svg = el("svg", { preserveAspectRatio: "none" });
    var defs = el("defs", {});
    var grad = el("linearGradient", { id: "msmGrad", x1: "0", y1: "0", x2: "1", y2: "0" });
    grad.appendChild(el("stop", { offset: "0",  "stop-color": "#ffe6a0" }));
    grad.appendChild(el("stop", { offset: ".4", "stop-color": "#ffae3a" }));
    grad.appendChild(el("stop", { offset: ".75","stop-color": "#ef7c1e" }));
    grad.appendChild(el("stop", { offset: "1",  "stop-color": "#ff5e0f" }));
    defs.appendChild(grad);
    defs.appendChild(glow("msmAura", 5));
    defs.appendChild(glow("msmGlow", 2.4));
    defs.appendChild(glow("msmGlowS", 1.4));
    svg.appendChild(defs);
    var aura = el("path", { class: "msm-aura" }), spine = el("path", { class: "msm-spine" });
    var core = el("path", { class: "msm-core" }), flow = el("path", { class: "msm-flow" });
    [aura, spine, core, flow].forEach(function (p) { svg.appendChild(p); });
    box.appendChild(svg);
    box._svg = svg; box._aura = aura; box._spine = spine; box._core = core;
    box._flow = flow; box._nodes = [];

    var row = document.createElement("div");
    row.className = "msm-row";
    LINKS.forEach(function (L) {
      var item = document.createElement("div");
      item.className = "msm-item";
      var a = document.createElement("a");
      a.className = "msm-ic";
      a.href = L.href;
      a.style.setProperty("--gc", L.glow);
      a.setAttribute("aria-label", L.label);
      if (L.key !== "ts") { a.target = "_blank"; a.rel = "noopener"; }
      a.innerHTML = '<img src="' + L.img + '?v=1792700000" alt="' + L.label + '">';
      var nm = document.createElement("button");
      nm.type = "button"; nm.className = "msm-name"; nm.textContent = L.label;
      nm.addEventListener("click", function () { copyToClipboard(L.href, nm); });
      item.appendChild(a); item.appendChild(nm);
      row.appendChild(item);
    });
    box.appendChild(row);
    box._row = row;

    anchor.parentNode.insertBefore(box, anchor.nextSibling);
  }

  function layoutMobile() {
    var box = document.getElementById("magic-social-mobile");
    if (!box) { buildMobileOnce(); box = document.getElementById("magic-social-mobile"); }
    if (!box) return;
    box.classList.add("on");
    var W = box.clientWidth || window.innerWidth;

    // девочка у правого края, тянется пальцем к концу линии (искра 0.111/0.047)
    var GH = 190, GW = Math.round(GH * (343 / 760));   // ~86px
    var gx = W - GW - 4;
    box._girl.style.width = GW + "px";
    box._girl.style.left = gx + "px";
    box._girl.style.top = "0px";
    box.style.minHeight = (GH + 6) + "px";
    // иконки центрируем в левой зоне (правый отступ под девочку)
    box._row.style.marginRight = (GW + 12) + "px";

    var tipX = gx + 0.111 * GW, tipY = 0.047 * GH;
    var baseY = 34;
    var pts = [
      { x: 14,        y: baseY + 12 },
      { x: W * 0.27,  y: baseY - 9 },
      { x: W * 0.47,  y: baseY + 10 },
      { x: W * 0.63,  y: baseY - 4 },
      { x: tipX,      y: tipY }
    ];
    var d = smooth(pts);
    box._aura.setAttribute("d", d); box._spine.setAttribute("d", d);
    box._core.setAttribute("d", d); box._flow.setAttribute("d", d);

    box._nodes.forEach(function (n) { n.remove(); });
    box._nodes = [];
    var orb = el("circle", { class: "msm-orb", cx: tipX, cy: tipY, r: 5.5, fill: "url(#msmGrad)" });
    var orbCore = el("circle", { class: "ms-orb-core", cx: tipX, cy: tipY, r: 1.9 });
    box._svg.appendChild(orb); box._svg.appendChild(orbCore);
    box._nodes.push(orb, orbCore);
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

  function smooth(pts) {
    if (pts.length < 2) return "";
    var d = "M" + pts[0].x + " " + pts[0].y;
    for (var i = 0; i < pts.length - 1; i++) {
      var p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || pts[i + 1];
      d += " C" + (p1.x + (p2.x - p0.x) / 6) + " " + (p1.y + (p2.y - p0.y) / 6) +
           " "  + (p2.x - (p3.x - p1.x) / 6) + " " + (p2.y - (p3.y - p1.y) / 6) +
           " "  + p2.x + " " + p2.y;
    }
    return d;
  }

  // дуга-корона вокруг заголовка SanTDeviL — по точным границам ТЕКСТА.
  // изящно обвивает заголовок сверху, концы спускаются по бокам ниже центра.
  function titleArch(tgX) {
    var g = document.querySelector(".glitch");
    if (!g) return null;
    var range = document.createRange();
    range.selectNodeContents(g);
    var r = range.getBoundingClientRect();
    if (!r.width) return null;
    var sx = window.scrollX, sy = window.scrollY;
    var L = r.left + sx, R = r.right + sx, T = r.top + sy;
    var w = r.width, cx = L + w / 2, cy = T + r.height / 2;
    var anchorX = Math.round(L - 16);
    if (anchorX <= tgX + 24) return null;            // нужно место правее верхней иконки
    var apexY = Math.max(Math.round(T - 22), 82);    // в зазоре между топбаром и текстом
    var rnd = function (x, y) { return { x: Math.round(x), y: Math.round(y) }; };
    var B = T + r.height;                            // низ заголовка
    var pts = [
      // ---- художественный хвост: от правого края заголовок ПОД надписью
      //      сметается влево к центру и заканчивается завитком внизу ----
      // длинный волнистый хвост: уходит вправо за заголовок (~2 волны)
      // и заканчивается завитком КНИЗУ со светящейся бусиной
      // хвост ТРАССИРОВАН по рисунку Лира (Безымянный.png): идёт НИЗОМ под
      // заголовком, волной вправо, с загибом книзу на конце. Свободный
      // кончик (бусина) справа внизу.
      // хвост — новые позиции точек от Лира (ручная правка в редакторе)
      rnd(R + 387, B + 91),    // 0 свободный кончик (бусина)
      rnd(R + 346, B + 57),    // 1
      rnd(R + 301, B + 74),    // 2
      rnd(R + 225, B + 102),   // 3
      rnd(R + 142, B + 104),   // 4
      rnd(R + 98,  B + 55),    // 5
      rnd(R + 31,  B + 37),    // 6
      rnd(R - 73,  B + 78),    // 7
      rnd(R - 191, B + 99),    // 8
      rnd(R - 306, B + 72),    // 9
      rnd(R - 321, B + 45),    // 10
      rnd(R - 235, B + 45),    // 11
      rnd(R - 141, B + 40),    // 12
      rnd(R - 100, B + 34),    // 13
      rnd(R - 51,  B + 20),    // 14 (правка Лира)
      rnd(R + 5,   B - 2),     // 15 стык к короне (правка Лира)
      // ---- правый бок и корона над заголовком ----
      rnd(R + 30, B - 43),         // правый бок / стык (правка Лира)
      rnd(R - 12, B - 73),         // правый верхний угол (правка Лира)
      rnd(cx + w * 0.24, apexY),
      rnd(cx,            apexY),   // вершина короны
      rnd(cx - w * 0.24, apexY),
      rnd(L - 4,  T - 10),         // левый верхний угол
      rnd(anchorX, cy)             // левая база — переходит в цепочку
    ];
    return { pts: pts, apex: rnd(cx, apexY), tip: pts[0], anchor: rnd(anchorX, cy),
             R: R, B: B };
  }

  function layout() {
    var root = document.getElementById("magic-social");
    if (!root) return;
    var vw = window.innerWidth;
    var contentW = Math.min(1360, vw * 0.95);
    var m = (vw - contentW) / 2;

    if (m < MIN_MARGIN) {
      root.classList.remove("on");
      layoutMobile();                 // узкий экран → компактная мобильная версия
      return;
    }
    var mb = document.getElementById("magic-social-mobile");
    if (mb) mb.classList.remove("on");
    root.classList.add("on");

    var half = ICON / 2, n = root._icons.length;
    var iconPts = [];
    for (var i = 0; i < n; i++) {
      var x = (i === 0) ? Math.min(m * XF[0], vw * 0.27)
                        : Math.min(m * XF[i], m - half - 6);
      x = Math.round(Math.max(x, half + 6));
      iconPts.push({ x: x, y: TOP_Y + STEP_Y * i });
    }
    root.style.height = (iconPts[n - 1].y + 140) + "px";

    root._icons.forEach(function (it, i) {
      var p = iconPts[i];
      it.a.style.left = (p.x - half) + "px";
      it.a.style.top  = (p.y - half) + "px";
      it.lbl.style.left = p.x + "px";
      it.lbl.style.top  = (p.y + half + 6) + "px";
      it.pop.style.left = (p.x + half + 12) + "px";
      it.pop.style.top  = p.y + "px";
    });

    // линия обвивает заголовок SanTDeviL дугой-короной (если хватает места)
    var arch = titleArch(iconPts[0].x);
    var fullPts = arch ? arch.pts.concat(iconPts) : iconPts;
    // равномерная толщина по всей линии (включая хвост)
    var dFull = smooth(fullPts);
    root._aura.setAttribute("d", dFull);
    root._spine.setAttribute("d", dFull);
    root._core.setAttribute("d", dFull);
    root._flow.setAttribute("d", dFull);
    root._motion.setAttribute("d", dFull);
    root._tail.setAttribute("d", "");

    // открываем точки линии для редактора (#magicedit): dx/dy относительно
    // заголовка + тип (line — форма линии, icon — позиция иконки)
    if (arch) {
      var _nl = arch.pts.length;
      window.__magicLine = { R: arch.R, B: arch.B,
        pts: fullPts.map(function (p, i) {
          return { dx: Math.round(p.x - arch.R), dy: Math.round(p.y - arch.B),
                   kind: i < _nl ? "line" : "icon" };
        }) };
    }

    // плетёная молния — ТОЛЬКО по цепочке иконок (над заголовком чисто)
    var boltPts = arch ? [arch.anchor].concat(iconPts) : iconPts;
    var bolt = [];
    for (var k = 0; k < boltPts.length; k++) {
      bolt.push(boltPts[k]);
      if (k < boltPts.length - 1) {
        var a = boltPts[k], b = boltPts[k + 1], sgn = (k % 2 === 0) ? 1 : -1;
        var off = Math.min(22, m * 0.17);
        var wv = [[0.78, 1], [0.50, -1], [0.22, 1]];
        for (var j = 0; j < wv.length; j++) {
          var t = wv[j][0];
          bolt.push({ x: a.x * t + b.x * (1 - t) + sgn * wv[j][1] * off,
                      y: a.y * t + b.y * (1 - t) });
        }
      }
    }
    root._bolt.setAttribute("d", smooth(bolt));

    // светящиеся узлы: иконки + вершина короны + флёр-конец справа
    root._nodes.forEach(function (nd) { nd.remove(); });
    root._nodes = [];
    var nodePts = iconPts.slice();
    if (arch) { nodePts.push(arch.apex); }
    nodePts.forEach(function (p, idx) {
      var big = arch && p === arch.apex;
      var c = el("circle", { class: "ms-node", cx: p.x, cy: p.y, r: big ? 3.6 : 3 });
      c.style.animationDelay = (idx * 0.5) + "s";
      root._svg.appendChild(c);
      root._nodes.push(c);
    });
    // светящийся шар-бусина на самом кончике хвоста
    if (arch) {
      var orb = el("circle", { class: "ms-orb", cx: arch.tip.x, cy: arch.tip.y,
                               r: 6.5, fill: "url(#msSpark)" });
      var orbCore = el("circle", { class: "ms-orb-core", cx: arch.tip.x, cy: arch.tip.y, r: 2.4 });
      root._svg.appendChild(orb); root._svg.appendChild(orbCore);
      root._nodes.push(orb); root._nodes.push(orbCore);
    }

    // девочка тянется пальцем к кончику линии (искра пальца = бусина).
    // girl.png 343x760, искра на доле (0.111, 0.047). Масштаб — под свободное
    // правое поле; прячем если места мало.
    var girl = root._girl;
    if (girl) {
      if (arch && m >= 200 && arch.tip) {
        var tx = arch.tip.x, ty = arch.tip.y;
        var GW = Math.min(232, (window.innerWidth - tx - 12) / 0.9);
        if (GW >= 120) {
          var GH = GW * (760 / 343);
          girl.style.width = GW + "px";
          girl.style.left = (tx - 0.111 * GW) + "px";
          girl.style.top  = (ty - 0.047 * GH) + "px";
          girl.style.display = "block";
        } else { girl.style.display = "none"; }
      } else { girl.style.display = "none"; }
    }
  }

  function init() {
    buildOnce();
    buildMobileOnce();
    var t;
    window.addEventListener("resize", function () {
      clearTimeout(t); t = setTimeout(layout, 120);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
