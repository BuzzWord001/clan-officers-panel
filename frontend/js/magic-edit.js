/* magic-edit.js — редактор траектории "магической линии".
   Включается, если в URL есть #magicedit (или ?magicedit=1), либо вызовом
   window.magicEdit(). Кликами ставишь точки, тянешь их мышкой; линия рисуется
   тем же сглаживанием, что и боевая. Кнопка "Копировать" даёт координаты
   ОТНОСИТЕЛЬНО заголовка (rnd(R + dx, B + dy)) — их можно вставить в titleArch. */
(function () {
  "use strict";
  var SVGNS = "http://www.w3.org/2000/svg";
  var on = false, pts = [], drag = -1, justDragged = false, els = null;
  // подложка-картинка
  var img = { x: 0, y: 0, scale: 100, op: 45, shown: true, move: false, dragOff: null };

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
      "#medit-img{position:absolute;top:0;left:0;z-index:4990;pointer-events:none;" +
        "max-width:none;user-select:none}" +
      "#medit-img.move{outline:2px dashed rgba(90,180,255,.8)}" +
      "#medit-panel input[type=range]{width:100%;margin:2px 0 0}" +
      "#medit-panel label{display:block;font-size:11px;color:#d8c4a0;margin-top:7px}" +
      "#medit-panel button.act{background:linear-gradient(180deg,#1d4a6e,#0e2c44);border-color:#5aa0d8}" +
      "#medit .cap{position:absolute;top:0;left:0;width:100%;height:100%;fill:rgba(0,0,0,.01);cursor:crosshair}" +
      "#medit .ln{fill:none;stroke:#ff8a1e;stroke-width:5;stroke-linecap:round;stroke-linejoin:round;" +
        "filter:drop-shadow(0 0 6px #ff8a1e);pointer-events:none;opacity:.95}" +
      "#medit .pt{fill:#fff1c4;stroke:#a4520c;stroke-width:2;cursor:grab;filter:drop-shadow(0 0 4px #ffb14d)}" +
      "#medit .pt.first{fill:#9fe0ff}" +
      "#medit .pt.moved{fill:#7dff8a;stroke:#1a6b25}" +
      "#medit .pt.icon{fill:#ffcaf0;stroke:#7a2a63}" +
      "#medit .ghost{fill:none;stroke:#9fe0ff;stroke-width:1.5;opacity:.55}" +
      "#medit .disp{stroke:#9fe0ff;stroke-width:1.2;opacity:.6;stroke-dasharray:3 3}" +
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
    var pic = document.createElement("img"); pic.id = "medit-img";
    pic.src = "assets/trace.jpg?v=1793700000";
    pic.onerror = function () { pic.style.display = "none"; };
    root.appendChild(pic);
    var svg = el("svg", { width: "100%", height: "100%", style: "position:absolute;inset:0;overflow:visible" });
    var cap = el("rect", { class: "cap", x: 0, y: 0, width: "100%", height: "100%" });
    var ln = el("path", { class: "ln" });
    svg.appendChild(cap); svg.appendChild(ln);
    root.appendChild(svg);

    var panel = document.createElement("div"); panel.id = "medit-panel";
    panel.innerHTML =
      '<h4>✏️ Редактор магической линии</h4>' +
      '<p>1) Включи «Двигать картинку», подгони <b>заголовок на подложке</b> к настоящему ' +
      '(масштаб + перетаскивание). 2) Выключи «Двигать». 3) Кликай по красной линии — ' +
      'точки можно <b>тянуть</b>. 4) «Копировать» и пришли мне текст.</p>' +
      '<div class="row">' +
        '<button id="medit-imgtog">Скрыть картинку</button>' +
        '<button id="medit-move">🖐 Двигать картинку</button>' +
      '</div>' +
      '<label>Прозрачность подложки <span id="medit-opv">45%</span>' +
        '<input type="range" id="medit-op" min="8" max="90" value="45"></label>' +
      '<label>Масштаб подложки <span id="medit-scv">100%</span>' +
        '<input type="range" id="medit-sc" min="40" max="180" value="100"></label>' +
      '<div class="row"><button id="medit-load" class="x">Своя картинка…</button>' +
        '<input type="file" id="medit-file" accept="image/*" style="display:none"></div>' +
      '<hr style="border:0;border-top:1px solid rgba(224,140,40,.25);margin:10px 0 8px">' +
      '<div class="row"><button id="medit-loadline" class="act">↺ Загрузить точки текущей линии</button></div>' +
      '<p style="margin:6px 0 0">Перетаскивай точки. Сдвинутые подсветятся, и снизу запишется «было → стало» по каждой.</p>' +
      '<textarea readonly id="medit-out"></textarea>' +
      '<div class="row">' +
        '<button id="medit-copy">Копировать</button>' +
        '<button id="medit-undo">Отменить точку</button>' +
        '<button id="medit-clear">Очистить</button>' +
      '</div>' +
      '<div class="row"><button id="medit-close" class="x">Выйти из режима</button></div>';

    document.body.appendChild(root);
    document.body.appendChild(panel);

    els = { root: root, svg: svg, cap: cap, ln: ln, pic: pic, panel: panel,
            out: panel.querySelector("#medit-out") };
    applyImg();

    cap.addEventListener("click", function (e) {
      if (justDragged) { justDragged = false; return; }
      var p = { x: Math.round(e.clientX + window.scrollX), y: Math.round(e.clientY + window.scrollY) };
      pts.push(p); render();
    });
    window.addEventListener("pointermove", function (e) {
      if (drag < 0) return;
      pts[drag].x = Math.round(e.clientX + window.scrollX);   // x/y на месте —
      pts[drag].y = Math.round(e.clientY + window.scrollY);   // сохраняем orig/kind
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
    panel.querySelector("#medit-loadline").addEventListener("click", loadCurrentLine);

    // --- подложка ---
    panel.querySelector("#medit-imgtog").addEventListener("click", function () {
      img.shown = !img.shown; this.textContent = img.shown ? "Скрыть картинку" : "Показать картинку";
      applyImg();
    });
    var moveBtn = panel.querySelector("#medit-move");
    moveBtn.addEventListener("click", function () {
      img.move = !img.move;
      this.classList.toggle("act", img.move);
      els.cap.style.pointerEvents = img.move ? "none" : "";
      els.pic.classList.toggle("move", img.move);
    });
    panel.querySelector("#medit-op").addEventListener("input", function () {
      img.op = +this.value; panel.querySelector("#medit-opv").textContent = img.op + "%"; applyImg();
    });
    panel.querySelector("#medit-sc").addEventListener("input", function () {
      img.scale = +this.value; panel.querySelector("#medit-scv").textContent = img.scale + "%"; applyImg();
    });
    var fileInp = panel.querySelector("#medit-file");
    panel.querySelector("#medit-load").addEventListener("click", function () { fileInp.click(); });
    fileInp.addEventListener("change", function () {
      var f = this.files && this.files[0]; if (!f) return;
      var rd = new FileReader();
      rd.onload = function (ev) { els.pic.style.display = ""; els.pic.src = ev.target.result; applyImg(); };
      rd.readAsDataURL(f);
    });

    // перетаскивание подложки (в режиме "Двигать картинку")
    window.addEventListener("pointerdown", function (e) {
      if (!on || !img.move) return;
      if (els.panel.contains(e.target)) return;
      img.dragOff = { x: e.clientX + window.scrollX - img.x, y: e.clientY + window.scrollY - img.y };
    });
    window.addEventListener("pointermove", function (e) {
      if (!img.dragOff) return;
      img.x = Math.round(e.clientX + window.scrollX - img.dragOff.x);
      img.y = Math.round(e.clientY + window.scrollY - img.dragOff.y);
      applyImg();
    });
    window.addEventListener("pointerup", function () { img.dragOff = null; });
  }

  function applyImg() {
    if (!els || !els.pic) return;
    var p = els.pic;
    p.style.display = img.shown ? "" : "none";
    p.style.left = img.x + "px";
    p.style.top = img.y + "px";
    p.style.opacity = (img.op / 100);
    p.style.width = (window.innerWidth * img.scale / 100) + "px";
  }

  function loadCurrentLine() {
    var ml = window.__magicLine;
    if (!ml || !ml.pts || !ml.pts.length) {
      els.out.value = "Линия не найдена. Открой страницу Доблести (#magicedit) — " +
                      "линия должна быть видна, тогда её точки подгрузятся.";
      return;
    }
    var tr = titleRect();
    var R = tr ? tr.R : ml.R, B = tr ? tr.B : ml.B;
    pts = ml.pts.map(function (p) {
      return { x: R + p.dx, y: B + p.dy, orig: { dx: p.dx, dy: p.dy }, kind: p.kind };
    });
    render();
  }

  function fmt(dx, dy) {
    return "R " + (dx >= 0 ? "+ " : "- ") + Math.abs(dx) +
           ", B " + (dy >= 0 ? "+ " : "- ") + Math.abs(dy);
  }

  function render() {
    var tr = titleRect();
    var R = tr ? tr.R : 0, B = tr ? tr.B : 0;
    els.ln.setAttribute("d", smooth(pts));
    Array.prototype.slice.call(
      els.svg.querySelectorAll(".pt,.num,.ghost,.disp")).forEach(function (n) { n.remove(); });

    pts.forEach(function (p, i) {
      var moved = p.orig && (Math.round(p.x - R) !== p.orig.dx || Math.round(p.y - B) !== p.orig.dy);
      if (p.orig) {
        var ox = R + p.orig.dx, oy = B + p.orig.dy;
        if (moved) {                       // призрак старого места + пунктир сдвига
          els.svg.appendChild(el("line", { class: "disp", x1: ox, y1: oy, x2: p.x, y2: p.y }));
          els.svg.appendChild(el("circle", { class: "ghost", cx: ox, cy: oy, r: 6 }));
        }
      }
      var cls = "pt";
      if (p.kind === "icon") cls += " icon";
      if (moved) cls += " moved";
      else if (i === 0 && !p.orig) cls += " first";
      var c = el("circle", { class: cls, cx: p.x, cy: p.y, r: 8 });
      c.addEventListener("pointerdown", function (e) { e.stopPropagation(); drag = i; });
      els.svg.appendChild(c);
      var t = el("text", { class: "num", x: p.x, y: p.y - 12 }); t.textContent = (i + 1);
      els.svg.appendChild(t);
    });

    // вывод: карта «было → стало» + готовый список новых координат
    var movedList = [], full = [], nMoved = 0;
    pts.forEach(function (p, i) {
      var dx = Math.round(p.x - R), dy = Math.round(p.y - B);
      full.push("rnd(" + fmt(dx, dy) + "),   // #" + (i + 1) +
                (p.kind === "icon" ? " [иконка]" : ""));
      if (p.orig && (dx !== p.orig.dx || dy !== p.orig.dy)) {
        nMoved++;
        movedList.push("// #" + (i + 1) + (p.kind === "icon" ? " [иконка]" : "") +
                       ":  было (" + fmt(p.orig.dx, p.orig.dy) + ")  ->  стало (" + fmt(dx, dy) + ")");
      }
    });
    var head = "// title R=" + R + " B=" + B + " | точек: " + pts.length + ", сдвинуто: " + nMoved + "\n";
    var out = head;
    if (movedList.length) out += "// === СДВИНУТЫЕ (было -> стало) ===\n" + movedList.join("\n") + "\n";
    out += "// === ВСЕ точки сейчас ===\n" + full.join("\n") + "\n";
    els.out.value = out;
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
