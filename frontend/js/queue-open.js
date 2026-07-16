/* Таймер обратного отсчёта до автo-открытия раздела «Очередь за ресурсами с КХ».
 * В назначенное время раздел открывается для ВСЕХ автоматически (заглушка снимается),
 * а таймеры сами пропадают. Self-inject: рядом с кнопкой .q-enter (таблица Доблести).
 * На странице очереди таймер монтирует queue.js через window.QueueOpen.mount(). */
(function () {
  "use strict";
  // Время открытия: 18 июля 2026, 18:00 МСК (МСК = UTC+3).
  var OPEN_AT = new Date("2026-07-18T18:00:00+03:00");
  var WHEN_TXT = "18 июля в 18:00 мск";

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
      ".qopen-timer{display:inline-flex;flex-direction:column;align-items:center;gap:2px;" +
        "padding:8px 15px;border-radius:13px;font-family:system-ui,Segoe UI,Arial,sans-serif;" +
        "background:linear-gradient(180deg,rgba(46,29,12,.96),rgba(20,12,5,.96));" +
        "border:1px solid rgba(240,200,120,.55);box-shadow:0 6px 22px rgba(0,0,0,.5)," +
        "inset 0 1px 0 rgba(255,224,160,.14),0 0 26px rgba(245,200,120,.1)}" +
      ".qopen-lbl{font:700 10px system-ui;letter-spacing:.5px;text-transform:uppercase;color:#caa66a;white-space:nowrap}" +
      ".qopen-clock{font:800 24px/1 'Segoe UI',Consolas,monospace;color:#ffd98a;letter-spacing:1px;" +
        "text-shadow:0 0 12px rgba(245,200,120,.55);font-variant-numeric:tabular-nums}" +
      ".qopen-when{font:600 10.5px system-ui;color:#9fe0a0;white-space:nowrap}" +
      ".qopen-live{font:800 15px system-ui;color:#9fe0a0;text-shadow:0 0 10px rgba(120,220,140,.5)}" +
      ".qopen-timer.big{padding:14px 26px;gap:4px}" +
      ".qopen-timer.big .qopen-clock{font-size:38px}" +
      ".qopen-timer.big .qopen-lbl{font-size:12px}.qopen-timer.big .qopen-when{font-size:12.5px}" +
      "@media(max-width:560px){.qopen-clock{font-size:20px}.qopen-timer.big .qopen-clock{font-size:30px}}";
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
    t.style.marginRight = "auto";                      // прижать к кнопке слева
    row.style.justifyContent = "space-between";
    row.insertBefore(t, row.firstChild);
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", injectNearButton);
  else injectNearButton();
})();
