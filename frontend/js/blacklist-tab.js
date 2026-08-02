/* Вкладка «🚫 Чёрный список» — self-inject в группу «приём» навбара .tabs на ЛЮБОЙ
 * странице офицерской панели, чтобы вход в ЧС был виден отовсюду (как История/Приём).
 * Видна ТОЛЬКО офицеру и админу (проверка роли через /auth/me). */
(function () {
  "use strict";
  var API_URL = (window.OFFICERS_CONFIG && window.OFFICERS_CONFIG.API_URL) || "";

  function inject() {
    var tabs = document.querySelector("#tabs") || document.querySelector(".tabs");
    if (!tabs) return;
    // Уже есть вкладка ЧС (статично в разметке blacklist.html или добавлена ранее) —
    // не дублируем. Проверяем по href, а не по id (статичная не имеет id).
    if (tabs.querySelector('a[href="blacklist.html"]')) return;
    // группа «приём» — первая tabs-group (или ищем по ссылке на index.html)
    var group = null, groups = tabs.querySelectorAll(".tabs-group");
    for (var i = 0; i < groups.length; i++) {
      if (groups[i].querySelector('a[href="index.html"]')) { group = groups[i]; break; }
    }
    var links = group && group.querySelector(".tabs-group-links");
    if (!links) return;
    var onBl = /blacklist\.html$/i.test(location.pathname);
    var a = document.createElement("a");
    a.id = "bl-tab-link";
    a.href = "blacklist.html";
    a.textContent = "🚫 Чёрный список";
    if (onBl) a.className = "active";
    links.appendChild(a);
  }

  // показываем вкладку только офицеру/админу
  fetch(API_URL + "/auth/me", { credentials: "include" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (me) {
      if (me && (me.role === "officer" || me.role === "admin")) {
        if (document.readyState === "loading")
          document.addEventListener("DOMContentLoaded", inject);
        else inject();
      }
    })
    .catch(function () {});
})();
