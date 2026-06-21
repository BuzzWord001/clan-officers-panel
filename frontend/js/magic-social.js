/* magic-social.js — соцсети единой "магической" змейкой по левому краю.
   Иконки ЗАКРЕПЛЕНЫ (position:fixed) — не скроллятся. Между соседними —
   одна толстая плавная линия, переплетённая плавной "молнией" (без острых
   углов). Иконки разбросаны змейкой. Видно только когда слева есть поле. */
(function () {
  "use strict";

  // порядок сверху вниз: Telegram, Чат ВК, TeamSpeak, Группа ВК
  var LINKS = [
    { key: "tg",       label: "Telegram",  href: "https://t.me/+6U3XCSrrZgo1YTMy",                 title: "Telegram клана",   img: "assets/social/tg.png" },
    { key: "vk-chat",  label: "Чат ВК",    href: "https://vk.me/join/rya0CI_hEnkgsCQdahj2jIb3r0wD6OHIA_E=", title: "Чат ВКонтакте", img: "assets/social/vk-chat.png" },
    { key: "ts",       label: "TeamSpeak", href: "ts3server://melodybum.ts3.se",                   title: "TeamSpeak — melodybum.ts3.se", img: "assets/social/ts.png" },
    { key: "vk-group", label: "Группа ВК", href: "https://vk.com/club38888207",                   title: "Группа ВКонтакте", img: "assets/social/vk-group.png" }
  ];

  // центр каждой иконки по X — доля от ширины левого поля m.
  // верхняя (Telegram) > 1.0: тянется вправо к центру/надписи SanTDeviL.
  var XF = [1.70, 0.30, 0.85, 0.45];
  var YFRAC = [0.16, 0.40, 0.63, 0.86];

  var ICON = 58;
  var MIN_MARGIN = 138;
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
      ".ms-spine{fill:none;stroke:url(#msGrad);stroke-width:6;stroke-linecap:round;" +
        "stroke-linejoin:round;filter:url(#msGlow);opacity:.95}" +
      ".ms-bolt{fill:none;stroke:#fff0c8;stroke-width:2.5;stroke-linecap:round;" +
        "stroke-linejoin:round;filter:url(#msBolt);opacity:.9}" +
      ".ms-ico{position:absolute;width:" + ICON + "px;height:" + ICON + "px;pointer-events:auto;" +
        "border-radius:14px;display:block;transition:transform .18s ease,filter .18s ease;" +
        "filter:drop-shadow(0 0 7px rgba(224,140,40,.6)) drop-shadow(0 3px 7px rgba(0,0,0,.6))}" +
      ".ms-ico img{width:100%;height:100%;display:block;-webkit-user-drag:none;user-select:none}" +
      ".ms-ico:hover{transform:scale(1.14);" +
        "filter:drop-shadow(0 0 15px rgba(255,170,60,.95)) drop-shadow(0 4px 9px rgba(0,0,0,.7))}" +
      ".ms-lbl{position:absolute;pointer-events:none;transform:translateX(-50%);" +
        "white-space:nowrap;padding:2px 9px;border-radius:8px;" +
        "background:rgba(20,13,7,.8);border:1px solid rgba(224,140,40,.45);" +
        "color:#f4dcb0;font:700 11px/1.25 system-ui,sans-serif;letter-spacing:.3px;" +
        "text-shadow:0 1px 2px #000;box-shadow:0 0 10px rgba(224,140,40,.25)}";
    document.head.appendChild(style);

    var root = document.createElement("div");
    root.id = "magic-social";

    var svg = el("svg", { preserveAspectRatio: "none" });
    var defs = el("defs", {});
    var grad = el("linearGradient", { id: "msGrad", x1: "0", y1: "0", x2: "0", y2: "1" });
    grad.appendChild(el("stop", { offset: "0",  "stop-color": "#ffcf78" }));
    grad.appendChild(el("stop", { offset: ".5", "stop-color": "#ef8420" }));
    grad.appendChild(el("stop", { offset: "1",  "stop-color": "#ff6410" }));
    defs.appendChild(grad);
    defs.appendChild(glow("msGlow", 3.2));
    defs.appendChild(glow("msBolt", 1.8));
    svg.appendChild(defs);

    var spine = el("path", { class: "ms-spine" });
    var bolt = el("path", { class: "ms-bolt" });
    svg.appendChild(spine);
    svg.appendChild(bolt);
    root.appendChild(svg);
    root._svg = svg; root._spine = spine; root._bolt = bolt;

    var icons = [];
    LINKS.forEach(function (L) {
      var a = document.createElement("a");
      a.className = "ms-ico";
      a.href = L.href; a.title = L.title;
      a.target = "_blank"; a.rel = "noopener";
      a.innerHTML = '<img src="' + L.img + '" alt="' + L.label + '">';
      root.appendChild(a);
      var lbl = document.createElement("div");
      lbl.className = "ms-lbl"; lbl.textContent = L.label;
      root.appendChild(lbl);
      icons.push({ a: a, lbl: lbl });
    });
    root._icons = icons;

    document.body.appendChild(root);
    layout();
  }

  function glow(id, dev) {
    var f = el("filter", { id: id, x: "-80%", y: "-80%", width: "260%", height: "260%" });
    f.appendChild(el("feGaussianBlur", { stdDeviation: dev, result: "b" }));
    var m = el("feMerge", {});
    m.appendChild(el("feMergeNode", { in: "b" }));
    m.appendChild(el("feMergeNode", { in: "SourceGraphic" }));
    f.appendChild(m);
    return f;
  }

  // гладкая кривая через точки (Catmull-Rom -> Bezier), без острых углов
  function smooth(pts) {
    if (pts.length < 2) return "";
    var d = "M" + pts[0].x + " " + pts[0].y;
    for (var i = 0; i < pts.length - 1; i++) {
      var p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || pts[i + 1];
      var c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6;
      var c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6;
      d += " C" + c1x + " " + c1y + " " + c2x + " " + c2y + " " + p2.x + " " + p2.y;
    }
    return d;
  }

  function layout() {
    var root = document.getElementById("magic-social");
    if (!root) return;
    var vw = window.innerWidth, vh = window.innerHeight;
    var contentW = Math.min(1360, vw * 0.95);
    var m = (vw - contentW) / 2;

    if (m < MIN_MARGIN) { root.classList.remove("on"); return; }
    root.classList.add("on");

    var half = ICON / 2;
    var n = root._icons.length;
    var pts = [];
    for (var i = 0; i < n; i++) {
      var x;
      if (i === 0) {
        // верхняя иконка тянется к центру (в свободную зону сбоку от заголовка)
        x = Math.min(m * XF[0], vw * 0.27);
      } else {
        // остальные держим в левом поле (правый край < начала контента)
        x = Math.min(m * XF[i], m - half - 6);
      }
      x = Math.round(Math.max(x, half + 6));
      var y = Math.round(Math.min(vh - 64, Math.max(96, vh * YFRAC[i])));
      pts.push({ x: x, y: y });
    }

    root._icons.forEach(function (it, i) {
      it.a.style.left = (pts[i].x - half) + "px";
      it.a.style.top  = (pts[i].y - half) + "px";
      it.lbl.style.left = pts[i].x + "px";
      it.lbl.style.top  = (pts[i].y + half + 6) + "px";
    });

    // СПИНА: одна плавная линия через центры (точки чуть отступают от иконок)
    root._spine.setAttribute("d", smooth(pts));

    // МОЛНИЯ: та же линия, но с доп. точками-выгибами между иконками,
    // переплетается вокруг спины — плавно (без острых углов)
    var bolt = [];
    for (var k = 0; k < n; k++) {
      bolt.push(pts[k]);
      if (k < n - 1) {
        var a = pts[k], b = pts[k + 1];
        var sgn = (k % 2 === 0) ? 1 : -1;
        var off = Math.min(24, m * 0.18);
        // три точки внутри сегмента, попеременно по сторонам спины —
        // переплетается вокруг неё (плавно, без острых углов)
        var w = [[0.78, 1], [0.50, -1], [0.22, 1]];
        for (var j = 0; j < w.length; j++) {
          var t = w[j][0];
          bolt.push({ x: a.x * t + b.x * (1 - t) + sgn * w[j][1] * off,
                      y: a.y * t + b.y * (1 - t) });
        }
      }
    }
    root._bolt.setAttribute("d", smooth(bolt));
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
