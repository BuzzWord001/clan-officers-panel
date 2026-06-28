/* TeamSpeak 3 — карточки скачивания. Блок ЕДИНЫЙ для всех страниц: если его
 * нет в разметке (другие вкладки) — создаём и вставляем первым в <main>, перед
 * вкладками. Тянем /ts3/info: версия, размер, доступность. Файлы раздаёт наш
 * сервер (/ts3/download/<platform>). Публично — виден гостю/офицеру/админу. */
(function () {
  "use strict";
  var API = (window.OFFICERS_CONFIG && window.OFFICERS_CONFIG.API_URL) || "";

  var PLATS = [
    { key: "windows", name: "Windows" },
    { key: "macos",   name: "macOS" },
    { key: "linux",   name: "Linux" }
  ];
  var OFFICIAL = "https://teamspeak.com/en/downloads/?product=ts3#ts3client";

  function fmtSize(b) {
    if (!b) return "";
    var mb = b / 1048576;
    return mb >= 1 ? mb.toFixed(0) + " МБ" : Math.round(b / 1024) + " КБ";
  }

  // Создаёт блок, если его ещё нет на странице. Возвращает элемент или null.
  function ensureBlock() {
    var existing = document.getElementById("ts3-dl");
    if (existing) return existing;
    var main = document.querySelector("main");
    if (!main) return null;

    var box = document.createElement("div");
    box.className = "ts3-dl";
    box.id = "ts3-dl";

    var title = document.createElement("div");
    title.className = "ts3-dl-title";
    title.textContent = "TeamSpeak 3 — скачать клиент";
    box.appendChild(title);

    var cards = document.createElement("div");
    cards.className = "ts3-cards";
    PLATS.forEach(function (p) {
      var a = document.createElement("a");
      a.className = "ts3-card";
      a.setAttribute("data-plat", p.key);
      a.href = API + "/ts3/download/" + p.key;
      a.setAttribute("download", "");
      var img = document.createElement("img");
      img.className = "ts3-ic";
      img.src = "assets/ts3/" + p.key + ".png?v=1796500000";
      img.alt = p.name; img.loading = "lazy";
      var nm = document.createElement("span");
      nm.className = "ts3-name"; nm.textContent = p.name;
      var ver = document.createElement("span");
      ver.className = "ts3-ver"; ver.textContent = "…";
      a.appendChild(img); a.appendChild(nm); a.appendChild(ver);
      cards.appendChild(a);
    });
    box.appendChild(cards);

    var off = document.createElement("a");
    off.className = "ts3-official";
    off.href = OFFICIAL; off.target = "_blank"; off.rel = "noopener noreferrer";
    off.textContent = "Все версии — на офсайте TeamSpeak ↗";
    box.appendChild(off);

    var tabs = main.querySelector(".tabs");
    main.insertBefore(box, tabs || main.firstChild);
    return box;
  }

  function apply(d) {
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
    if (!ensureBlock()) return;
    fetch(API + "/ts3/info", { credentials: "include" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d) apply(d); })
      .catch(function () {});
  }

  // Клик по ещё не готовой карточке — не уводим на 503.
  document.addEventListener("click", function (e) {
    var c = e.target.closest && e.target.closest(".ts3-card.ts3-disabled");
    if (c) e.preventDefault();
  });

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", load);
  else load();
})();
