// Единый домен: когда сайт открыт с Fly (clan-officers-panel.fly.dev),
// API зовётся по ОТНОСИТЕЛЬНЫМ путям → cookie становится first-party и
// вход (гостевой и офицерский) работает во ВСЕХ браузерах — Safari, iOS,
// встроенные браузеры Telegram/VK, Firefox с ETP — без зависимости от
// localStorage/Bearer.
//
// Старые ссылки на GitHub Pages (buzzword001.github.io/clan-officers-panel/…)
// автоматически переселяем на Fly, чтобы все, у кого закреп или закладка на
// github.io, попадали на рабочий single-origin домен.
(function () {
  var FLY = "clan-officers-panel.fly.dev";
  var host = location.hostname;

  if (host.endsWith("github.io")) {
    // github.io отдаёт сайт из /clan-officers-panel/, на Fly он в корне.
    var path = location.pathname.replace(/^\/clan-officers-panel(?:\/|$)/, "/");
    if (!path) path = "/";
    location.replace("https://" + FLY + path + location.search + location.hash);
    return; // дальше код не нужен — уходим на Fly.
  }

  window.OFFICERS_CONFIG = {
    // На самом Fly и при локальной разработке — относительные пути (same-origin).
    // На любом ином хосте — абсолютный URL бэкенда (fallback).
    API_URL: (host === FLY || host === "localhost" || host === "127.0.0.1")
      ? ""
      : "https://" + FLY,
  };
})();
