/* magic-edit.js — редактор траектории "магической линии".
   Включается, если в URL есть #magicedit (или ?magicedit=1), либо вызовом
   window.magicEdit(). Кликами ставишь точки, тянешь их мышкой; линия рисуется
   тем же сглаживанием, что и боевая. Кнопка "Копировать" даёт координаты
   ОТНОСИТЕЛЬНО заголовка (rnd(R + dx, B + dy)) — их можно вставить в titleArch. */
(function () {
  "use strict";
  var SVGNS = "http://www.w3.org/2000/svg";
  var on = false, pts = [], drag = -1, justDragged = false, els = null;

  function el(tag, a) { var e = document.createElementNS(SVGNS, tag); for (var k in a) e.setAttribute(k, a[k]); return e; }

  function titleRect() {
    var g = document.querySelector(".glitch");
    if (!g) return null;
    var r = document.createRange(); r.selectNodeContents(g);
    var b = r.getBoundingClientRect();
    var sx = window.scrollX, sy = window.scrollY;
    var L = b.left + sx, R = b.right + sx, T = b.top + sy, B = b.bottom + sy;
    return { L: Math.round(L), R: Math.round(R), T: Math.round(T), B: Math.round(B),
             cx: Math.round((L + R) / 2), cy: Math.round((T + B) / 2), w: Math.round(b.width) };
  }

  function smooth(p) {
    if (p.length < 2) return p.length ? "M" + p[0].x + " " + p[0].y : "";
    var d = "M" + p[0].x + " " + p[0].y;
    for (var i = 0; i < p.length - 1; i++) {
      var p0 = p[i - 1] || p[i], p1 = p[i], p2 = p[i + 1], p3 = p[i + 2] || p[i + 1];
      d += " C" + (p1.x + (p2.x - p0.x) / 6) + " " + (p1.y + (p2.y - p0.y) / 6) +
           " "  + (p2.x - (p3.x - p1.x) / 6) + " " + (p2.y - (p3.y - p1.y) / 6) +
           " "  + p2.x + " " + p2.y;
    }
    return d;
  }

  function build() {
    if (els) return;
    var st = document.createElement("style");
    st.textContent =
      "#medit{position:absolute;top:0;left:0;width:100%;height:1500px;z-index:5000}" +
      "#medit .cap{position:absolute;top:0;left:0;width:100%;height:100%;fill:rgba(0,0,0,.01);cursor:crosshair}" +
      "#medit .ln{fill:none;stroke:#ff8a1e;stroke-width:5;stroke-linecap:round;stroke-linejoin:round;" +
        "filter:drop-shadow(0 0 6px #ff8a1e);pointer-events:none;opacity:.95}" +
      "#medit .pt{fill:#fff1c4;stroke:#a4520c;stroke-width:2;cursor:grab;filter:drop-shadow(0 0 4px #ffb14d)}" +
      "#medit .pt.first{fill:#9fe0ff}" +
      "#medit .num{fill:#fff;font:700 11px sans-serif;pointer-events:none;text-anchor:middle}" +
      "#medit-panel{position:fixed;left:14px;bottom:14px;z-index:5100;width:330px;max-width:calc(100vw - 28px);" +
        "background:rgba(16,11,6,.97);border:1px solid rgba(224,140,40,.55);border-radius:12px;" +
        "padding:12px 13px;color:#f0d9af;font:13px/1.4 system-ui,sans-serif;" +
        "box-shadow:0 10px 30px rgba(0,0,0,.6)}" +
      "#medit-panel h4{margin:0 0 6px;font-size:13px;color:#ffd27a}" +
      "#medit-panel p{margin:0 0 8px;font-size:11.5px;color:#d8c4a0}" +
      "#medit-panel textarea{width:100%;height:120px;box-sizing:border-box;resize:vertical;" +
        "background:#0d0904;color:#ffe6b0;border:1px solid rgba(224,140,40,.4);border-radius:7px;" +
        "font:11px/1.35 ui-monospace,Consolas,monospace;padding:7px}" +
      "#medit-panel .row{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}" +
      "#medit-panel button{flex:1;min-width:70px;cursor:pointer;border:1px solid rgba(224,140,40,.5);" +
        "background:linear-gradient(180deg,#3a2a14,#241809);color:#f4dcb0;font:700 11px system-ui;" +
        "padding:8px 6px;border-radius:7px}" +
      "#medit-panel button:hover{filter:brightness(1.15)}" +
      "#medit-panel button.x{flex:0 0 auto}";
    document.head.appendChild(st);

    var root = document.createElement("div"); root.id = "medit";
    var svg = el("svg", { width: "100%", height: "100%", style: "position:absolute;inset:0;overflow:visible" });
    var cap = el("rect", { class: "cap", x: 0, y: 0, width: "100%", height: "100%" });
    var ln = el("path", { class: "ln" });
    svg.appendChild(cap); svg.appendChild(ln);
    root.appendChild(svg);

    var panel = document.createElement("div"); panel.id = "medit-panel";
    panel.innerHTML =
      '<h4>✏️ Редактор магической линии</h4>' +
      '<p>Кликай по странице — ставит точки по порядку. Точки можно <b>тянуть</b> мышкой. ' +
      'Поставь как должна идти линия, нажми «Копировать» и пришли мне текст.</p>' +
      '<textarea readonly id="medit-out"></textarea>' +
      '<div class="row">' +
        '<button id="medit-copy">Копировать</button>' +
        '<button id="medit-undo">Отменить точку</button>' +
        '<button id="medit-clear">Очистить</button>' +
      '</div>' +
      '<div class="row"><button id="medit-close" class="x">Выйти из режима</button></div>';

    document.body.appendChild(root);
    document.body.appendChild(panel);

    els = { root: root, svg: svg, cap: cap, ln: ln, out: panel.querySelector("#medit-out") };

    cap.addEventListener("click", function (e) {
      if (justDragged) { justDragged = false; return; }
      var p = { x: Math.round(e.clientX + window.scrollX), y: Math.round(e.clientY + window.scrollY) };
      pts.push(p); render();
    });
    window.addEventListener("pointermove", function (e) {
      if (drag < 0) return;
      pts[drag] = { x: Math.round(e.clientX + window.scrollX), y: Math.round(e.clientY + window.scrollY) };
      render();
    });
    window.addEventListener("pointerup", function () {
      if (drag >= 0) { drag = -1; justDragged = true; }
    });

    panel.querySelector("#medit-copy").addEventListener("click", function () {
      var t = els.out.value;
      if (navigator.clipboard) navigator.clipboard.writeText(t).catch(function(){});
      els.out.select(); try { document.execCommand("copy"); } catch (e) {}
      this.textContent = "Скопировано ✓"; var b = this;
      setTimeout(function () { b.textContent = "Копировать"; }, 1400);
    });
    panel.querySelector("#medit-undo").addEventListener("click", function () { pts.pop(); render(); });
    panel.querySelector("#medit-clear").addEventListener("click", function () { pts = []; render(); });
    panel.querySelector("#medit-close").addEventListener("click", function () { toggle(false); });
  }

  function render() {
    var tr = titleRect();
    // линия
    els.ln.setAttribute("d", smooth(pts));
    // точки
    Array.prototype.slice.call(els.svg.querySelectorAll(".pt,.num")).forEach(function (n) { n.remove(); });
    pts.forEach(function (p, i) {
      var c = el("circle", { class: "pt" + (i === 0 ? " first" : ""), cx: p.x, cy: p.y, r: 8 });
      c.addEventListener("pointerdown", function (e) { e.stopPropagation(); drag = i; });
      els.svg.appendChild(c);
      var t = el("text", { class: "num", x: p.x, y: p.y - 12 }); t.textContent = (i + 1);
      els.svg.appendChild(t);
    });
    // вывод координат относительно заголовка
    var lines = "// title: R=" + (tr ? tr.R : "?") + " B=" + (tr ? tr.B : "?") +
                " cx=" + (tr ? tr.cx : "?") + " (точек: " + pts.length + ")\n";
    pts.forEach(function (p) {
      if (!tr) return;
      var dx = p.x - tr.R, dy = p.y - tr.B;
      lines += "rnd(R " + (dx >= 0 ? "+ " : "- ") + Math.abs(dx) +
               ", B " + (dy >= 0 ? "+ " : "- ") + Math.abs(dy) + "),\n";
    });
    els.out.value = lines;
  }

  function toggle(v) {
    on = (v === undefined) ? !on : v;
    if (on) {
      build();
      els.root.style.display = ""; document.getElementById("medit-panel").style.display = "";
      render();
    } else if (els) {
      els.root.style.display = "none"; document.getElementById("medit-panel").style.display = "none";
    }
  }

  window.magicEdit = function () { toggle(true); };

  function maybeAuto() {
    if (/magicedit/i.test(location.hash) || /magicedit/i.test(location.search)) toggle(true);
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", maybeAuto);
  else maybeAuto();
  window.addEventListener("hashchange", maybeAuto);
})();
