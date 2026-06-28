/* TeamSpeak 3 — карточки скачивания. Тянет /ts3/info: версия, размер,
 * доступность. Файлы раздаёт наш сервер (/ts3/download/<platform>). */
(function () {
  "use strict";
  var API = (window.OFFICERS_CONFIG && window.OFFICERS_CONFIG.API_URL) || "";

  function fmtSize(b) {
    if (!b) return "";
    var mb = b / 1048576;
    return mb >= 1 ? mb.toFixed(0) + " МБ" : Math.round(b / 1024) + " КБ";
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
