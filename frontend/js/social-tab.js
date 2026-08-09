/* Группа «на связи» в ряду вкладок: дублирует 3 соц-ссылки (Чат Telegram,
 * Чат ВК, TeamSpeak) в общем навбаре .tabs — нативно, в стиль остальных вкладок,
 * повышает заметность соцсетей. Self-inject, добавляется ПОСЛЕДНЕЙ (в конце ряда).
 * Группа ВК тут намеренно отсутствует (Лир 2026-07-25). */
(function () {
  "use strict";
  var LINKS = [
    // TG/VK — через персональный вход (авторизация + лог под ником, ссылка скрыта)
    { img: "tg.png", label: "Telegram",
      href: "/queue/chat-invite?p=tg", ext: true },
    { img: "vk-chat.png", label: "ВКонтакте",
      href: "/queue/chat-invite?p=vk", ext: true },
    { img: "ts.png", label: "TeamSpeak",
      href: "ts3server://santdevil.ts3.so", ext: false }
  ];

  function css() {
    if (document.getElementById("soc-tab-css")) return;
    var s = document.createElement("style");
    s.id = "soc-tab-css";
    s.textContent =
      "#social-tab-group .tabs-group-links{gap:16px}" +
      ".soc-tab{display:inline-flex;align-items:center;gap:6px;letter-spacing:1px}" +
      ".soc-tab-ic{width:17px;height:17px;border-radius:5px;flex:none;" +
        "filter:drop-shadow(0 0 3px rgba(224,162,74,.45))}" +
      ".soc-tab:hover{color:var(--accent);text-shadow:0 0 6px var(--accent)}" +
      ".soc-tab:hover .soc-tab-ic{filter:drop-shadow(0 0 6px var(--accent))}";
    document.head.appendChild(s);
  }

  function inject() {
    var tabs = document.querySelector("#tabs") || document.querySelector(".tabs");
    if (!tabs || document.getElementById("social-tab-group")) return;
    css();
    var sep = document.createElement("div");
    sep.className = "tabs-sep";
    sep.setAttribute("aria-hidden", "true");
    var group = document.createElement("div");
    group.className = "tabs-group";
    group.id = "social-tab-group";
    group.innerHTML =
      '<span class="tabs-group-label">на связи</span>' +
      '<div class="tabs-group-links">' +
      LINKS.map(function (l) {
        return '<a class="soc-tab" href="' + l.href + '"' +
          (l.ext ? ' target="_blank" rel="noopener noreferrer"' : "") + ">" +
          '<img class="soc-tab-ic" src="assets/social/' + l.img + '?v=1792700000" alt="">' +
          l.label + "</a>";
      }).join("") +
      "</div>";
    tabs.appendChild(sep);
    tabs.appendChild(group);
  }

  // откладываем вставку на макрозадачу — чтобы сработать ПОСЛЕ других инжекторов
  // вкладок (queue-tab КХ, chamber-door тайная) при любом порядке скриптов → в конце ряда.
  function schedule() { setTimeout(inject, 0); }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", schedule);
  else schedule();
})();
