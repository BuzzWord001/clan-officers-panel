/* ─────────────────────────────────────────────────────────────────────
   help-tips.js — единый компонент подсказок для колонок таблиц.

   Что делает:
   1. Рядом с заголовком каждой описанной колонки добавляет кликабельный
      значок «?». По клику всплывает поповер: что это за показатель, как
      считается / откуда берётся, и как заполняется (авто/вручную/расчёт).
   2. Под таблицей добавляет сворачиваемую сноску «Как заполняется таблица»
      со списком всех колонок и пометкой источника данных.

   Подключение: добавить data-help="<ключ>" на <table>. Заголовки в <thead>
   сопоставляются по видимому тексту (без подписи <small>).
   ───────────────────────────────────────────────────────────────────── */
(function () {
  "use strict";

  // Типы источника данных — бейдж + пояснение.
  const FILL = {
    auto:   { label: "Автосбор",      cls: "hf-auto",
              tip: "Собирается автоматически — вмешательство не нужно" },
    manual: { label: "Вручную",       cls: "hf-manual",
              tip: "Заполняет офицер вручную" },
    calc:   { label: "Расчёт",        cls: "hf-calc",
              tip: "Вычисляется по формуле из других данных" },
    mixed:  { label: "Авто + вручную", cls: "hf-mixed",
              tip: "Часть подставляется автоматически, часть — вручную" },
  };

  // ── Словари подсказок по таблицам ──
  // Ключ = РОВНО видимый основной заголовок колонки (без <small>-подписи).
  const DICT = {
    // Реестр приёма (index.html)
    "acceptances": {
      "Ник":        { fill: "manual", what: "Игровой ник игрока, принятого в клан.",
                      how: "Вводит офицер при оформлении приёма." },
      "Титул":      { fill: "manual", what: "Титул или звание, присвоенное при приёме.",
                      how: "Указывает офицер вручную." },
      "Принят":     { fill: "manual", what: "Дата, когда игрок принят в клан.",
                      how: "Ставит офицер при добавлении записи." },
      "Иммунитет":  { fill: "calc",   what: "Период новичка, пока норматив доблести с него не спрашивается.",
                      how: "Считается автоматически: +7 дней от даты приёма." },
      "Примечание": { fill: "manual", what: "Произвольная заметка офицера о приёме.",
                      how: "Заполняется вручную, по желанию." },
      "Добавил":    { fill: "auto",   what: "Офицер, создавший запись.",
                      how: "Подставляется автоматически по тому, кто залогинен." },
    },

    // Доблесть (clan-valor.html) — основная таблица
    "valor": {
      "Ник": { fill: "auto", what: "Игровой ник участника в Perfect World.",
               how: "Распознаётся с экрана списка гильдии (ИИ-зрение) и сверяется с эталонным списком ников клана." },
      "Имя или Ник мэйн аккаунта": { fill: "manual",
               what: "Реальное имя игрока или ник его основного персонажа.",
               how: "Сопоставляется вручную — помогает понять, кто есть кто, и связать твинков с основой." },
      "Данные VK / Telegram": { fill: "auto",
               what: "Привязанные соцсети участника.",
               how: "Подтягиваются автоматически из бота регистрации клана." },
      "Должность": { fill: "auto", what: "Текущая должность в гильдии.",
               how: "Считывается с экрана списка гильдии PW." },
      "Титул":     { fill: "mixed", what: "Игровой титул персонажа. Однозначное число 1–9 — это предупреждения, выставленные офицером в игре (показываются красным значком ⚠).",
               how: "Текст титула считывается с экрана PW автоматически. Числовой титул проставляет офицер вручную в игре как счётчик предупреждений (кик обычно после 2-го). Многозначные числа — это даты, не предупреждения." },
      "Ур.":       { fill: "auto", what: "Уровень персонажа.",
               how: "Считывается с экрана PW." },
      "Класс":     { fill: "auto", what: "Класс персонажа.",
               how: "Считывается с экрана PW." },
      "Доблесть":  { fill: "auto", what: "Сколько доблести (валора) набрано за текущую неделю.",
               how: "Число считывается с экрана PW. Клик по ячейке открывает историю по неделям." },
      "Норматив":  { fill: "calc", what: "Выполнение недельного норматива доблести.",
               how: "Доблесть за неделю ÷ норматив недели, в процентах. Учитывает иммунитет новичка и статус АФК (тогда норматив не спрашивается). Также показывает накопленные предупреждения." },
      "Оценка":    { fill: "calc", what: "Средняя дисциплина участника за всё время.",
               how: "Среднее значение % выполнения норматива по всем неделям, что человек состоит в клане." },
      "Предупреждения": { fill: "mixed",
               what: "Все активные предупреждения в едином стиле «Предупреждение ⚠ N». ЦВЕТ = суровость: 🟢 зелёный лёгкое, 🟡 жёлтый среднее, 🔴 красный суровое (по % набранной нормы). 🟣 Фиолетовый — строгое предупреждение из титула (отметка офицера в игре). Ручное помечено значком ✎, цвет — по выбранной суровости. Тот же чип в колонках «Норматив» и «Титул».",
               how: "Наведи на чип — во всплывающем окошке короткое пояснение. Норматив-предупреждение снимается при выполнении нормы (первым — самое суровое). Ручное добавляется кнопкой «+» (выбираешь суровость), снимается «✕». Титул снимается офицером в игре." },
      "Тренд":     { fill: "calc", what: "Изменение относительно прошлой недели.",
               how: "Разница % выполнения норматива (или доблести) между этой и прошлой неделей." },
      "Метки":     { fill: "mixed", what: "Особые признаки: ветеран, офицер, в соцсетях и др.",
               how: "«Офицер» и «В соцсетях» ставятся автоматически. «Ветеран» и прочие метки добавляет офицер вручную." },
      "Ценность": { fill: "calc", title: "Ценность для клана",
               what: "Общая полезность участника для клана, шкала 0–100.",
               how: "Взвешенная сумма факторов: доблесть — 60, ветеран — 16, офицер — 14 (высший пост за всё время + текущая должность), соцсети — 5, активность в чатах — 5. У новичков под иммунитетом доблесть из оценки исключается, а итог нормализуется к 100." },
    },

    // Участники чатов (chat-members.html)
    "chat-members": {
      "Участник":   { fill: "auto", what: "Человек, писавший в клановых чатах.",
                      how: "Берётся из архива переписки (Telegram + VK)." },
      "Всего":      { fill: "auto", what: "Всего сообщений во всех клановых чатах.",
                      how: "Подсчёт из архива переписки." },
      "Общий":      { fill: "auto", what: "Сообщений в общем чате клана.",
                      how: "Подсчёт из архива." },
      "Офицерский": { fill: "auto", what: "Сообщений в офицерском чате.",
                      how: "Подсчёт из архива." },
      "Символов":   { fill: "auto", what: "Суммарно символов в сообщениях.",
                      how: "Подсчёт из архива — показывает «объём» общения, а не только число сообщений." },
      "Медиа":      { fill: "auto", what: "Сколько фото, видео и файлов отправлено.",
                      how: "Подсчёт вложений из архива." },
      "Активность": { fill: "auto", what: "Распределение активности за последние 12 недель.",
                      how: "Строится из дат сообщений в архиве." },
      "Тренд":      { fill: "calc", what: "Динамика активности участника.",
                      how: "Сравнение последних 6 недель с предыдущими 6." },
      "Период":     { fill: "auto", what: "От первого до последнего сообщения.",
                      how: "Крайние даты сообщений из архива." },
      "Норматив":   { fill: "auto", what: "Выполнение норматива доблести за текущую неделю.",
                      how: "Берётся из снимка доблести (вкладка «Доблесть»)." },
      "Оценка":     { fill: "auto", what: "Оценка дисциплины по доблести.",
                      how: "Берётся из снимка доблести." },
      "Доблесть":   { fill: "auto", what: "Набрано доблести за текущую неделю.",
                      how: "Берётся из снимка доблести." },
    },

    // Архив доблести (clan-archive.html)
    "clan-archive": {
      "Неделя":          { fill: "auto", what: "Игровая неделя сбора (воскресенье — первый день).",
                           how: "Определяется по дате снимка." },
      "Дата снимка (UTC)": { fill: "auto", what: "Когда был сделан сбор статистики.",
                           how: "Ставится автоматически в момент загрузки снимка." },
      "Норматив":        { fill: "manual", what: "Недельный норматив доблести.",
                           how: "Задаётся при сборе и хранится вместе со снимком." },
      "Кадров":          { fill: "auto", what: "Сколько скриншотов вошло в сбор.",
                           how: "Считается при загрузке снимка." },
      "Участников":      { fill: "auto", what: "Сколько участников распознано в этом снимке.",
                           how: "Считается из распознанных строк списка." },
      "Заметки":         { fill: "manual", what: "Комментарий к снимку.",
                           how: "Заполняется вручную, по желанию." },
    },
  };

  // ── Один общий поповер на страницу ──
  let POP = null;
  let OPEN_BTN = null;

  function ensurePop() {
    if (POP) return POP;
    POP = document.createElement("div");
    POP.className = "help-popover";
    POP.setAttribute("role", "tooltip");
    POP.hidden = true;
    document.body.appendChild(POP);
    return POP;
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function fillBadge(fill) {
    const f = FILL[fill] || FILL.auto;
    return `<span class="hf-badge ${f.cls}" title="${esc(f.tip)}">${f.label}</span>`;
  }

  function closePop() {
    if (POP) POP.hidden = true;
    if (OPEN_BTN) OPEN_BTN.classList.remove("col-help-on");
    OPEN_BTN = null;
  }

  function openPop(btn, label, info) {
    const pop = ensurePop();
    pop.innerHTML =
      `<div class="help-pop-head">${esc(info.title || label)} ${fillBadge(info.fill)}</div>` +
      `<div class="help-pop-row"><span class="hpr-w">Что это</span>` +
        `<span class="hpr-v">${esc(info.what)}</span></div>` +
      (info.how
        ? `<div class="help-pop-row"><span class="hpr-w">Как считается</span>` +
          `<span class="hpr-v">${esc(info.how)}</span></div>`
        : "");
    pop.hidden = false;
    // Позиционирование: под значком, прижато к левому краю значка, с клампом.
    const r = btn.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    let left = r.left;
    let top = r.bottom + 8;
    const margin = 8;
    if (left + pw > window.innerWidth - margin)
      left = window.innerWidth - pw - margin;
    if (left < margin) left = margin;
    // Если снизу не влезает — показать сверху.
    if (top + ph > window.innerHeight - margin && r.top - ph - 8 > margin)
      top = r.top - ph - 8;
    pop.style.left = Math.round(left) + "px";
    pop.style.top = Math.round(top) + "px";
    btn.classList.add("col-help-on");
    OPEN_BTN = btn;
  }

  function makeIcon(label, info) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "col-help";
    btn.textContent = "?";
    btn.setAttribute("aria-label", "Подсказка: " + label);
    btn.title = "Что это за столбец?";
    btn.addEventListener("click", function (e) {
      // Не даём клику дойти до заголовка (иначе сработает сортировка).
      e.stopPropagation();
      e.preventDefault();
      if (OPEN_BTN === btn) { closePop(); return; }
      openPop(btn, label, info);
    });
    return btn;
  }

  // Видимый основной текст заголовка (без <small>-подписи и того, что после <br>).
  function primaryLabel(th) {
    let s = "";
    for (const n of th.childNodes) {
      if (n.nodeType === 3) s += n.textContent;          // текстовый узел
      else if (n.nodeName === "SMALL") continue;          // пропускаем подпись
      else if (n.nodeName === "BR") break;                // останавливаемся на переносе
      else if (n.classList && n.classList.contains("col-help")) continue;
      else s += n.textContent;
    }
    return s.replace(/\s+/g, " ").trim();
  }

  function buildLegend(dict, orderedLabels) {
    const det = document.createElement("details");
    det.className = "help-legend";
    const sum = document.createElement("summary");
    sum.innerHTML = `<span class="hl-ic">ℹ</span> Как заполняется таблица — что считается автоматически, а что вручную`;
    det.appendChild(sum);
    const wrap = document.createElement("div");
    wrap.className = "hl-body";
    let rows = "";
    orderedLabels.forEach((label) => {
      const info = dict[label];
      if (!info) return;
      rows +=
        `<div class="hl-row">` +
          `<span class="hl-col">${esc(info.title || label)}</span>` +
          fillBadge(info.fill) +
          `<span class="hl-desc">${esc(info.what)}${info.how ? " " + esc(info.how) : ""}</span>` +
        `</div>`;
    });
    wrap.innerHTML =
      `<div class="hl-legendkey">` +
        Object.keys(FILL).map(k =>
          `${fillBadge(k)}<small>${esc(FILL[k].tip)}</small>`).join("") +
      `</div>` + rows;
    det.appendChild(wrap);
    return det;
  }

  function enhanceTable(table) {
    const key = table.getAttribute("data-help");
    const dict = DICT[key];
    if (!dict) return;
    const ths = table.querySelectorAll("thead th");
    const used = [];
    ths.forEach((th) => {
      if (th.querySelector(".col-help")) return; // уже добавлено
      const label = primaryLabel(th);
      const info = dict[label];
      if (!info) return;
      const icon = makeIcon(label, info);
      // Заворачиваем НАЗВАНИЕ (узлы первой строки) + значок в неразрывную
      // обёртку, чтобы значок всегда стоял справа от надписи и НЕ переносился
      // под неё в узких колонках — позиция единообразна во всех столбцах.
      const stop = th.querySelector("br") || th.querySelector("small");
      const wrap = document.createElement("span");
      wrap.className = "ch-label";
      while (th.firstChild && th.firstChild !== stop) {
        wrap.appendChild(th.firstChild);
      }
      wrap.appendChild(icon);
      if (stop) th.insertBefore(wrap, stop);
      else th.appendChild(wrap);
      used.push(label);
    });
    if (!used.length) return;
    // Сноска: вставляем после контейнера таблицы (или после самой таблицы).
    const host = table.closest(".members-table-wrap, .table-wrap, .table-scroll, .members-panel") ;
    const anchor = host || table;
    if (anchor.parentNode &&
        !(anchor.nextSibling && anchor.nextSibling.classList &&
          anchor.nextSibling.classList.contains("help-legend"))) {
      const legend = buildLegend(dict, used);
      anchor.parentNode.insertBefore(legend, anchor.nextSibling);
    }
  }

  function init() {
    document.querySelectorAll("table[data-help]").forEach(enhanceTable);
    // Закрытие поповера: клик вне, Esc, скролл, ресайз.
    document.addEventListener("click", function (e) {
      if (!POP || POP.hidden) return;
      if (e.target.closest(".help-popover") || e.target.closest(".col-help")) return;
      closePop();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closePop();
    });
    window.addEventListener("scroll", closePop, true);
    window.addEventListener("resize", closePop);
  }

  // Экспорт — чтобы можно было до-инициализировать после динамической перерисовки.
  window.HelpTips = {
    refresh: function () {
      document.querySelectorAll("table[data-help]").forEach(enhanceTable);
    },
  };

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", init);
  else
    init();
})();
