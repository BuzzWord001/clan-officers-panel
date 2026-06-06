/* ─────────────────────────────────────────────────────────────────────
   tooltips.js — единые красивые подсказки при наведении на ВСЕ кнопки и
   элементы с пояснением, по всему сайту.

   Как работает:
   - Любой элемент с атрибутом title или data-tip при наведении показывает
     стильное всплывающее окно (matrix-стиль), вместо уродливой нативной
     подсказки браузера.
   - Нативный title при первом наведении переносится в data-tip и убирается,
     поэтому браузер свою серую подсказку не показывает.
   - Подсказки появляются только у тех кнопок, что есть у текущей роли
     (админские кнопки рендерятся только админу — значит и подсказки к ним
     видит только админ).
   ───────────────────────────────────────────────────────────────────── */
(function () {
  "use strict";
  let TIP = null, CUR = null;

  function injectCss() {
    if (document.getElementById("ui-tip-css")) return;
    const s = document.createElement("style");
    s.id = "ui-tip-css";
    s.textContent = `
      .ui-tip{position:fixed;z-index:10050;max-width:320px;
        background:#0a0f0a;border:1px solid #2a6;border-radius:8px;
        padding:8px 11px;color:#dff;font-size:12.5px;line-height:1.5;
        white-space:pre-line;box-shadow:0 6px 22px rgba(0,0,0,.55),
        0 0 14px rgba(40,255,80,.14);pointer-events:none;
        opacity:0;transition:opacity .1s ease}
      .ui-tip.on{opacity:1}
      .ui-tip b,.ui-tip strong{color:#7CFC00}`;
    document.head.appendChild(s);
  }

  function ensure() {
    if (TIP) return TIP;
    injectCss();
    TIP = document.createElement("div");
    TIP.className = "ui-tip";
    TIP.hidden = true;
    document.body.appendChild(TIP);
    return TIP;
  }

  // Текст подсказки: data-tip в приоритете; иначе переносим title в data-tip
  // и убираем title (чтобы не было нативной серой подсказки).
  function tipText(el) {
    let t = el.getAttribute("data-tip");
    if (!t) {
      const ti = el.getAttribute("title");
      if (ti && ti.trim()) {
        el.setAttribute("data-tip", ti);
        el.removeAttribute("title");
        t = ti;
      }
    }
    return t && t.trim() ? t : "";
  }

  function place(tip, el) {
    const r = el.getBoundingClientRect();
    const pw = tip.offsetWidth, ph = tip.offsetHeight, m = 8;
    let left = r.left + r.width / 2 - pw / 2;
    let top = r.bottom + 8;
    if (left + pw > window.innerWidth - m) left = window.innerWidth - pw - m;
    if (left < m) left = m;
    if (top + ph > window.innerHeight - m && r.top - ph - 8 > m)
      top = r.top - ph - 8;             // не влезает снизу — показать сверху
    tip.style.left = Math.round(left) + "px";
    tip.style.top = Math.round(top) + "px";
  }

  function show(el) {
    const t = tipText(el);
    if (!t) return;
    const tip = ensure();
    tip.textContent = t;
    tip.hidden = false;
    place(tip, el);
    // двойной rAF недоступен на всех — просто класс для плавного появления
    requestAnimationFrame(() => tip.classList.add("on"));
    CUR = el;
  }

  function hide() {
    if (TIP) { TIP.classList.remove("on"); TIP.hidden = true; }
    CUR = null;
  }

  // Делегирование: works для динамически добавленных кнопок (перерисовка строк).
  document.addEventListener("mouseover", function (e) {
    const el = e.target.closest("[title],[data-tip]");
    if (!el || el === CUR) return;
    // Не подсвечиваем сам тултип-контейнер.
    if (el.classList && el.classList.contains("ui-tip")) return;
    show(el);
  });
  document.addEventListener("mouseout", function (e) {
    if (!CUR) return;
    const el = e.target.closest("[title],[data-tip]");
    if (el === CUR && (!e.relatedTarget || !el.contains(e.relatedTarget))) hide();
  });
  document.addEventListener("focusin", function (e) {
    const el = e.target.closest && e.target.closest("[title],[data-tip]");
    if (el) show(el);
  });
  document.addEventListener("focusout", hide);
  window.addEventListener("scroll", hide, true);
  window.addEventListener("resize", hide);
  document.addEventListener("click", hide);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") hide();
  });
})();
