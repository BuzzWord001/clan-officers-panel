// Секция «Наш клан на связи»: крупные логотипы площадок со свечением в тон,
// подписью и кликабельной ссылкой (клик по ссылке — копирует её).
// Вставляется в любой контейнер с атрибутом [data-social-links].
// Логотипы: frontend/assets/social/*.png. Ссылки — из бота @SanTDeviL_bot.
(function () {
  var LINKS = [
    { img: "tg",       name: "Telegram",  glow: "#39a3e6",
      href: "https://t.me/+6U3XCSrrZgo1YTMy",
      copy: "https://t.me/+6U3XCSrrZgo1YTMy" },
    { img: "vk-group", name: "Группа ВК",  glow: "#e0903e",
      href: "https://vk.com/club38888207",
      copy: "https://vk.com/club38888207" },
    { img: "vk-chat",  name: "Чат ВК",     glow: "#e0903e",
      href: "https://vk.me/join/rya0CI_hEnkgsCQdahj2jIb3r0wD6OHIA_E=",
      copy: "https://vk.me/join/rya0CI_hEnkgsCQdahj2jIb3r0wD6OHIA_E=" },
    { img: "ts",       name: "TeamSpeak",  glow: "#e0903e",
      href: "ts3server://melodybum.ts3.se",
      copy: "melodybum.ts3.se", proto: true },
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
      a.href = l.href;
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
      url.textContent = l.copy;
      // Полная ссылка показывается всплывающей подсказкой при наведении
      // (data-full → CSS ::after), а клик копирует её в буфер.
      url.setAttribute("data-full", l.copy);
      url.setAttribute("aria-label", "Скопировать ссылку: " + l.copy);
      url.addEventListener("click", function () { copyText(l.copy, url); });

      card.appendChild(a);
      card.appendChild(nm);
      card.appendChild(url);
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
