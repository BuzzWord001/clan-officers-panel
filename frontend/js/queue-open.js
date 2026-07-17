/* Таймер обратного отсчёта до автo-открытия раздела «Очередь за ресурсами с КХ».
 * В назначенное время раздел открывается для ВСЕХ автоматически (заглушка снимается),
 * а таймеры сами пропадают. Self-inject: рядом с кнопкой .q-enter (таблица Доблести).
 * На странице очереди таймер монтирует queue.js через window.QueueOpen.mount(). */
(function () {
  "use strict";
  // Время открытия: понедельник 20 июля 2026, 18:00 МСК (МСК = UTC+3).
  var OPEN_AT = new Date("2026-07-20T18:00:00+03:00");
  var WHEN_TXT = "в понедельник, 20 июля в 18:00 мск";

  function remaining() { return OPEN_AT.getTime() - Date.now(); }
  function isOpen() { return remaining() <= 0; }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function parts(ms) {
    if (ms < 0) ms = 0;
    var s = Math.floor(ms / 1000);
    var d = Math.floor(s / 86400); s -= d * 86400;
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.floor(s / 60); s -= m * 60;
    return { d: d, h: h, m: m, s: s };
  }

  function injectStyle() {
    if (document.getElementById("qopen-style")) return;
    var st = document.createElement("style");
    st.id = "qopen-style";
    st.textContent =
      ".qopen-timer{display:inline-flex;flex-direction:column;align-items:center;gap:6px;" +
        "padding:11px 20px 12px;border-radius:15px;font-family:system-ui,Segoe UI,Arial,sans-serif;line-height:1;" +
        "background:linear-gradient(180deg,rgba(52,33,13,.97),rgba(22,13,5,.97));" +
        "border:1px solid rgba(240,200,120,.5);box-shadow:0 8px 26px rgba(0,0,0,.5)," +
        "inset 0 1px 0 rgba(255,224,160,.16),0 0 30px rgba(245,200,120,.1)}" +
      ".qopen-lbl{display:flex;align-items:center;gap:5px;font:800 9.5px/1 system-ui;letter-spacing:1.3px;" +
        "text-transform:uppercase;color:#d9b06a;white-space:nowrap}" +
      ".qopen-clock{font:800 27px/1 'Segoe UI',Consolas,monospace;color:#ffe0a0;letter-spacing:1.5px;" +
        "text-shadow:0 0 15px rgba(245,200,120,.6);font-variant-numeric:tabular-nums}" +
      ".qopen-when{font:600 11px/1 system-ui;color:#9fe0a0;white-space:nowrap}" +
      ".qopen-live{font:800 16px system-ui;color:#9fe0a0;text-shadow:0 0 10px rgba(120,220,140,.5)}" +
      ".qopen-timer.big{padding:16px 30px 17px;gap:9px}" +
      ".qopen-timer.big .qopen-lbl{font-size:11.5px}" +
      ".qopen-timer.big .qopen-clock{font-size:42px}" +
      ".qopen-timer.big .qopen-when{font-size:12.5px}" +
      "@media(max-width:560px){.qopen-timer{padding:9px 15px 10px;gap:5px}.qopen-clock{font-size:22px}" +
        ".qopen-timer.big .qopen-clock{font-size:32px}}";
    document.head.appendChild(st);
  }

  // Создаёт живой элемент таймера. opts.label, opts.big, opts.onOpen (раз при 0).
  function mount(opts) {
    opts = opts || {};
    injectStyle();
    var el = document.createElement("div");
    el.className = "qopen-timer" + (opts.big ? " big" : "") + (opts.cls ? " " + opts.cls : "");
    var lbl = opts.label || "До открытия раздела";
    var fired = false, iv;
    function tick() {
      if (isOpen()) {
        el.innerHTML = '<span class="qopen-live">✅ Раздел открыт!</span>';
        if (iv) clearInterval(iv);
        if (!fired) { fired = true; if (opts.onOpen) opts.onOpen(); }
        return;
      }
      var t = parts(remaining());
      var clock = (t.d > 0 ? t.d + "д " : "") + pad(t.h) + ":" + pad(t.m) + ":" + pad(t.s);
      el.innerHTML =
        '<span class="qopen-lbl">⏳ ' + lbl + "</span>" +
        '<span class="qopen-clock">' + clock + "</span>" +
        '<span class="qopen-when">откроется ' + WHEN_TXT + "</span>";
    }
    tick();
    iv = setInterval(tick, 1000);
    el.__stop = function () { if (iv) clearInterval(iv); };
    return el;
  }

  window.QueueOpen = { at: OPEN_AT, whenText: WHEN_TXT, isOpen: isOpen, remaining: remaining, mount: mount };

  // Self-inject рядом с кнопкой входа .q-enter (страница Доблести).
  function injectNearButton() {
    var row = document.querySelector(".q-enter-row");
    if (!row || document.getElementById("qopen-near")) return;
    if (isOpen()) return;                              // уже открыто — таймер не нужен
    var t = mount({ label: "До открытия очереди", onOpen: function () {
      // раздел открылся — убираем таймер (он больше не нужен)
      var e = document.getElementById("qopen-near"); if (e) { if (e.__stop) e.__stop(); e.remove(); }
    } });
    t.id = "qopen-near";
    // таймер стоит ВПЛОТНУЮ к кнопке (оба прижаты вправо, между ними аккуратный зазор)
    row.style.gap = "14px";
    row.style.alignItems = "center";
    row.style.flexWrap = "wrap";
    var btn = row.querySelector(".q-enter");
    if (btn) row.insertBefore(t, btn); else row.insertBefore(t, row.firstChild);
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", injectNearButton);
  else injectNearButton();
})();
