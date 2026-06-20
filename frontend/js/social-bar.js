// Ряд ссылок на площадки клана в шапке (после входа) — единый код для всех
// страниц с .topbar. Иконки фирменные (inline SVG), при наведении подпись
// показывает tooltips.js (title→tooltip). Ссылки совпадают с экраном входа
// и берутся из бота @SanTDeviL_bot.
(function () {
  var VK =
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<path d="M21.547 7.293c.14-.477 0-.828-.681-.828h-2.252c-.573 0-.836.302-.98.635 0 0-1.145 2.786-2.766 4.594-.524.525-.763.692-1.049.692-.143 0-.35-.167-.35-.643V7.293c0-.572-.166-.828-.643-.828H9.79c-.357 0-.572.266-.572.519 0 .542.81.667.893 2.19v3.309c0 .725-.13.858-.417.858-.763 0-2.618-2.798-3.718-6.001-.215-.622-.43-.873-1.006-.873H2.717c-.643 0-.772.302-.772.635 0 .596.762 3.55 3.551 7.458 1.859 2.67 4.479 4.115 6.863 4.115 1.43 0 1.607-.32 1.607-.874v-2.02c0-.643.136-.772.59-.772.334 0 .906.167 2.24 1.455 1.526 1.525 1.777 2.209 2.634 2.209h2.252c.643 0 .961-.32.777-.95-.202-.629-.93-1.543-1.897-2.626-.525-.62-1.31-1.287-1.55-1.621-.333-.43-.238-.62 0-1.002 0 0 2.745-3.86 3.03-5.169z"/></svg>';
  var VKCHAT =
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<path d="M12 2C6.477 2 2 5.94 2 10.8c0 2.49 1.18 4.73 3.07 6.32-.13 1.4-.6 2.92-1.32 4.02-.16.24.04.56.32.5 1.94-.42 3.6-1.18 4.86-2.04.66.13 1.36.2 2.07.2 5.523 0 10-3.94 10-8.8S17.523 2 12 2zm-4 8.05a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5zm4 0a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5zm4 0a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5z"/></svg>';
  var TG =
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.5 1.201-.82 1.23-.697.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.259-1.91.176-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212-.07-.062-.174-.041-.249-.024-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>';
  var TS =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M4 14v-3a8 8 0 0 1 16 0v3"/>' +
    '<path d="M5 12H4a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h1a1 1 0 0 0 1-1v-6a1 1 0 0 0-1-1z" fill="currentColor"/>' +
    '<path d="M19 12h1a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-1a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z" fill="currentColor"/>' +
    '<path d="M18 18a4 4 0 0 1-4 3h-2"/></svg>';

  var LINKS = [
    { brand: "#0077ff", href: "https://vk.com/club38888207",
      title: "Группа клана ВКонтакте", svg: VK },
    { brand: "#0077ff", href: "https://vk.me/join/rya0CI_hEnkgsCQdahj2jIb3r0wD6OHIA_E=",
      title: "Беседа клана ВКонтакте", svg: VKCHAT },
    { brand: "#29a9eb", href: "https://t.me/+6U3XCSrrZgo1YTMy",
      title: "Telegram клана", svg: TG },
    { brand: "#2580c3", href: "ts3server://melodybum.ts3.se",
      title: "TeamSpeak: melodybum.ts3.se (клик — подключиться)", svg: TS, proto: true },
  ];

  function build() {
    var bar = document.querySelector(".topbar");
    if (!bar || bar.querySelector(".topbar-social")) return;
    var nav = document.createElement("nav");
    nav.className = "topbar-social";
    nav.setAttribute("aria-label", "Площадки клана");
    LINKS.forEach(function (l) {
      var a = document.createElement("a");
      a.className = "tsoc";
      a.style.setProperty("--brand", l.brand);
      a.href = l.href;
      a.rel = "noopener noreferrer";
      a.title = l.title;
      if (!l.proto) a.target = "_blank";   // ts3server:// — протокол-хендлер
      a.innerHTML = l.svg;
      nav.appendChild(a);
    });
    var ub = bar.querySelector(".user-bar");
    if (ub) bar.insertBefore(nav, ub);
    else bar.appendChild(nav);
  }

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", build);
  else build();
})();
