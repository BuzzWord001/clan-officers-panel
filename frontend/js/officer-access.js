// Видимость разделов сайта для ОФИЦЕРОВ по правам, заданным админом («Права офицеров»).
// Админ видит всё. Права — из /queue/officer-access-mine. Логика:
//  • разрешённый раздел → показать ссылку в навигации (даже если группа помечена admin-only);
//  • запрещённый → скрыть ссылку; при заходе на запрещённую страницу — заглушка.
// Доступ к данным всё равно перекрыт на сервере (defense in depth).
(function () {
  var BASE = (window.OFFICERS_CONFIG && window.OFFICERS_CONFIG.API_URL) || "";
  // файл страницы/ссылки -> раздел
  var FILE_SECTION = {
    "chat-archive.html": "chat_archive",
    "chat-members.html": "chat_members",
    "member-restore.html": "chat_restore",
    "clan-valor.html": "valor_table",
    "valor-screens.html": "valor_screens",
    "clan-archive.html": "valor_archive",
    "blacklist.html": "blacklist"
    // index.html/audit.html (приём) — домашние, в page-гейт не включаем
  };
  function fileOf(href) { if (!href) return ""; return href.split("#")[0].split("?")[0].split("/").pop(); }
  function sectionOf(href) { return FILE_SECTION[fileOf(href)] || null; }
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
    function ok(sec) { return access[sec] !== false; }    // сервер шлёт явные значения; нет ключа => разрешено
    // 1) НАВ-ССЫЛКИ: разрешённые показываем (снимаем admin-only), запрещённые прячем
    var revealGroups = [];
    [].forEach.call(document.querySelectorAll("a[href]"), function (a) {
      var sec = sectionOf(a.getAttribute("href"));
      if (!sec) return;
      if (ok(sec)) {
        a.classList.remove("admin-only");
        a.style.removeProperty("display");
        a.removeAttribute("hidden");
        var g = a.closest(".tabs-group");
        if (g && g.classList.contains("admin-only") && revealGroups.indexOf(g) < 0) revealGroups.push(g);
      } else {
        a.style.setProperty("display", "none", "important");
      }
    });
    // раскрываем admin-only группы с разрешённой ссылкой; внутри прячем запрещённые/непривязанные
    revealGroups.forEach(function (g) {
      g.classList.remove("admin-only");
      var prev = g.previousElementSibling;
      if (prev && prev.classList && prev.classList.contains("tabs-sep")) prev.classList.remove("admin-only");
      [].forEach.call(g.querySelectorAll("a[href]"), function (a) {
        var sec = sectionOf(a.getAttribute("href"));
        if (!sec || !ok(sec)) a.style.setProperty("display", "none", "important");
      });
      var vis = 0;
      [].forEach.call(g.querySelectorAll("a[href]"), function (a) { if (a.style.display !== "none") vis++; });
      if (vis === 0) g.style.setProperty("display", "none", "important");
    });
    // 2) заглушка на запрещённой странице
    var cur = fileOf(location.pathname) || "index.html";
    var curSec = FILE_SECTION[cur];
    if (curSec && !ok(curSec)) {
      document.body.innerHTML =
        '<div style="max-width:520px;margin:80px auto;padding:26px;text-align:center;' +
        'font-family:system-ui,Segoe UI,sans-serif;color:#caa66a;background:#1a1108;' +
        'border:1px solid #6a4a1a;border-radius:14px">' +
        '<div style="font-size:44px;margin-bottom:8px">🔒</div>' +
        '<h2 style="color:#f0dcb4;margin:0 0 8px">Раздел недоступен</h2>' +
        '<p style="line-height:1.5">Этот раздел не открыт для офицеров администратором клана.</p>' +
        '<a href="index.html" style="color:#ffd27a;font-weight:700">← На главную</a></div>';
    }
  }
  function currentView() {                              // «Смотреть как» (view-as.js) — sessionStorage
    try { return sessionStorage.getItem("santdevil_view_as") || ""; } catch (e) { return ""; }
  }
  function fetchJson(path) {
    return fetch(BASE + path, { credentials: "include", headers: headers() })
      .then(function (r) { return r.ok ? r.json() : null; });
  }
  function run() {
    var view = currentView();
    fetchJson("/queue/officer-access-mine").then(function (d) {
      if (!d) return;
      if (d.role !== "admin") { apply(d); return; }     // настоящий офицер — его карта
      // Настоящий АДМИН смотрит «как офицер» → применяем СОХРАНЁННУЮ карту офицеров
      // (иначе превью показывало бы всё как админу и не скрывало/не открывало разделы).
      if (view === "officer") {
        fetchJson("/queue/admin/officer-access").then(function (a) {
          if (a) apply({ role: "officer", access: a.access });
        }).catch(function () {});
      }
      // прочее (реальный админ / превью участник-гость) — навигацию не трогаем (CSS по роли)
    }).catch(function () {});
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run);
  else run();
})();
