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
      ".ms-flow{fill:none;stroke:#fff6da;stroke-width:3;stroke-linecap:round;" +
        "filter:url(#msGlowS);stroke-dasharray:2 24;animation:msFlow 2.4s linear infinite}" +
      ".ms-node{fill:#ffe39a;filter:url(#msGlowS);animation:msPulse 2.8s ease-in-out infinite}" +
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

    var aura  = el("path", { class: "ms-aura" });
    var spine = el("path", { class: "ms-spine", id: "ms-spine-path" });
    var core  = el("path", { class: "ms-core" });
    var bolt  = el("path", { class: "ms-bolt" });
    var flow  = el("path", { class: "ms-flow" });
    [aura, spine, core, bolt, flow].forEach(function (p) { svg.appendChild(p); });

    for (var s = 0; s < 2; s++) {
      var c = el("circle", { class: "ms-spark", r: 3.4, cx: 0, cy: 0, opacity: "0" });
      var mo = el("animateMotion", { dur: (4.6 + s * 0.8) + "s", repeatCount: "indefinite",
                                     begin: (s * 2.0) + "s", rotate: "auto" });
      mo.appendChild(el("mpath", { href: "#ms-spine-path" }));
      var op = el("animate", { attributeName: "opacity", dur: (4.6 + s * 0.8) + "s",
                               repeatCount: "indefinite", begin: (s * 2.0) + "s",
                               values: "0;1;1;0", keyTimes: "0;.12;.88;1" });
      c.appendChild(mo); c.appendChild(op);
      svg.appendChild(c);
    }

    root.appendChild(svg);
    root._svg = svg; root._aura = aura; root._spine = spine; root._core = core;
    root._bolt = bolt; root._flow = flow; root._nodes = [];

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

  // якорь у заголовка SanTDeviL — точные границы ТЕКСТА (а не блока)
  function titleAnchor(tgX) {
    var g = document.querySelector(".glitch");
    if (!g) return null;
    var range = document.createRange();
    range.selectNodeContents(g);
    var r = range.getBoundingClientRect();
    if (!r.width) return null;
    var x = r.left + window.scrollX - 18;            // чуть левее текста, не перекрывая
    var y = r.top + window.scrollY + r.height / 2;
    if (x <= tgX + 24) return null;                  // только если правее верхней иконки
    return { x: Math.round(x), y: Math.round(y) };
  }

  function layout() {
    var root = document.getElementById("magic-social");
    if (!root) return;
    var vw = window.innerWidth;
    var contentW = Math.min(1360, vw * 0.95);
    var m = (vw - contentW) / 2;

    if (m < MIN_MARGIN) { root.classList.remove("on"); return; }
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

    // линия продлевается к заголовку SanTDeviL (если хватает места)
    var anchor = titleAnchor(iconPts[0].x);
    var linePts = anchor ? [anchor].concat(iconPts) : iconPts;

    var dSpine = smooth(linePts);
    root._aura.setAttribute("d", dSpine);
    root._spine.setAttribute("d", dSpine);
    root._core.setAttribute("d", dSpine);
    root._flow.setAttribute("d", dSpine);

    // плетёная молния
    var bolt = [];
    for (var k = 0; k < linePts.length; k++) {
      bolt.push(linePts[k]);
      if (k < linePts.length - 1) {
        var a = linePts[k], b = linePts[k + 1], sgn = (k % 2 === 0) ? 1 : -1;
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

    // светящиеся узлы (включая точку связи у заголовка)
    root._nodes.forEach(function (nd) { nd.remove(); });
    root._nodes = [];
    linePts.forEach(function (p, idx) {
      var c = el("circle", { class: "ms-node", cx: p.x, cy: p.y, r: idx === 0 && anchor ? 3.6 : 3 });
      c.style.animationDelay = (idx * 0.5) + "s";
      root._svg.appendChild(c);
      root._nodes.push(c);
    });
  }

  function init() {
    buildOnce();
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
