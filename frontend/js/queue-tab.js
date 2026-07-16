/* Вкладка «Очередь за ресурсами с КХ» — self-inject в общий навбар .tabs
 * на ЛЮБОЙ странице офицерской панели (реестр, история, чаты, доблесть…),
 * чтобы вход в раздел был виден отовсюду, а не только со страницы Доблести. */
(function () {
  "use strict";
  function inject() {
    var tabs = document.querySelector("#tabs") || document.querySelector(".tabs");
    if (!tabs || document.getElementById("queue-tab-group")) return;
    var onQueue = /queue\.html$/i.test(location.pathname);

    var sep = document.createElement("div");
    sep.className = "tabs-sep";
    sep.setAttribute("aria-hidden", "true");

    var group = document.createElement("div");
    group.className = "tabs-group";
    group.id = "queue-tab-group";
    group.innerHTML =
      '<span class="tabs-group-label">КХ</span>' +
      '<div class="tabs-group-links">' +
        '<a href="queue.html" class="q-tab-link' + (onQueue ? " active" : "") + '">' +
        '🏰 Очередь за ресурсами</a></div>';

    tabs.appendChild(sep);
    tabs.appendChild(group);
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", inject);
  else inject();
})();
