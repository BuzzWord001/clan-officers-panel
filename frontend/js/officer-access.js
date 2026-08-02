// Скрытие разделов сайта для ОФИЦЕРОВ по правам, заданным админом в настройках очереди.
// Админ видит всё. Права берём из /queue/officer-access-mine. Прячем ссылки на запрещённые
// разделы в навигации и, если открыта запрещённая страница, показываем заглушку.
// Это UX-слой: доступ к данным всё равно перекрыт на сервере (defense in depth).
(function () {
  var BASE = (window.OFFICERS_CONFIG && window.OFFICERS_CONFIG.API_URL) || "";
  // страница (файл) -> раздел
  var PAGE_SECTION = {
    "clan-valor.html": "valor_table",
    "valor-screens.html": "valor_screens",
    "clan-archive.html": "valor_archive",
    "chat-archive.html": "chat_archive",
    "chat-members.html": "chat_members",
    "member-restore.html": "chat_restore",
    "blacklist.html": "blacklist"
  };
  function fileOf(href) {
    if (!href) return "";
    return href.split("#")[0].split("?")[0].split("/").pop();
  }
  function sectionOf(href) { return PAGE_SECTION[fileOf(href)] || null; }
  function headers() {
    var h = {};
    try {
      var dv = localStorage.getItem("queue_device_token"); if (dv) h["X-Queue-Device"] = dv;
      var ot = localStorage.getItem("officer_session_token"); if (ot) h["Authorization"] = "Bearer " + ot;
    } catch (e) {}
    return h;
  }
  function apply(d) {
    if (!d || d.role === "admin") return;                 // админ — всё видно
    var access = d.access || {};
    function allowed(sec) { return !sec || access[sec] !== false; }
    // 1) прячем ссылки на запрещённые разделы (в т.ч. группы вкладок, если пустеют)
    [].forEach.call(document.querySelectorAll("a[href]"), function (a) {
      var sec = sectionOf(a.getAttribute("href"));
      if (sec && !allowed(sec)) a.style.display = "none";
    });
    // прячем группы вкладок, где не осталось видимых ссылок
    [].forEach.call(document.querySelectorAll(".tabs-group"), function (g) {
      var links = g.querySelectorAll(".tabs-group-links a");
      var vis = 0;
      [].forEach.call(links, function (a) { if (a.style.display !== "none") vis++; });
      if (links.length && vis === 0) g.style.display = "none";
    });
    // 2) если ТЕКУЩАЯ страница запрещена офицеру — заглушка
    var cur = fileOf(location.pathname) || "index.html";
    var curSec = PAGE_SECTION[cur];
    if (curSec && !allowed(curSec)) {
      document.body.innerHTML =
        '<div style="max-width:520px;margin:80px auto;padding:26px;text-align:center;' +
        'font-family:system-ui,Segoe UI,sans-serif;color:#caa66a;background:#1a1108;' +
        'border:1px solid #6a4a1a;border-radius:14px">' +
        '<div style="font-size:44px;margin-bottom:8px">🔒</div>' +
        '<h2 style="color:#f0dcb4;margin:0 0 8px">Раздел недоступен</h2>' +
        '<p style="line-height:1.5">Этот раздел отключён для офицеров администратором клана.</p>' +
        '<a href="index.html" style="color:#ffd27a;font-weight:700">← На главную</a></div>';
    }
  }
  function run() {
    fetch(BASE + "/queue/officer-access-mine", { credentials: "include", headers: headers() })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(apply)
      .catch(function () {});
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run);
  else run();
})();
