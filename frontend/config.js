// Единый домен: сайт и API живут на ОДНОМ домене, API зовётся по
// ОТНОСИТЕЛЬНЫМ путям → cookie становится first-party и вход (гостевой и
// офицерский) работает во ВСЕХ браузерах — Safari, iOS, встроенные браузеры
// Telegram/VK, Firefox с ETP — без зависимости от localStorage/Bearer.
//
// КАНОНИЧЕСКИЙ домен — santdevil.com (корень, за Cloudflare). Прямой
// clan-officers-panel.fly.dev у части РФ-провайдеров блокируется (РКН режет
// *.fly.dev), поэтому всех ведём на santdevil.com — Cloudflare прячет Fly за
// собой и обходит блокировку. Тот же Fly-бэкенд отдаёт фронт и на корне, и на
// panel.santdevil.com (старый адрес — продолжает работать), и на fly.dev
// (запасной для незаблокированных) — все варианты same-origin, вход не ломается.
//
// Старые ссылки на GitHub Pages переселяем на канонический домен, чтобы
// закладки/закрепы вели на короткий рабочий адрес santdevil.com.
(function () {
  var CANON = "santdevil.com";                  // основной адрес (Cloudflare → Fly)
  var FLY = "clan-officers-panel.fly.dev";       // прямой Fly (запасной)
  var host = location.hostname;

  // Сайт, открытый с github.io, переселяем на канонический домен.
  if (host.endsWith("github.io")) {
    // github.io отдаёт сайт из /clan-officers-panel/, на Fly он в корне.
    var path = location.pathname.replace(/^\/clan-officers-panel(?:\/|$)/, "/");
    if (!path) path = "/";
    location.replace("https://" + CANON + path + location.search + location.hash);
    return; // дальше код не нужен — уходим на канонический домен.
  }

  // Хосты, с которых сайт отдаётся ТЕМ ЖЕ бэкендом → API по относительным
  // путям (same-origin): корень santdevil.com, ЛЮБОЙ его поддомен
  // (panel.santdevil.com, www.santdevil.com…), прямой Fly и локалка.
  var SAME_ORIGIN = (
    host === CANON || host.endsWith("." + CANON) ||
    host === FLY ||
    host === "localhost" || host === "127.0.0.1"
  );

  window.OFFICERS_CONFIG = {
    // same-origin → относительные пути; иной хост → канонический домен
    // (НЕ fly.dev — он может быть заблокирован).
    API_URL: SAME_ORIGIN ? "" : "https://" + CANON,
  };
})();
