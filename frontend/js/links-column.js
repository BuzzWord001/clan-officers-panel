// links-column.js — простая красивая колонка «на связи»: три ссылки в столбик
// (Чат Telegram, Чат ВК, TeamSpeak) в стиле сайта. Крупные тап-таргеты,
// клик открывает ссылку, есть кнопка «копировать». Вставляется в любой
// контейнер [data-links-col]; заголовок задаётся через data-title.
// Группа ВК тут намеренно отсутствует (Лир 2026-07-25).
(function () {
  "use strict";

  var LINKS = [
    { key: "tg", name: "Чат Telegram", glow: "#2aa6e4",
      img: "assets/social/tg.png",
      href: "https://t.me/+6U3XCSrrZgo1YTMy",
      disp: "t.me/+6U3XCSrrZgo1YTMy",
      copy: "https://t.me/+6U3XCSrrZgo1YTMy", ext: true },
    { key: "vk-chat", name: "Чат ВКонтакте", glow: "#f56a24",
      img: "assets/social/vk-chat.png",
      href: "https://vk.me/join/rya0CI_hEnkgsCQdahj2jIb3r0wD6OHIA_E=",
      disp: "vk.me/join/…",
      copy: "https://vk.me/join/rya0CI_hEnkgsCQdahj2jIb3r0wD6OHIA_E=", ext: true },
    { key: "ts", name: "TeamSpeak (голос)", glow: "#ff5e1c",
      img: "assets/social/ts.png",
      href: "ts3server://melodybum.ts3.se",
      disp: "melodybum.ts3.se",
      copy: "melodybum.ts3.se",
      // IP-фолбэк, если по адресу не подключается
      sub: { disp: "45.151.182.57:10440", copy: "45.151.182.57:10440",
             note: "не подключается по адресу? скопируй IP" } }
  ];

  var CSS =
    ".lcol{max-width:460px;margin:20px auto 8px;padding:15px 16px 16px;border-radius:16px;" +
      "background:linear-gradient(180deg,rgba(32,21,10,.78),rgba(17,11,5,.86));" +
      "border:1px solid rgba(224,140,40,.38);" +
      "box-shadow:0 8px 26px rgba(0,0,0,.5),0 0 20px rgba(224,140,40,.12),inset 0 1px 0 rgba(255,210,140,.08)}" +
    ".lcol-title{text-align:center;font:800 13px/1.25 system-ui,sans-serif;letter-spacing:.7px;" +
      "text-transform:uppercase;color:#f4dcb0;margin:0 0 13px;text-shadow:0 1px 2px #000;" +
      "display:flex;align-items:center;justify-content:center;gap:9px}" +
    ".lcol-title::before,.lcol-title::after{content:'';height:1px;flex:1;max-width:54px;" +
      "background:linear-gradient(90deg,transparent,rgba(224,140,40,.6),transparent)}" +
    ".lcol-list{display:flex;flex-direction:column;gap:10px}" +
    ".lcol-item{position:relative;display:flex;align-items:center;gap:12px;padding:11px 12px;" +
      "border-radius:13px;background:linear-gradient(180deg,#2c1d0d,#1b1108);" +
      "border:1px solid rgba(224,140,40,.42);" +
      "transition:transform .16s ease,box-shadow .16s ease,filter .16s ease}" +
    ".lcol-item:hover{transform:translateY(-2px);filter:brightness(1.07);" +
      "box-shadow:0 7px 18px rgba(0,0,0,.55),0 0 17px var(--g)}" +
    ".lcol-link{flex:1;min-width:0;display:flex;align-items:center;gap:12px;text-decoration:none}" +
    ".lcol-ic{flex:none;width:44px;height:44px;border-radius:11px;overflow:hidden;" +
      "filter:drop-shadow(0 0 7px var(--g))}" +
    ".lcol-ic img{width:100%;height:100%;display:block;-webkit-user-drag:none}" +
    ".lcol-tx{display:flex;flex-direction:column;min-width:0}" +
    ".lcol-nm{font:800 15.5px/1.2 system-ui,sans-serif;color:#f7e4bc;text-shadow:0 1px 2px #000}" +
    ".lcol-url{font:600 11px/1.35 ui-monospace,Consolas,monospace;color:#e6c391;opacity:.78;" +
      "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:250px;margin-top:1px}" +
    ".lcol-go{flex:none;color:#e8b57a;font:800 15px/1;opacity:.65;transition:opacity .16s,transform .16s}" +
    ".lcol-item:hover .lcol-go{opacity:1;transform:translateX(2px)}" +
    ".lcol-copy{flex:none;cursor:pointer;border:1px solid rgba(224,140,40,.5);border-radius:8px;" +
      "background:linear-gradient(180deg,#3a2a14,#241809);color:#f4dcb0;" +
      "font:700 10px/1 system-ui,sans-serif;padding:8px 9px;white-space:nowrap;transition:filter .15s}" +
    ".lcol-copy:hover{filter:brightness(1.18)}" +
    ".lcol-copy.ok{color:#cde8ac;border-color:#6fae5a}" +
    ".lcol-sub{display:flex;align-items:center;gap:8px;margin:2px 0 0 56px;flex-wrap:wrap}" +
    ".lcol-sub-note{font:600 10px/1.3 system-ui,sans-serif;color:#e0a86a;opacity:.9}" +
    ".lcol-sub-url{font:600 10.5px/1 ui-monospace,Consolas,monospace;color:#e6c391;opacity:.85}" +
    "@media(max-width:520px){.lcol{margin:14px 8px 6px}.lcol-url{max-width:150px}}";

  function injectCSS() {
    if (document.getElementById("lcol-css")) return;
    var s = document.createElement("style");
    s.id = "lcol-css"; s.textContent = CSS;
    document.head.appendChild(s);
  }

  function copyText(text, btn) {
    function ok() {
      var prev = btn.textContent; btn.textContent = "✓"; btn.classList.add("ok");
      setTimeout(function () { btn.textContent = prev; btn.classList.remove("ok"); }, 1300);
    }
    function fallback() {
      try {
        var ta = document.createElement("textarea");
        ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.focus(); ta.select();
        document.execCommand("copy"); ta.remove(); ok();
      } catch (_) {}
    }
    if (navigator.clipboard && navigator.clipboard.writeText)
      navigator.clipboard.writeText(text).then(ok, fallback);
    else fallback();
  }

  function build(box) {
    if (box.__lcolBuilt) return;
    box.__lcolBuilt = true;
    box.classList.add("lcol");

    var title = document.createElement("div");
    title.className = "lcol-title";
    title.textContent = box.getAttribute("data-title") || "Мы на связи — заходи";
    box.appendChild(title);

    var list = document.createElement("div");
    list.className = "lcol-list";

    LINKS.forEach(function (l) {
      var item = document.createElement("div");
      item.className = "lcol-item";
      item.style.setProperty("--g", l.glow);

      var a = document.createElement("a");
      a.className = "lcol-link";
      a.href = l.href;
      if (l.ext) { a.target = "_blank"; a.rel = "noopener noreferrer"; }
      a.innerHTML =
        '<span class="lcol-ic"><img src="' + l.img + '?v=1792700000" alt="" ' +
          'width="44" height="44" loading="lazy"></span>' +
        '<span class="lcol-tx"><span class="lcol-nm">' + l.name + '</span>' +
          '<span class="lcol-url">' + l.disp + '</span></span>' +
        '<span class="lcol-go" aria-hidden="true">›</span>';
      item.appendChild(a);

      var copy = document.createElement("button");
      copy.type = "button";
      copy.className = "lcol-copy";
      copy.textContent = "Копир.";
      copy.setAttribute("aria-label", "Скопировать: " + l.copy);
      copy.addEventListener("click", function (e) {
        e.preventDefault(); e.stopPropagation(); copyText(l.copy, copy);
      });
      item.appendChild(copy);

      list.appendChild(item);

      // доп. строка (IP-фолбэк TeamSpeak)
      if (l.sub) {
        var sub = document.createElement("div");
        sub.className = "lcol-sub";
        var note = document.createElement("span");
        note.className = "lcol-sub-note"; note.textContent = l.sub.note;
        var surl = document.createElement("span");
        surl.className = "lcol-sub-url"; surl.textContent = l.sub.disp;
        var sbtn = document.createElement("button");
        sbtn.type = "button"; sbtn.className = "lcol-copy";
        sbtn.textContent = "Копир."; sbtn.style.padding = "5px 7px";
        sbtn.setAttribute("aria-label", "Скопировать IP: " + l.sub.copy);
        sbtn.addEventListener("click", function (e) {
          e.preventDefault(); e.stopPropagation(); copyText(l.sub.copy, sbtn);
        });
        sub.appendChild(note); sub.appendChild(surl); sub.appendChild(sbtn);
        list.appendChild(sub);
      }
    });

    box.appendChild(list);
  }

  function init() {
    injectCSS();
    var nodes = document.querySelectorAll("[data-links-col]");
    for (var i = 0; i < nodes.length; i++) build(nodes[i]);
  }

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", init);
  else init();
})();
