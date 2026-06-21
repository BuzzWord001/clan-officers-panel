/* magic-social.js — соцсети единой "магической" цепочкой по левому краю:
   4 кликабельные иконки с подписями, соединённые непрерывной переплетённой
   (плетёной, две нити) светящейся линией. Видно только когда слева от
   контента есть свободное поле (широкие экраны). */
(function () {
  "use strict";

  var LINKS = [
    { key: "tg",       label: "Telegram",  href: "https://t.me/+6U3XCSrrZgo1YTMy",                 title: "Telegram клана",   img: "assets/social/tg.png" },
    { key: "ts",       label: "TeamSpeak", href: "ts3server://melodybum.ts3.se",                   title: "TeamSpeak — melodybum.ts3.se", img: "assets/social/ts.png" },
    { key: "vk-group", label: "Группа ВК", href: "https://vk.com/club38888207",                   title: "Группа ВКонтакте", img: "assets/social/vk-group.png" },
    { key: "vk-chat",  label: "Чат ВК",    href: "https://vk.me/join/rya0CI_hEnkgsCQdahj2jIb3r0wD6OHIA_E=", title: "Чат ВКонтакте", img: "assets/social/vk-chat.png" }
  ];

  var ICON = 56;
  var MIN_MARGIN = 138;   // минимум свободного поля слева, иначе скрываем
  var SVGNS = "http://www.w3.org/2000/svg";

  function el(tag, attrs) {
    var e = document.createElementNS(SVGNS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  function buildOnce() {
    if (document.getElementById("magic-social")) return;

    var style = document.createElement("style");
    style.textContent =
      "#magic-social{position:fixed;inset:0;z-index:6;pointer-events:none;overflow:hidden;display:none}" +
      "#magic-social.on{display:block}" +
      "#magic-social svg{position:absolute;inset:0;width:100%;height:100%}" +
      ".ms-strand{fill:none;stroke:url(#msGrad);stroke-linecap:round;filter:url(#msGlow)}" +
      ".ms-strand.a{stroke-width:2.6;opacity:.92;stroke-dasharray:6 10;animation:msFlow 4.5s linear infinite}" +
      ".ms-strand.b{stroke-width:2.0;opacity:.7;stroke-dasharray:4 12;animation:msFlow 6.5s linear infinite reverse}" +
      "@keyframes msFlow{to{stroke-dashoffset:-32}}" +
      ".ms-node{fill:#ffd98a;filter:url(#msGlow);animation:msPulse 3s ease-in-out infinite}" +
      "@keyframes msPulse{0%,100%{opacity:.5}50%{opacity:1}}" +
      ".ms-ico{position:absolute;width:" + ICON + "px;height:" + ICON + "px;pointer-events:auto;" +
        "border-radius:14px;display:block;transition:transform .18s ease,filter .18s ease;" +
        "filter:drop-shadow(0 0 6px rgba(224,140,40,.55)) drop-shadow(0 3px 7px rgba(0,0,0,.6))}" +
      ".ms-ico img{width:100%;height:100%;display:block;-webkit-user-drag:none;user-select:none}" +
      ".ms-ico:hover{transform:scale(1.14);" +
        "filter:drop-shadow(0 0 14px rgba(255,170,60,.95)) drop-shadow(0 4px 9px rgba(0,0,0,.7))}" +
      ".ms-lbl{position:absolute;pointer-events:none;transform:translateX(-50%);" +
        "white-space:nowrap;padding:2px 9px;border-radius:8px;" +
        "background:rgba(20,13,7,.78);border:1px solid rgba(224,140,40,.45);" +
        "color:#f4dcb0;font:700 11px/1.25 system-ui,sans-serif;letter-spacing:.3px;" +
        "text-shadow:0 1px 2px #000;box-shadow:0 0 10px rgba(224,140,40,.25)}";
    document.head.appendChild(style);

    var root = document.createElement("div");
    root.id = "magic-social";

    var svg = el("svg", { preserveAspectRatio: "none" });
    var defs = el("defs", {});
    var grad = el("linearGradient", { id: "msGrad", x1: "0", y1: "0", x2: "0", y2: "1" });
    grad.appendChild(el("stop", { offset: "0",  "stop-color": "#ffd27a" }));
    grad.appendChild(el("stop", { offset: ".5", "stop-color": "#ef8c24" }));
    grad.appendChild(el("stop", { offset: "1",  "stop-color": "#ff6f12" }));
    defs.appendChild(grad);
    var f = el("filter", { id: "msGlow", x: "-70%", y: "-70%", width: "240%", height: "240%" });
    f.appendChild(el("feGaussianBlur", { stdDeviation: "2.6", result: "b" }));
    var merge = el("feMerge", {});
    merge.appendChild(el("feMergeNode", { in: "b" }));
    merge.appendChild(el("feMergeNode", { in: "SourceGraphic" }));
    f.appendChild(merge);
    defs.appendChild(f);
    svg.appendChild(defs);

    var strandA = el("path", { class: "ms-strand a" });
    var strandB = el("path", { class: "ms-strand b" });
    svg.appendChild(strandB);
    svg.appendChild(strandA);
    root.appendChild(svg);
    root._svg = svg; root._a = strandA; root._b = strandB; root._nodes = [];

    var icons = [];
    LINKS.forEach(function (L) {
      var a = document.createElement("a");
      a.className = "ms-ico";
      a.href = L.href;
      a.title = L.title;
      a.target = "_blank"; a.rel = "noopener";
      a.innerHTML = '<img src="' + L.img + '" alt="' + L.label + '">';
      root.appendChild(a);
      var lbl = document.createElement("div");
      lbl.className = "ms-lbl";
      lbl.textContent = L.label;
      root.appendChild(lbl);
      icons.push({ a: a, lbl: lbl });
    });
    root._icons = icons;

    document.body.appendChild(root);
    layout();
  }

  // один сегмент плетёнки: от (cx,y1) к (cx,y2), выгиб наружу на bow
  function seg(cx, y1, y2, bow) {
    var dy = y2 - y1;
    return " C" + (cx + bow) + " " + (y1 + dy * 0.28) +
           " "  + (cx + bow) + " " + (y2 - dy * 0.28) +
           " "  + cx + " " + y2;
  }

  function layout() {
    var root = document.getElementById("magic-social");
    if (!root) return;
    var vw = window.innerWidth, vh = window.innerHeight;
    var contentW = Math.min(1360, vw * 0.95);
    var margin = (vw - contentW) / 2;

    if (margin < MIN_MARGIN) { root.classList.remove("on"); return; }
    root.classList.add("on");

    var cx = margin / 2;
    var amp = Math.min(30, margin * 0.22);
    var half = ICON / 2;
    var n = root._icons.length;

    // вертикальные позиции 4 иконок
    var topY = Math.max(120, vh * 0.14);
    var botY = Math.min(vh - 70, vh * 0.90);
    var step = (botY - topY) / (n - 1);
    var ys = [];
    for (var i = 0; i < n; i++) ys.push(Math.round(topY + step * i));

    // расставить иконки + подписи
    root._icons.forEach(function (it, i) {
      it.a.style.left = (cx - half) + "px";
      it.a.style.top  = (ys[i] - half) + "px";
      it.lbl.style.left = cx + "px";
      it.lbl.style.top  = (ys[i] + half + 6) + "px";
    });

    // две нити, пересекающиеся у каждой иконки (плетёнка)
    var pa = "M" + cx + " " + (ys[0]);
    var pb = "M" + cx + " " + (ys[0]);
    for (var s = 0; s < n - 1; s++) {
      // не заходим под саму иконку — стартуем чуть ниже верхней
      var y1 = ys[s] + half - 6, y2 = ys[s + 1] - half + 6;
      var dir = (s % 2 === 0) ? 1 : -1;
      pa += " L" + cx + " " + y1 + seg(cx, y1, y2, amp * dir);
      pb += " L" + cx + " " + y1 + seg(cx, y1, y2, -amp * dir);
    }
    root._a.setAttribute("d", pa);
    root._b.setAttribute("d", pb);

    // светящиеся узелки на пересечениях (между иконками)
    root._nodes.forEach(function (nd) { nd.remove(); });
    root._nodes = [];
    for (var k = 0; k < n - 1; k++) {
      var midY = (ys[k] + ys[k + 1]) / 2;
      var c = el("circle", { class: "ms-node", cx: cx, cy: midY, r: 2.6 });
      c.style.animationDelay = (k * 0.4) + "s";
      root._svg.appendChild(c);
      root._nodes.push(c);
    }
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
