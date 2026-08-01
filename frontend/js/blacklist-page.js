/* Страница «Чёрный список клана» (blacklist.html). Офицер/админ: просмотр, добавление,
   удаление, поиск. Использует API.blacklistList/Add/Remove. */
(function () {
  "use strict";
  var API_URL = (window.OFFICERS_CONFIG && window.OFFICERS_CONFIG.API_URL) || "";
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  var _all = [];

  function fmtDate(iso) {
    if (!iso) return "";
    var d = String(iso).slice(0, 10);
    try { return (window.DateRu ? DateRu.fmtRus(d) : d.split("-").reverse().join(".")); }
    catch (e) { return d.split("-").reverse().join("."); }
  }

  function render(list) {
    var box = $("bl-list"); if (!box) return;
    var cnt = $("bl-count"); if (cnt) cnt.textContent = _all.length ? "· " + _all.length + " чел." : "";
    var emp = $("bl-empty"); if (emp) emp.hidden = _all.length > 0;
    box.innerHTML = list.map(function (r, i) {
      var reason = (r.reason || "").trim();
      var meta = [];
      if ((r.added_by || "").trim()) meta.push("внёс: " + esc(r.added_by.trim()));
      if (r.added_at) meta.push("📅 " + esc(fmtDate(r.added_at)));
      return '<div class="bl-card">' +
        '<div class="bl-num">' + (i + 1) + "</div>" +
        '<div class="bl-body">' +
          '<div class="bl-nick2">⛔ ' + esc(r.nick || r.canon) + "</div>" +
          '<div class="bl-reason2' + (reason ? "" : " none") + '">' +
            (reason ? esc(reason) : "причина не указана") + "</div>" +
          (meta.length ? '<div class="bl-meta">👤 ' + meta.join(" · ") + "</div>" : "") +
        "</div>" +
        '<button class="bl-del2" data-nick="' + esc(r.nick || r.canon) + '">убрать из ЧС</button>' +
        "</div>";
    }).join("");
    box.querySelectorAll(".bl-del2").forEach(function (b) {
      b.addEventListener("click", function () {
        if (!confirm("Убрать «" + b.dataset.nick + "» из чёрного списка?")) return;
        API.blacklistRemove(b.dataset.nick).then(load).catch(function (e) {
          alert("Ошибка: " + (e.detail || e.message));
        });
      });
    });
  }

  function applySearch() {
    var q = (($("bl-search") || {}).value || "").trim().toLowerCase();
    if (!q) { render(_all); return; }
    render(_all.filter(function (r) {
      return ((r.nick || "") + " " + (r.reason || "") + " " + (r.added_by || ""))
        .toLowerCase().indexOf(q) >= 0;
    }));
  }

  function load() {
    return API.blacklistList().then(function (d) {
      _all = (d && d.items) || [];
      applySearch();
    }).catch(function (e) {
      var st = $("bl-status");
      if (st) { st.textContent = "Не удалось загрузить (нужны права офицера)."; st.style.color = "#ff8a7a"; }
    });
  }

  function add() {
    var nick = ($("bl-nick").value || "").trim();
    var reason = ($("bl-reason").value || "").trim();
    var st = $("bl-status");
    if (!nick) { if (st) { st.textContent = "Введи ник."; st.style.color = "#ff8a7a"; } return; }
    API.blacklistAdd(nick, reason).then(function () {
      $("bl-nick").value = ""; $("bl-reason").value = "";
      if (st) { st.textContent = "✓ Внесён в ЧС: " + nick; st.style.color = "#9fe0a0"; }
      load();
    }).catch(function (e) {
      if (st) { st.textContent = "Ошибка: " + (e.detail || e.message); st.style.color = "#ff8a7a"; }
    });
  }

  function init() {
    // Кто вошёл (для шапки who). Не офицер/админ → на вход.
    fetch(API_URL + "/auth/me", { credentials: "include" })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
      .then(function (me) {
        document.body.setAttribute("data-role", me.role || "");
        if (me.role !== "officer" && me.role !== "admin") { location.href = "login.html"; return; }
        var who = $("who");
        if (who) who.textContent = (me.role === "admin" ? "АДМИНИСТРАТОР" : "ОФИЦЕР") + " · " + (me.name || "");
        load();
      })
      .catch(function () { location.href = "login.html"; });

    if ($("bl-add")) $("bl-add").addEventListener("click", add);
    ["bl-nick", "bl-reason"].forEach(function (id) {
      var el = $(id);
      if (el) el.addEventListener("keydown", function (e) { if (e.key === "Enter") add(); });
    });
    if ($("bl-search")) $("bl-search").addEventListener("input", applySearch);
    var lo = $("logout-btn");
    if (lo) lo.addEventListener("click", function () {
      fetch(API_URL + "/auth/logout", { method: "POST", credentials: "include" })
        .then(function () { location.href = "login.html"; });
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
