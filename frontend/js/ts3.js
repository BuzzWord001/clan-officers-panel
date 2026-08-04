/* TeamSpeak 3 — карточки скачивания. Блок ЕДИНЫЙ для всех страниц: если его
 * нет в разметке (другие вкладки) — создаём и вставляем первым в <main>, перед
 * вкладками.
 *
 * ПК (Windows/macOS/Linux): файлы раздаёт наш сервер (/ts3/download/<platform>),
 *   версия/размер берутся из /ts3/info.
 * ТЕЛЕФОН (min(vw,vh)≤600): показываем 2 плитки — Android и iPhone/iPad. Их
 *   нельзя раздать файлом (Google/Apple запрещают .apk/.ipa), поэтому тап ведёт
 *   в официальный магазин (Google Play / App Store).
 * Набор плиток перерисовывается при повороте/ресайзе. Публично — гость/офицер/админ. */
(function () {
  "use strict";
  var API = (window.OFFICERS_CONFIG && window.OFFICERS_CONFIG.API_URL) || "";
  var ICON_V = "1796700000";

  var DESKTOP = [
    { key: "windows", name: "Windows" },
    { key: "macos",   name: "macOS" },
    { key: "linux",   name: "Linux" }
  ];
  var MOBILE = [
    { key: "android", name: "Android", store: "Google Play",
      url: "https://play.google.com/store/apps/details?id=com.teamspeak.ts3client" },
    { key: "ios", name: "iPhone · iPad", store: "App Store",
      url: "https://apps.apple.com/app/teamspeak-3/id577628510" }
  ];
  var OFFICIAL = "https://teamspeak.com/en/downloads/?product=ts3#ts3client";

  var lastInfo = null;   // последний ответ /ts3/info — применяем к ПК-плиткам
  var curMode = null;    // "phone" | "desktop"

  function isPhone() { return Math.min(window.innerWidth, window.innerHeight) <= 600; }

  function fmtSize(b) {
    if (!b) return "";
    var mb = b / 1048576;
    return mb >= 1 ? mb.toFixed(0) + " МБ" : Math.round(b / 1024) + " КБ";
  }

  function mkIcon(key, alt) {
    var img = document.createElement("img");
    img.className = "ts3-ic";
    img.src = "assets/ts3/" + key + ".png?v=" + ICON_V;
    img.alt = alt; img.loading = "lazy";
    return img;
  }
  function mkSpan(cls, text) {
    var s = document.createElement("span");
    s.className = cls; s.textContent = text; return s;
  }

  // Гарантирует контейнер блока (заголовок + .ts3-cards + ссылка на офсайт).
  function ensureBlock() {
    var box = document.getElementById("ts3-dl");
    if (!box) {
      var main = document.querySelector("main");
      if (!main) return null;
      box = document.createElement("div");
      box.className = "ts3-dl"; box.id = "ts3-dl";
      var tabs = main.querySelector(".tabs");
      main.insertBefore(box, tabs || main.firstChild);
    }
    if (!box.querySelector(".ts3-dl-title")) {
      var title = document.createElement("div");
      title.className = "ts3-dl-title";
      // Цифру 3 — в span: у Georgia старостильная 3 свисает ниже букв,
      // .ts3-fig рисует её lining-шрифтом ровно по базовой линии (см. styles.css).
      title.innerHTML = 'TeamSpeak <span class="ts3-fig">3</span> — скачать клиент';
      box.appendChild(title);
    }
    if (!box.querySelector(".ts3-cards")) {
      var cards = document.createElement("div");
      cards.className = "ts3-cards";
      box.appendChild(cards);
    }
    if (!box.querySelector(".ts3-official")) {
      var off = document.createElement("a");
      off.className = "ts3-official";
      off.href = OFFICIAL; off.target = "_blank"; off.rel = "noopener noreferrer";
      off.textContent = "Все версии — на офсайте TeamSpeak ↗";
      box.appendChild(off);
    }
    // соцсети клана — прямо в блоке под карточками (заметно, в стиль панели)
    if (!box.querySelector(".ts3-social")) {
      socialCss();
      var soc = document.createElement("div");
      soc.className = "ts3-social";
      soc.innerHTML =
        '<div class="ts3-social-cap">✦ Наш клан на связи ✦</div>' +
        '<div class="ts3-social-row">' +
        SOCIAL.map(function (l, i) {
          return '<a class="ts3-soc" style="--sg:' + l.g + '" href="' + l.href + '"' +
            (l.ext ? ' target="_blank" rel="noopener noreferrer"' : "") +
            ' data-si="' + i + '" aria-label="' + l.label + '">' +
            '<img class="ts3-soc-ic" src="assets/social/' + l.img + '?v=1792700000" alt="">' +
            l.label + "</a>";
        }).join("") +
        "</div>";
      // наведение — показать ссылку(и) с возможностью выделить/скопировать
      soc.addEventListener("mouseover", function (e) {
        var a = e.target.closest(".ts3-soc"); if (!a) return;
        socPopShow(a, SOCIAL[+a.dataset.si]);
      });
      soc.addEventListener("mouseout", function (e) {
        var a = e.target.closest(".ts3-soc"); if (!a) return;
        socPopHide();
      });
      box.appendChild(soc);
    }
    return box;
  }

  var SOCIAL = [
    // TG/VK — через персональный вход (/queue/chat-invite): авторизация + лог под ником,
    // настоящая ссылка не показывается (без copies → нет попапа с URL).
    { img: "tg.png", g: "#3aa6e8", label: "Telegram",
      href: "/queue/chat-invite?p=tg", ext: true },
    { img: "vk-chat.png", g: "#f57a30", label: "ВКонтакте",
      href: "/queue/chat-invite?p=vk", ext: true },
    { img: "ts.png", g: "#ff6a24", label: "TeamSpeak",
      href: "ts3server://santdevil.ts3.so", ext: false,
      copies: [{ note: "адрес", cp: "santdevil.ts3.so", disp: "santdevil.ts3.so" },
               { note: "IP", cp: "46.8.53.123:7368", disp: "46.8.53.123:7368" }] }
  ];
  function socialCss() {
    if (document.getElementById("ts3-social-css")) return;
    var s = document.createElement("style");
    s.id = "ts3-social-css";
    s.textContent =
      ".ts3-social{margin-top:14px;padding-top:13px;border-top:1px solid rgba(224,162,74,.22)}" +
      ".ts3-social-cap{font:700 10px/1 system-ui,sans-serif;letter-spacing:1.5px;" +
        "text-transform:uppercase;color:#d6a860;opacity:.85;margin-bottom:10px}" +
      ".ts3-social-row{display:flex;justify-content:center;gap:10px;flex-wrap:wrap}" +
      ".ts3-soc{display:inline-flex;align-items:center;gap:7px;text-decoration:none;" +
        "padding:7px 13px 7px 9px;border-radius:10px;" +
        "background:linear-gradient(180deg,rgba(60,42,21,.85),rgba(26,16,8,.9));" +
        "border:1px solid rgba(224,162,74,.4);color:#f2dfb2;" +
        "font:700 13.5px/1 Georgia,'Times New Roman',serif;letter-spacing:.3px;" +
        "transition:transform .15s ease,box-shadow .15s ease,border-color .15s ease}" +
      ".ts3-soc:hover{transform:translateY(-2px);border-color:var(--sg);" +
        "box-shadow:0 5px 14px rgba(0,0,0,.4),0 0 12px var(--sg)}" +
      ".ts3-soc-ic{width:22px;height:22px;border-radius:6px;flex:none;" +
        "filter:drop-shadow(0 0 4px var(--sg))}" +
      // всплывашка со ссылкой(ями) при наведении — текст выделяемый, есть «Копир.»
      ".ts3-soc-pop{position:fixed;z-index:100002;transform:translate(-50%,0);" +
        "background:linear-gradient(180deg,rgba(30,20,10,.98),rgba(16,10,5,.99));" +
        "border:1px solid rgba(226,172,92,.6);border-radius:10px;padding:8px 9px;" +
        "box-shadow:0 8px 24px rgba(0,0,0,.6),0 0 12px rgba(224,170,90,.2);" +
        "opacity:0;pointer-events:none;transition:opacity .14s ease;" +
        "max-width:min(92vw,400px);display:flex;flex-direction:column;gap:7px}" +
      ".ts3-soc-pop.show{opacity:1;pointer-events:auto}" +
      ".ts3-soc-pop-row{display:flex;align-items:center;gap:8px}" +
      ".ts3-soc-pop-note{flex:none;min-width:32px;font:700 9px/1.1 system-ui,sans-serif;" +
        "letter-spacing:.5px;text-transform:uppercase;color:#d6a860}" +
      ".ts3-soc-pop-url{flex:1;font:600 12px/1.4 ui-monospace,Consolas,monospace;color:#f2dfb2;" +
        "word-break:break-all;-webkit-user-select:all;user-select:all;cursor:text}" +
      ".ts3-soc-pop-cp{flex:none;cursor:pointer;border:1px solid rgba(226,172,92,.55);" +
        "border-radius:7px;background:linear-gradient(180deg,#3a2a14,#241809);color:#f0d9a6;" +
        "font:700 10px/1 system-ui,sans-serif;padding:6px 8px;white-space:nowrap}" +
      ".ts3-soc-pop-cp:hover{filter:brightness(1.2)}" +
      ".ts3-soc-pop-cp.ok{color:#c5e8a3;border-color:#6fae5a}";
    document.head.appendChild(s);
  }

  // копирование в буфер + галочка
  function socCopy(text, btn) {
    function ok() {
      var o = btn.dataset.lbl || btn.textContent;
      btn.dataset.lbl = o; btn.textContent = "✓"; btn.classList.add("ok");
      setTimeout(function () { btn.textContent = o; btn.classList.remove("ok"); }, 1200);
    }
    function fb() {
      try {
        var ta = document.createElement("textarea");
        ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.focus(); ta.select();
        document.execCommand("copy"); ta.remove(); ok();
      } catch (e) {}
    }
    if (navigator.clipboard && navigator.clipboard.writeText)
      navigator.clipboard.writeText(text).then(ok, fb);
    else fb();
  }

  // всплывашка со ссылкой(ями) соцсети (наведение на пилюлю)
  var _socPop = null, _socPopT = null;
  function socPopEl() {
    if (_socPop) return _socPop;
    var p = document.createElement("div");
    p.className = "ts3-soc-pop";
    p.addEventListener("mouseenter", function () { clearTimeout(_socPopT); });
    p.addEventListener("mouseleave", socPopHide);
    p.addEventListener("click", function (e) {
      var b = e.target.closest(".ts3-soc-pop-cp"); if (!b) return;
      e.preventDefault(); e.stopPropagation(); socCopy(b.dataset.copy, b);
    });
    document.body.appendChild(p);
    _socPop = p; return p;
  }
  function socPopShow(a, l) {
    clearTimeout(_socPopT);
    if (!l || !l.copies) return;
    var p = socPopEl();
    p.innerHTML = l.copies.map(function (c) {
      return '<div class="ts3-soc-pop-row">' +
        (c.note ? '<span class="ts3-soc-pop-note">' + c.note + "</span>" : "") +
        '<span class="ts3-soc-pop-url">' + c.disp + "</span>" +
        '<button type="button" class="ts3-soc-pop-cp" data-copy="' + c.cp + '">Копир.</button>' +
        "</div>";
    }).join("");
    p.classList.add("show");
    var r = a.getBoundingClientRect();
    p.style.top = Math.round(r.bottom + 7) + "px";
    p.style.left = Math.round(r.left + r.width / 2) + "px";
    var pr = p.getBoundingClientRect(), half = pr.width / 2;
    var cx = Math.max(6 + half, Math.min(window.innerWidth - 6 - half, r.left + r.width / 2));
    p.style.left = Math.round(cx) + "px";
  }
  function socPopHide() {
    clearTimeout(_socPopT);
    _socPopT = setTimeout(function () { if (_socPop) _socPop.classList.remove("show"); }, 200);
  }

  function renderDesktop(cards) {
    DESKTOP.forEach(function (p) {
      var a = document.createElement("a");
      a.className = "ts3-card"; a.setAttribute("data-plat", p.key);
      a.href = API + "/ts3/download/" + p.key; a.setAttribute("download", "");
      a.appendChild(mkIcon(p.key, p.name));
      a.appendChild(mkSpan("ts3-name", p.name));
      a.appendChild(mkSpan("ts3-ver", "…"));
      cards.appendChild(a);
    });
  }

  function renderMobile(cards) {
    MOBILE.forEach(function (p) {
      var a = document.createElement("a");
      a.className = "ts3-card"; a.setAttribute("data-plat", p.key);
      a.href = p.url; a.target = "_blank"; a.rel = "noopener noreferrer";
      a.title = "Установить TeamSpeak 3 из " + p.store;
      a.appendChild(mkIcon(p.key, p.name));
      a.appendChild(mkSpan("ts3-name", p.name));
      a.appendChild(mkSpan("ts3-ver", p.store));
      cards.appendChild(a);
    });
  }

  // Перерисовывает плитки под текущий режим (телефон/ПК). Идемпотентно.
  function renderCards(box) {
    var cards = box.querySelector(".ts3-cards");
    if (!cards) return;
    var mode = isPhone() ? "phone" : "desktop";
    if (mode === curMode && cards.children.length) return;
    curMode = mode;
    cards.innerHTML = "";
    box.classList.toggle("ts3-mobile", mode === "phone");
    if (mode === "phone") {
      renderMobile(cards);
    } else {
      renderDesktop(cards);
      if (lastInfo) apply(lastInfo);
    }
  }

  function apply(d) {
    lastInfo = d;
    if (curMode === "phone") return;   // на телефоне ПК-плиток нет
    var plats = (d && d.platforms) || {};
    Object.keys(plats).forEach(function (plat) {
      var card = document.querySelector('.ts3-card[data-plat="' + plat + '"]');
      if (!card) return;
      var info = plats[plat];
      var ver = card.querySelector(".ts3-ver");
      card.href = API + "/ts3/download/" + plat;
      if (info.available) {
        card.classList.remove("ts3-disabled");
        card.removeAttribute("aria-disabled");
        ver.textContent = (info.version ? "v" + info.version : "") +
          (info.size ? " · " + fmtSize(info.size) : "");
        card.title = "Скачать TeamSpeak 3 для " + info.label +
          (info.version ? " (v" + info.version + ")" : "");
      } else {
        card.classList.add("ts3-disabled");
        card.setAttribute("aria-disabled", "true");
        ver.textContent = "готовится…";
        card.title = "Файл ещё готовится — зайди чуть позже";
      }
    });
  }

  function load() {
    var box = ensureBlock();
    if (!box) return;
    renderCards(box);
    fetch(API + "/ts3/info", { credentials: "include" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d) apply(d); })
      .catch(function () {});

    // Поворот/ресайз — перестраиваем набор плиток при смене телефон⇄ПК.
    var t;
    window.addEventListener("resize", function () {
      clearTimeout(t);
      t = setTimeout(function () { renderCards(box); }, 150);
    });
  }

  // Клик по ещё не готовой ПК-карточке — не уводим на 503.
  document.addEventListener("click", function (e) {
    var c = e.target.closest && e.target.closest(".ts3-card.ts3-disabled");
    if (c) e.preventDefault();
  });

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", load);
  else load();
})();
