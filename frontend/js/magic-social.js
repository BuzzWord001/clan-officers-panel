/* magic-social.js — кликабельные иконки соцсетей по краям страницы,
   соединённые плавной "магической" линией. Показывается только когда
   по бокам от контента есть свободное место (широкие экраны). */
(function () {
  "use strict";

  var LINKS = [
    { key: "tg",       href: "https://t.me/+6U3XCSrrZgo1YTMy",                 title: "Telegram клана",   img: "assets/social/tg.png" },
    { key: "ts",       href: "ts3server://melodybum.ts3.se",                   title: "TeamSpeak — melodybum.ts3.se", img: "assets/social/ts.png" },
    { key: "vk-group", href: "https://vk.com/club38888207",                   title: "Группа ВКонтакте", img: "assets/social/vk-group.png" },
    { key: "vk-chat",  href: "https://vk.me/join/rya0CI_hEnkgsCQdahj2jIb3r0wD6OHIA_E=", title: "Чат ВКонтакте", img: "assets/social/vk-chat.png" }
  ];

  var ICON = 60;        // размер иконки, px
  var MIN_MARGIN = 92;  // минимум свободного поля сбоку, иначе скрываем
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
      ".ms-line{fill:none;stroke:url(#msGrad);stroke-width:2.4;stroke-linecap:round;" +
        "filter:url(#msGlow);opacity:.85;" +
        "stroke-dasharray:7 11;animation:msFlow 5.5s linear infinite}" +
      ".ms-line.b{animation-direction:reverse}" +
      "@keyframes msFlow{to{stroke-dashoffset:-36}}" +
      ".ms-ico{position:absolute;width:" + ICON + "px;height:" + ICON + "px;pointer-events:auto;" +
        "border-radius:15px;display:block;transition:transform .18s ease,filter .18s ease;" +
        "filter:drop-shadow(0 0 6px rgba(224,140,40,.55)) drop-shadow(0 3px 7px rgba(0,0,0,.6))}" +
      ".ms-ico img{width:100%;height:100%;display:block;-webkit-user-drag:none;user-select:none}" +
      ".ms-ico:hover{transform:scale(1.13);" +
        "filter:drop-shadow(0 0 13px rgba(255,170,60,.95)) drop-shadow(0 4px 9px rgba(0,0,0,.7))}" +
      ".ms-ico::after{content:attr(data-tip);position:absolute;left:50%;top:calc(100% + 7px);" +
        "transform:translateX(-50%) translateY(4px);white-space:nowrap;padding:4px 9px;border-radius:7px;" +
        "background:rgba(20,13,7,.95);border:1px solid rgba(224,140,40,.5);color:#f0d6ad;" +
        "font:600 11px/1.2 system-ui,sans-serif;opacity:0;pointer-events:none;transition:opacity .18s ease}" +
      ".ms-ico.r::after{left:auto;right:50%;transform:translateX(50%) translateY(4px)}" +
      ".ms-ico:hover::after{opacity:1;transform:translateX(-50%) translateY(0)}" +
      ".ms-ico.r:hover::after{transform:translateX(50%) translateY(0)}";
    document.head.appendChild(style);

    var root = document.createElement("div");
    root.id = "magic-social";
    root.setAttribute("aria-hidden", "false");

    var svg = el("svg", { preserveAspectRatio: "none" });
    var defs = el("defs", {});
    var grad = el("linearGradient", { id: "msGrad", x1: "0", y1: "0", x2: "0", y2: "1" });
    grad.appendChild(el("stop", { offset: "0",  "stop-color": "#ffd27a" }));
    grad.appendChild(el("stop", { offset: ".5", "stop-color": "#e88a28" }));
    grad.appendChild(el("stop", { offset: "1",  "stop-color": "#ff7a18" }));
    defs.appendChild(grad);
    var f = el("filter", { id: "msGlow", x: "-60%", y: "-60%", width: "220%", height: "220%" });
    f.appendChild(el("feGaussianBlur", { stdDeviation: "3", result: "b" }));
    var merge = el("feMerge", {});
    merge.appendChild(el("feMergeNode", { in: "b" }));
    merge.appendChild(el("feMergeNode", { in: "SourceGraphic" }));
    f.appendChild(merge);
    defs.appendChild(f);
    svg.appendChild(defs);

    var pathL = el("path", { class: "ms-line" });
    var pathR = el("path", { class: "ms-line b" });
    svg.appendChild(pathL);
    svg.appendChild(pathR);
    root.appendChild(svg);

    var icons = {};
    LINKS.forEach(function (L) {
      var a = document.createElement("a");
      a.className = "ms-ico";
      a.href = L.href;
      a.title = L.title;
      a.setAttribute("data-tip", L.title);
      if (L.key.indexOf("vk") === 0) a.classList.add("r");
      if (L.key === "vk-group" || L.key === "vk-chat" || L.key === "tg") {
        a.target = "_blank"; a.rel = "noopener";
      }
      a.innerHTML = '<img src="' + L.img + '" alt="' + L.title + '">';
      root.appendChild(a);
      icons[L.key] = a;
    });

    document.body.appendChild(root);
    root._svg = svg; root._pathL = pathL; root._pathR = pathR; root._icons = icons;
    layout();
  }

  // плавная вертикальная "магическая" линия между двумя точками,
  // с изгибом наружу к краю экрана (cubic bezier — без острых углов)
  function curve(x1, y1, x2, y2, bow) {
    var cx1 = x1 + bow, cx2 = x2 + bow;
    var my = (y1 + y2) / 2;
    return "M" + x1 + " " + y1 +
           " C" + cx1 + " " + (y1 + (my - y1) * 0.5) +
           " "  + cx2 + " " + (y2 - (y2 - my) * 0.5) +
           " "  + x2 + " " + y2;
  }

  function layout() {
    var root = document.getElementById("magic-social");
    if (!root) return;
    var vw = window.innerWidth, vh = window.innerHeight;
    var contentW = Math.min(1360, vw * 0.95);
    var margin = (vw - contentW) / 2;

    if (margin < MIN_MARGIN) { root.classList.remove("on"); return; }
    root.classList.add("on");

    var lcx = margin / 2;             // центр левого поля
    var rcx = vw - margin / 2;        // центр правого поля
    var topY = Math.max(150, vh * 0.26);
    var botY = topY + Math.min(220, vh * 0.30);
    var half = ICON / 2;

    function place(key, cx, cy) {
      var a = root._icons[key];
      a.style.left = (cx - half) + "px";
      a.style.top = (cy - half) + "px";
    }
    place("tg", lcx, topY);
    place("ts", lcx, botY);
    place("vk-group", rcx, topY);
    place("vk-chat", rcx, botY);

    // линия идёт от нижнего края верхней иконки к верхнему краю нижней,
    // выгибаясь наружу к краю экрана
    var bowL = -Math.min(34, margin * 0.32);
    var bowR = Math.min(34, margin * 0.32);
    root._pathL.setAttribute("d", curve(lcx, topY + half + 3, lcx, botY - half - 3, bowL));
    root._pathR.setAttribute("d", curve(rcx, topY + half + 3, rcx, botY - half - 3, bowR));
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
