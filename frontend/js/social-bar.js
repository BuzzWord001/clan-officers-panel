// Секция «Наш клан на связи»: крупные логотипы площадок со свечением в тон,
// подписью и кликабельной ссылкой (клик по ссылке — копирует её).
// Вставляется в любой контейнер с атрибутом [data-social-links].
// Логотипы: frontend/assets/social/*.png. Ссылки — из бота @SanTDeviL_bot.
(function () {
  var LINKS = [
    // TG/VK чаты — через персональный вход (/queue/chat-invite): требует авторизации,
    // логирует переход под ником игрока, настоящая ссылка (t.me/vk.me) НЕ показывается.
    { img: "tg",       name: "Чат Telegram",  glow: "#39a3e6", authed: true, p: "tg" },
    // Группа ВК убрана (Лир 2026-07-25) — оставлены только чаты и TeamSpeak
    { img: "vk-chat",  name: "Чат ВК",     glow: "#e0903e", authed: true, p: "vk" },
    { img: "ts",       name: "TeamSpeak",  glow: "#e0903e",
      href: "ts3server://santdevil.ts3.so",
      copy: "santdevil.ts3.so", proto: true,
      // IP-фолбэк, если по адресу santdevil.ts3.so не подключается
      extra: [{ copy: "46.8.53.123:7368",
                note: "если не подключается по адресу — IP:" }] },
  ];

  function copyText(text, el) {
    function ok() {
      var prev = el.dataset.label || el.textContent;
      el.dataset.label = prev;
      el.classList.add("copied");
      el.textContent = "Скопировано ✓";
      setTimeout(function () {
        el.textContent = prev; el.classList.remove("copied");
      }, 1200);
    }
    function fallback() {
      try {
        var ta = document.createElement("textarea");
        ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.focus(); ta.select();
        document.execCommand("copy"); ta.remove(); ok();
      } catch (_) {}
    }
    if (navigator.clipboard && navigator.clipboard.writeText)
      navigator.clipboard.writeText(text).then(ok).catch(fallback);
    else fallback();
  }

  function build(box) {
    if (box.__socBuilt) return;
    box.__socBuilt = true;
    box.classList.add("soc2-wrap");
    var title = document.createElement("div");
    title.className = "soc2-title";
    title.textContent = "Наш клан на связи";
    var grid = document.createElement("div");
    grid.className = "soc2-grid";
    LINKS.forEach(function (l) {
      var card = document.createElement("div");
      card.className = "soc2";
      card.style.setProperty("--g", l.glow);

      var a = document.createElement("a");
      a.className = "soc2-ic";
      a.href = l.authed ? ("/queue/chat-invite?p=" + l.p) : l.href;
      if (!l.proto) a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.title = l.name;
      a.innerHTML = '<img src="assets/social/' + l.img + '.png" alt="' +
        l.name + '" width="80" height="80" loading="lazy">';

      var nm = document.createElement("div");
      nm.className = "soc2-name";
      nm.textContent = l.name;

      var url = document.createElement("button");
      url.type = "button";
      url.className = "soc2-url";
      if (l.authed) {
        // Настоящую ссылку НЕ показываем — только кнопка входа в чат (через авторизацию).
        url.textContent = "Войти в чат →";
        url.setAttribute("aria-label", "Войти в " + l.name);
        url.addEventListener("click", function () { a.click(); });
      } else {
        url.textContent = l.copy;
        url.setAttribute("data-full", l.copy);
        url.setAttribute("aria-label", "Скопировать ссылку: " + l.copy);
        url.addEventListener("click", function () { copyText(l.copy, url); });
      }

      card.appendChild(a);
      card.appendChild(nm);
      card.appendChild(url);

      // доп. строки для копирования (напр. IP-фолбэк TeamSpeak)
      if (l.extra) {
        l.extra.forEach(function (ex) {
          if (ex.note) {
            var note = document.createElement("div");
            note.className = "soc2-note";
            note.textContent = ex.note;
            note.style.cssText = "font:600 10px/1.2 system-ui,sans-serif;" +
              "color:#e0a86a;opacity:.85;margin-top:4px;text-align:center";
            card.appendChild(note);
          }
          var b2 = document.createElement("button");
          b2.type = "button";
          b2.className = "soc2-url";
          b2.textContent = ex.copy;
          b2.setAttribute("data-full", ex.copy);
          b2.setAttribute("aria-label", "Скопировать: " + ex.copy);
          b2.addEventListener("click", function () { copyText(ex.copy, b2); });
          card.appendChild(b2);
        });
      }

      grid.appendChild(card);
    });
    box.appendChild(title);
    box.appendChild(grid);
  }

  function init() {
    var nodes = document.querySelectorAll("[data-social-links]");
    for (var i = 0; i < nodes.length; i++) build(nodes[i]);
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", init);
  else init();
})();
