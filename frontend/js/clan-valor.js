// Вкладка «Доблесть» — список сокланов из последнего valor-snapshot'а.
// Клик по «Должности» / «Титулу» / «Уровню» / «Классу» открывает popover
// с историей изменений (взято с GET /valor/history).
(async function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));

  let DATA = { snapshot: null, members: [] };
  let SORT = { key: "score", dir: "desc" };
  let IS_GUEST = false;   // гость — только просмотр, без правок
  let IS_ADMIN = false;   // админ — правка ников и данных в таблице
  let IS_OFFICER = false; // офицер ИЛИ админ — предупреждения и статус АФК

  // Переход со «Скринов сбора» (двойной клик): подсветить нужный ник.
  const FOCUS_CANON = new URLSearchParams(location.search).get("focus") || "";
  let FOCUS_SCROLLED = false;
  function applyFocus() {
    if (!FOCUS_CANON) return;
    const tb = $("valor-tbody");
    // ВАЖНО: каждый раз ищем строку ЗАНОВО — apply() вызывается несколько раз
    // (после load() и loadMe()), и ре-рендер заменяет <tr>. Старая ссылка
    // становится detached, и scrollIntoView по ней не работает.
    const findRow = () =>
      [...tb.querySelectorAll("tr.m-row")].find(x => x.dataset.canon === FOCUS_CANON);
    const tr = findRow();
    if (!tr) return;
    tb.querySelectorAll(".m-row-focus").forEach(x => x.classList.remove("m-row-focus"));
    tr.classList.add("m-row-focus");
    if (!FOCUS_SCROLLED) {
      FOCUS_SCROLLED = true;
      // Докручиваем несколько раз (ниже подгружаются timeline/архив и сдвигают
      // раскладку), КАЖДЫЙ раз беря живую строку по canon.
      const doScroll = () => {
        const r = findRow();
        if (r) r.scrollIntoView({ behavior: "smooth", block: "center" });
      };
      requestAnimationFrame(doScroll);
      setTimeout(doScroll, 400);
      setTimeout(() => {
        const r = findRow();
        if (r) {
          r.scrollIntoView({ behavior: "smooth", block: "center" });
          r.classList.add("m-row-focus", "m-row-flash");
          setTimeout(() => r.classList.remove("m-row-flash"), 1600);
        }
      }, 900);
    }
  }

  // Сетевой сбой (err.status === 0) — это «запрос не дошёл до сервера»
  // (РФ-блокировка fly.dev, флапающий мобильный интернет, TLS/CORS), а НЕ
  // «нет сессии». Разовые «Failed to fetch» лечатся ретраем. Настоящие 401/403
  // прилетают только когда сервер доступен — их пробрасываем сразу, без ретрая.
  async function tryWithRetry(fn, tries = 3) {
    for (let i = 0; ; i++) {
      try { return await fn(); }
      catch (e) {
        if (e && e.status === 0 && i < tries - 1) {
          await new Promise(r => setTimeout(r, 700 * (i + 1)));
          continue;
        }
        throw e;
      }
    }
  }

  function showNetBanner(show) {
    const b = $("net-banner");
    if (b) b.hidden = !show;
  }

  async function loadMe() {
    let me;
    try {
      me = await tryWithRetry(() => API.me());
      showNetBanner(false);
    } catch (e) {
      if (e && e.status === 0) {
        // Сервер недоступен (не «не авторизован»). Уводить на login.html
        // бессмысленно — там тот же недоступный сервер, плюс потеряли бы
        // гостевую сессию из localStorage. Показываем баннер, даём повторить.
        showNetBanner(true);
        return;
      }
      // Реальные 401/403 — сессии нет/протухла → на вход.
      location.href = "login.html";
      return;
    }
    if (me?.role === "guest") {
      IS_GUEST = true;
      document.body.classList.add("guest-mode");
      $("who").textContent = "Гость · только просмотр";
      // Красный «Только для офицеров» → зелёный «Гостевой просмотр».
      const badge = document.querySelector(".classified-badge");
      if (badge) { badge.textContent = "Гостевой просмотр"; badge.classList.add("guest"); }
      // Гостю недоступны другие разделы — прячем навигацию целиком.
      document.querySelectorAll(".tabs, .admin-only").forEach(el =>
        el.style.display = "none");
      return;
    }
    IS_ADMIN = me?.role === "admin";
    IS_OFFICER = (me?.role === "officer" || me?.role === "admin");
    // CSS-гейт админ-вкладок: body[data-role=admin] показывает .admin-only
    // (иначе вкладка «Настройки» скрыта даже у админа). Для help-tips —
    // отдельный data-help-role, чтобы блок «Для администратора» работал.
    document.body.setAttribute("data-role", me?.role || "");
    document.body.setAttribute("data-help-role", me?.role || "");
    const who = me?.role === "admin"
      ? `${esc(me.username || me.name || "")} · админ`
      : `${esc(me.username || me.name || "")} · офицер`;
    $("who").textContent = who;
  }

  $("logout-btn").addEventListener("click", async () => {
    try { await API.logout(); } catch (_) {}
    location.href = "login.html";
  });

  async function load() {
    $("valor-loading").hidden = false;
    try {
      DATA = await tryWithRetry(() => API.valorCurrent());
      if (DATA) showNetBanner(false);
    } catch (e) {
      if (e && e.status === 0) showNetBanner(true);
      $("valor-tbody").innerHTML = `<tr><td colspan="9" class="m-error">
        Ошибка загрузки: ${esc(e.detail || e.message)}</td></tr>`;
      return;
    } finally {
      $("valor-loading").hidden = true;
    }
    if (!DATA.snapshot) {
      $("valor-empty").hidden = false;
      $("valor-tbody").innerHTML = "";
      $("valor-summary").innerHTML = `<span>Снимков ещё нет.
        Запусти десктоп-приложение «PW Анализ доблести» и отправь на сайт.</span>`;
      return;
    }
    $("valor-empty").hidden = true;
    renderSummary();
    apply();
  }

  function renderSummary() {
    const s = DATA.snapshot;
    const m = DATA.members;
    // Категории — взаимно исключающие. Приоритет:
    //   АФК > Иммун > выполнен > частично (>=50%) > не выполнен (<50%)
    let afk = 0, immActive = 0, immGrace = 0;
    let metGood = 0, metPartial = 0, metBad = 0;
    const PARTIAL_THRESHOLD = 50;  // pct ниже — "не выполнили"
    for (const x of m) {
      if (x.is_afk) { afk++; continue; }
      const im = x.immunity;
      if (im && (im.status === "active" || im.status === "extended")) {
        immActive++; continue;
      }
      if (im && im.status === "grace") immGrace++;
      // Для grace УЧИТЫВАЕМ выполнен/частично — там тоже идёт оценка
      if (x.norm_met === true) { metGood++; continue; }
      if (x.norm_met === false) {
        const p = x.norm_pct == null ? 0 : x.norm_pct;
        if (p >= PARTIAL_THRESHOLD) metPartial++;
        else                         metBad++;
      }
    }
    const totalValor = m.reduce((a, x) => a + (x.valor || 0), 0);
    const immChip = immActive
      ? `<span>иммун. новички: <b style="color:#7bc7ff">🛡 ${immActive}</b></span>`
      : "";
    const graceChip = immGrace
      ? `<span>иммун. снят на неделе: <b style="color:#c9a8ff">🛡 ${immGrace}</b></span>`
      : "";
    $("valor-summary").innerHTML = `
      <span>неделя: <b>${esc(s.week)}</b></span>
      <span>норматив: <b>${esc(s.valor_norm)}</b></span>
      <span>всего: <b>${m.length}</b></span>
      <span>выполнили: <b style="color:#88ff88">${metGood}</b></span>
      <span>частично (≥${PARTIAL_THRESHOLD}%): <b style="color:#ffcc66">${metPartial}</b></span>
      <span>не выполнили: <b style="color:#ff8080">${metBad}</b></span>
      <span>АФК: <b style="color:#ffd080">${afk}</b></span>
      ${immChip}
      ${graceChip}
      <span>сумма доблести: <b>${totalValor}</b></span>
    `;
  }

  function getSortVal(m, key) {
    if (key === "level" || key === "valor")
      return m[key] == null ? -1 : m[key];
    if (key === "class") return (m.class_ || "").toLowerCase();
    if (key === "rank") {
      // ВНИМАНИЕ: чем меньше число — тем выше должность. Чтобы при
      // сортировке asc высшие были сверху, возвращаем -order
      // (sort работает в обоих направлениях, но дефолт по rank — asc
      // даёт правильный порядок Мастер→Рядовой).
      return rankOrder(m.rank);
    }
    if (key === "score") {
      return m.score ? m.score.total : -1;
    }
    if (key === "score_all") {
      return m.score ? (m.score.total_all_time ?? 0) : -1;
    }
    if (key === "norm") {
      // Сортируем по % выполнения текущей недели; АФК в середине
      if (m.is_afk) return 50;
      return m.norm_pct == null ? -1 : m.norm_pct;
    }
    if (key === "compliance") {
      return m.compliance ? m.compliance.avg_pct : -1;
    }
    if (key === "warnings") {
      // Сортируем по числу всех активных предупреждений.
      return (m.warnings ? m.warnings.length : 0)
        + (m.manual_warnings ? m.manual_warnings.length : 0)
        + (m.title_warn ? 1 : 0);
    }
    if (key === "trend") {
      const t = m.trend;
      if (!t) return -1e9;
      if (t.kind === "new")  return 1e8;
      if (t.kind === "lost") return -1e8;
      return t.pct_delta != null ? t.pct_delta : t.delta;
    }
    return (m[key] || "").toString().toLowerCase();
  }

  // Иерархия должностей в PW — для сортировки.
  const RANK_ORDER = {
    "мастер": 0, "мастер гильдии": 0, "мастер клана": 0,
    "маршал": 1, "майор": 2, "капитан": 3,
    "лейтенант": 4, "ефрейтор": 5, "рядовой": 6, "": 7,
  };
  function rankOrder(s) {
    return RANK_ORDER[(s || "").trim().toLowerCase()] ?? 99;
  }

  const TAG_META = {
    // ── Роли за БЕЗУПРЕЧНУЮ ИСТОРИЮ (≥3 нед без провала), градация по
    //    геом.среднему кратностей за всё время ──
    immortal:   { label: "Бессмертная легенда", icon: "✵", color: "#fff0b0",
                  cls: "tag-ach", glow: 1,
                  tip: "Безупречная история + средняя кратность ≥3× (геом.)." },
    legend:     { label: "Легенда доблести", icon: "♛", color: "#ffd54a",
                  cls: "tag-ach", glow: 1,
                  tip: "Безупречная история + средняя кратность ≥2× (геом.)." },
    ace:        { label: "Ас доблести", icon: "⚜", color: "#ff9a55",
                  cls: "tag-ach",
                  tip: "Безупречная история + средняя кратность ≥1.4× (геом.)." },
    etalon:     { label: "Эталон", icon: "✪", color: "#8fd6ff",
                  cls: "tag-ach",
                  tip: "Безупречная история — ни одного провала норматива." },
    // ── Роли за КОМБО перевыполнений (серия ≥3 нед ≥1.5×), градация по
    //    геом.среднему кратностей серии ──
    combo_legend: { label: "Комбо-легенда", icon: "❈", color: "#e6a8ff",
                  cls: "tag-ach", glow: 1,
                  tip: "Серия ≥3 нед, средняя кратность серии ≥3× (геом.)." },
    combo_record: { label: "Серийный рекордсмен", icon: "❉", color: "#cb9cff",
                  cls: "tag-ach",
                  tip: "Серия ≥3 нед, средняя кратность серии ≥2× (геом.)." },
    combo_over: { label: "Серия перевыполнений", icon: "❖", color: "#b7b0ff",
                  cls: "tag-ach",
                  tip: "Серия ≥3 нед перевыполнения подряд (≥1.5×)." },
    // ── Роли по СТЕПЕНИ единичного перевыполнения (пик ×N от нормы) ──
    absolute:   { label: "Абсолют доблести", icon: "☀", color: "#ffe07a",
                  cls: "tag-ach", glow: 1,
                  tip: "Почти абсолютный максимум — пик ≥13× нормы (≈189)." },
    overlord:   { label: "Властелин доблести", icon: "☄", color: "#ff86e0",
                  cls: "tag-ach", glow: 1,
                  tip: "Колоссальное перевыполнение — пик ≥9.5× нормы." },
    titan:      { label: "Титан доблести", icon: "✺", color: "#ff6a6a",
                  cls: "tag-ach", glow: 1,
                  tip: "Запредельное перевыполнение — пик ≥7× нормы." },
    phenom:     { label: "Феномен доблести", icon: "✸", color: "#ff8a44",
                  cls: "tag-ach",
                  tip: "Огромное перевыполнение — пик ≥5.5× нормы." },
    record:     { label: "Рекордсмен", icon: "⚡", color: "#ffe070",
                  cls: "tag-ach",
                  tip: "Мощное перевыполнение — пик ≥4× нормы." },
    triple:     { label: "Утроил норму", icon: "✶", color: "#7fe6d8",
                  cls: "tag-ach",
                  tip: "Утроил норму — пик ≥3×." },
    double:     { label: "Удвоил норму", icon: "◆", color: "#9ab8ff",
                  cls: "tag-ach",
                  tip: "Удвоил норму — пик ≥2×." },
    over:       { label: "Перевыполнил", icon: "▲", color: "#8dffaa",
                  cls: "tag-ach",
                  tip: "Перевыполнил норму — пик ≥1.5×." },
    met:        { label: "Норматив", icon: "✔", color: "#9d9d9d",
                  cls: "tag-ach",
                  tip: "Выполнил норму доблести (×1). Даже выполнение норматива даёт базовую ценность." },
    // ── Роли за СЕРИИ перевыполнения подряд (разблокируются навсегда по
    //    максимальной серии — один срыв не лишает достигнутого) ──
    streak2:    { label: "Серия · 2 недели", icon: "⛓", color: "#7fe6d8",
                  cls: "tag-ach",
                  tip: "Перевыполнял норму 2 недели подряд." },
    streak3:    { label: "Серия · 3 недели", icon: "⛓", color: "#5fd6c8",
                  cls: "tag-ach",
                  tip: "Перевыполнял норму 3 недели подряд." },
    month1:     { label: "Месяц напора", icon: "🔥", color: "#ff9a55",
                  cls: "tag-ach",
                  tip: "Месяц перевыполнения подряд (4 недели)." },
    month2:     { label: "Два месяца ярости", icon: "🔥", color: "#ff7a3a",
                  cls: "tag-ach", glow: 1,
                  tip: "2 месяца перевыполнения подряд (8 недель)." },
    month3:     { label: "Квартал доминатора", icon: "🔥", color: "#ff5a2a",
                  cls: "tag-ach", glow: 1,
                  tip: "3 месяца перевыполнения подряд (12 недель)." },
    half1:      { label: "Полгода несокрушим", icon: "⚜", color: "#ffd24a",
                  cls: "tag-ach", glow: 1,
                  tip: "Полгода перевыполнения подряд (26 недель)." },
    year1:      { label: "Год легенды", icon: "♛", color: "#ffd54a",
                  cls: "tag-ach", glow: 1,
                  tip: "Год перевыполнения подряд (52 недели)." },
    year2:      { label: "Два года в авангарде", icon: "♛", color: "#ffcf3a",
                  cls: "tag-ach", glow: 1,
                  tip: "2 года перевыполнения подряд (104 недели)." },
    year3:      { label: "Три года несгибаем", icon: "✷", color: "#8fd6ff",
                  cls: "tag-ach", glow: 1,
                  tip: "3 года перевыполнения подряд (156 недель)." },
    year5:      { label: "Пятилетка доблести", icon: "✵", color: "#b7b0ff",
                  cls: "tag-ach", glow: 1,
                  tip: "5 лет перевыполнения подряд (260 недель)." },
    year10:     { label: "Десятилетие — Вечный", icon: "✵", color: "#fff0b0",
                  cls: "tag-ach", glow: 1,
                  tip: "10 лет перевыполнения подряд (520 недель) — легенда клана." },
    // ── ПУТЬ ДОБЛЕСТИ — накопительный XP (доблесть × серия). Чем больше и
    //    чаще перевыполняешь — тем быстрее открываются эти роли. ──
    xp1:  { label: "Искра доблести", icon: "✦", cls: "tag-ach",
            tip: "Накоплено 50 доблесть-XP." },
    xp2:  { label: "Ратник", icon: "⚔", cls: "tag-ach",
            tip: "Накоплено 150 доблесть-XP." },
    xp3:  { label: "Закалённый", icon: "⛨", cls: "tag-ach",
            tip: "Накоплено 400 доблесть-XP." },
    xp4:  { label: "Сокрушитель", icon: "⚒", cls: "tag-ach",
            tip: "Накоплено 900 доблесть-XP." },
    xp5:  { label: "Гроза рейдов", icon: "⚡", cls: "tag-ach",
            tip: "Накоплено 2 000 доблесть-XP." },
    xp6:  { label: "Покоритель", icon: "♆", cls: "tag-ach", glow: 1,
            tip: "Накоплено 4 500 доблесть-XP." },
    xp7:  { label: "Чемпион клана", icon: "✪", cls: "tag-ach", glow: 1,
            tip: "Накоплено 10 000 доблесть-XP." },
    xp8:  { label: "Витязь легенд", icon: "♛", cls: "tag-ach", glow: 1,
            tip: "Накоплено 22 000 доблесть-XP." },
    xp9:  { label: "Архонт доблести", icon: "✷", cls: "tag-ach", glow: 1,
            tip: "Накоплено 48 000 доблесть-XP." },
    xp10: { label: "Аватар войны", icon: "☄", cls: "tag-ach", glow: 1,
            tip: "Накоплено 100 000 доблесть-XP." },
    xp11: { label: "Бессмертный", icon: "✵", cls: "tag-ach", glow: 1,
            tip: "Накоплено 220 000 доблесть-XP — вершина пути." },
    veteran:    { label: "Ветеран", icon: "★", color: "#ffd24a",
                  cls: "tag-veteran",
                  tip: "Был в первоначальном составе клана." },
    in_socials: { label: "В соцсетях", icon: "◉", color: "#b88dff",
                  cls: "tag-socials",
                  tip: "Состоит в VK или Telegram клана." },
    vk:         { label: "ВКонтакте", icon: "◈", color: "#5a91d8",
                  cls: "tag-socials",
                  tip: "Привязан профиль ВКонтакте." },
    tg:         { label: "Telegram", icon: "✈", color: "#3aa0e0",
                  cls: "tag-socials",
                  tip: "Привязан профиль Telegram." },
    chat:       { label: "Общительность", icon: "✦", color: "#57d982",
                  cls: "tag-socials",
                  tip: "Активность в клановых чатах (из «Участников»)." },
    officer:    { label: "Офицер", icon: "✦", color: "#ff9a44",
                  cls: "tag-officer",
                  tip: "Занимал офицерский пост (Капитан и выше)." },
    // Конкретные офицерские звания (руны как в Зале достижений).
    rank_capitan: { label: "Капитан", icon: "✜", color: "#caa15a",
                    cls: "tag-officer", tip: "Офицерский пост: Капитан." },
    rank_major:   { label: "Майор", icon: "❰", color: "#d8a24a",
                    cls: "tag-officer", tip: "Офицерский пост: Майор." },
    rank_marshal: { label: "Маршал", icon: "✠", color: "#ecb44a",
                    cls: "tag-officer", glow: 1, tip: "Офицерский пост: Маршал." },
    rank_master:  { label: "Мастер", icon: "♔", color: "#ff8f3f",
                    cls: "tag-officer", glow: 1, tip: "Офицерский пост: Мастер." },
  };
  // Авто-теги нельзя удалить вручную — они вычисляются на бэкенде.
  // Семейства ролей-достижений за доблесть.
  const FLAW_TAGS  = new Set(["immortal", "legend", "ace", "etalon"]); // legacy
  const COMBO_TAGS = new Set(["combo_legend", "combo_record", "combo_over"]); // legacy
  const PEAK_TAGS  = new Set(["absolute", "overlord", "titan", "phenom",
                               "record", "triple", "double", "over", "met"]);
  // Новая ветка — серии перевыполнения (от 2 недель до 10 лет).
  const STREAK_TAGS = new Set(["streak2", "streak3", "month1", "month2",
    "month3", "half1", "year1", "year2", "year3", "year5", "year10"]); // legacy
  // Путь доблести — накопительный XP (текущая ветка прогресса).
  const XP_TAGS = new Set(["xp1", "xp2", "xp3", "xp4", "xp5", "xp6",
    "xp7", "xp8", "xp9", "xp10", "xp11"]);
  const AUTO_TAGS = new Set([
    "in_socials", "officer", "vk", "tg", "chat",
    "rank_capitan", "rank_major", "rank_marshal", "rank_master",
    ...FLAW_TAGS, ...COMBO_TAGS, ...PEAK_TAGS, ...STREAK_TAGS, ...XP_TAGS]);

  // ── Система РЕДКОСТИ (как в MMO: WoW-палитра качества) + очки достижений ──
  const RARITY = {
    common:    { name: "Обычное",     color: "#9d9d9d", pts: 5 },
    uncommon:  { name: "Необычное",   color: "#1eff00", pts: 10 },
    rare:      { name: "Редкое",      color: "#3aa0ff", pts: 25 },
    epic:      { name: "Эпическое",   color: "#c77dff", pts: 50 },
    legendary: { name: "Легендарное", color: "#ff8000", pts: 100 },
    mythic:    { name: "Мифическое",  color: "#ffd866", pts: 250 },
  };
  const RARITY_ORDER = ["common", "uncommon", "rare", "epic", "legendary", "mythic"];
  // Какая редкость у каждого тира достижения (магнитуда + серии).
  const TIER_RARITY = {
    // Магнитуда (лучшая неделя ×N)
    met: "common",
    over: "uncommon", double: "uncommon", triple: "rare", record: "rare",
    phenom: "epic", titan: "epic", overlord: "legendary", absolute: "mythic",
    // Серии перевыполнения (legacy, оставлены для совместимости)
    streak2: "common", streak3: "uncommon", month1: "uncommon",
    month2: "rare", month3: "rare", half1: "epic",
    year1: "legendary", year2: "legendary", year3: "mythic",
    year5: "mythic", year10: "mythic",
    // Путь доблести (XP)
    xp1: "common", xp2: "uncommon", xp3: "uncommon", xp4: "rare", xp5: "rare",
    xp6: "epic", xp7: "epic", xp8: "legendary", xp9: "legendary",
    xp10: "mythic", xp11: "mythic",
  };
  function tierRarity(key) { return RARITY[TIER_RARITY[key]] || null; }
  // Цвет роли: для тиров — по редкости, иначе — собственный из TAG_META.
  function tagColor(key) {
    const r = tierRarity(key);
    if (r) return r.color;
    return (TAG_META[key] || {}).color || "#9fb";
  }
  // Источник множителя ×N для каждого семейства (из m.compliance).
  // Серии (STREAK_TAGS) множитель не показывают — у них «N недель».
  function tagMult(t, c) {
    if (!c) return 0;
    if (PEAK_TAGS.has(t))  return c.peak_ratio || 0;
    if (COMBO_TAGS.has(t)) return c.combo_geo || 0;
    if (FLAW_TAGS.has(t))  return c.geomean_all || 0;
    return 0;
  }

  // renderTags(m) — роли «за неделю» (m.tags) с кнопкой «+».
  // renderTagsAll(m) — роли «за всё время» (m.tags_all), без «+».
  function renderTagsAll(m) { return renderTags(m, m.tags_all || [], false); }
  function renderTags(m, tagsOverride, withAdd) {
    const tags = tagsOverride || m.tags || [];
    const btn = (withAdd === false) ? "" :
      `<button class="tag-add-btn" data-nick="${esc(m.nick)}" title="Добавить роль">+</button>`;
    if (!tags.length) return `<div class="tag-row">${btn || '<span style="color:#667">—</span>'}</div>`;
    const c = m.compliance || null;
    const chips = tags.map(t => {
      const meta = TAG_META[t] || { label: t, icon: "·",
                                      cls: "tag-default", tip: t };
      const isAch = meta.cls && meta.cls.indexOf("tag-ach") >= 0;
      // Множитель ×N по семейству роли (пик / комбо-геом. / история-геом.).
      const mult = isAch ? tagMult(t, c) : 0;
      const showMult = mult >= 1.5;
      const multHtml = showMult
        ? ` <span class="tag-mult">×${mult.toFixed(1)}</span>` : "";
      let tip = `${meta.label}${showMult ? " ×" + mult.toFixed(1) : ""}`;
      const _r = tierRarity(t);
      if (_r) tip += `  ·  ${_r.name} (${_r.pts} очк.)`;
      tip += `\n${meta.tip}`;
      if (t === "officer" && m.top_rank) tip += ` Макс. пост: ${m.top_rank}.`;
      // Когда роль получена — только в тултипе, с расшифровкой недели в дату.
      let whenTip = "";
      if (isAch && c) {
        if (PEAK_TAGS.has(t) && c.peak_week)
          whenTip = weekFull(c.peak_week);
        else if (STREAK_TAGS.has(t)) {
          tip += `\nМакс. серия: ${c.over_streak_max || 0} нед.; сейчас подряд: ${c.over_streak_cur || 0}.`;
          if (c.over_start) whenTip = `${weekFull(c.over_start)}  …  ${weekFull(c.over_end)}`;
        }
        else if (COMBO_TAGS.has(t) && c.combo_start)
          whenTip = `${weekFull(c.combo_start)}  …  ${weekFull(c.combo_end)}`;
        else if (FLAW_TAGS.has(t) && c.first_week)
          whenTip = `${weekFull(c.first_week)}  …  ${weekFull(c.last_week)}`;
      } else if (!AUTO_TAGS.has(t) && m.tag_dates && m.tag_dates[t]) {
        const a = String(m.tag_dates[t]);
        whenTip = `${a.slice(0, 10)} ${a.slice(11, 16)} UTC`;
      }
      if (whenTip) tip += `\nПолучена: ${whenTip}`;
      const auto = AUTO_TAGS.has(t) ? " tag-auto" : "";
      // Роли отображаются как КАМЕННЫЕ РУНЫ (как в Зале): мини-руна по
      // редкости (+ свечение у эпик и выше) + подпись цветом руны.
      const col = tagColor(t);
      const rk = TIER_RARITY[t];
      const glow = rk === "epic" || rk === "legendary" || rk === "mythic" || meta.glow;
      const icStyle = `border-color:${col};color:${col};` +
        (glow ? `box-shadow:0 0 8px ${col}77,inset 0 -2px 4px rgba(0,0,0,.55);`
              : `inset 0 -2px 4px rgba(0,0,0,.55);`);
      const wcol = ` data-wtipcolor="${col}"`;
      // Руна «Общительность» показывает число сообщений.
      let lbl = meta.label;
      if (t === "chat") {
        const msgs = (m.score && m.score.chat_msgs) || 0;
        lbl = `${meta.label} · ${msgs}`;
      }
      return `<span class="tag-chip tag-rune ${meta.cls}${auto}" data-wtip="${esc(tip)}"${wcol}
        data-nick="${esc(m.nick)}" data-tag="${esc(t)}"
        ><span class="tag-rune-ic" style="${icStyle}">${meta.icon}</span><span class="tag-rune-lb" style="color:${col}">${esc(lbl)}${multHtml}</span></span>`;
    }).join("");
    return `<div class="tag-row">${chips}${btn}</div>`;
  }

  // ── Гайд «Все доступные роли» ──────────────────────────────────────
  // Как получить каждую роль (понятным языком). Пороги совпадают с
  // расчётом на бэкенде (db.py) и тултипами TAG_META.
  const ROLE_HOWTO = {
    met:      "Выполни норму доблести (×1) — даёт базовую ценность.",
    over:     "Набери за неделю ≥ 1.5× нормы.",
    double:   "Набери за неделю ≥ 2× нормы.",
    triple:   "Набери за неделю ≥ 3× нормы.",
    record:   "Лучшая неделя ≥ 4× нормы.",
    phenom:   "Лучшая неделя ≥ 5.5× нормы.",
    titan:    "Лучшая неделя ≥ 7× нормы.",
    overlord: "Лучшая неделя ≥ 9.5× нормы.",
    absolute: "Лучшая неделя ≥ 13× нормы (≈ 189 доблести) — почти технический потолок.",
    streak2:  "Перевыполни норму 2 недели подряд.",
    streak3:  "Перевыполни норму 3 недели подряд.",
    month1:   "Месяц перевыполнения подряд — 4 недели.",
    month2:   "2 месяца перевыполнения подряд — 8 недель.",
    month3:   "Квартал перевыполнения подряд — 12 недель.",
    half1:    "Полгода перевыполнения подряд — 26 недель.",
    year1:    "Год перевыполнения подряд — 52 недели.",
    year2:    "2 года перевыполнения подряд — 104 недели.",
    year3:    "3 года перевыполнения подряд — 156 недель.",
    year5:    "5 лет перевыполнения подряд — 260 недель.",
    year10:   "10 лет перевыполнения подряд — 520 недель. Легенда клана.",
    veteran:    "Состоял в клане с момента основания. Роль присваивает офицер вручную.",
    officer:    "Занимал офицерский пост — Капитан или выше. Начисляется автоматически по истории должностей.",
    in_socials: "Вступи в VK- или Telegram-сообщество клана и привяжи аккаунт через бота регистрации — роль появится сама.",
  };

  // ── Гайд ролей: 3 ветки каменных рун (как в «Зале доблести») + ветеран ──
  // Руна-плитка для гайда (каменный стиль, как в Зале достижений).
  function guideRune(icon, name, req, col, rar) {
    return `<div class="ach-rune-wrap rg-rune" title="${esc(req)}">` +
      `<div class="ach-rune" style="border-color:${col};color:${col};box-shadow:0 0 9px ${col}44">${icon}</div>` +
      `<div class="ach-rune-cap" style="color:${col}">${esc(name)}</div>` +
      `<div class="ach-rune-req">${esc(req)}</div>` +
      (rar ? `<div class="rg-rar" style="color:${col}">${esc(rar)}</div>` : "") +
      `</div>`;
  }
  const guideRunes = (arr) => `<div class="rg-runes">${arr.join("")}</div>`;

  function buildRoleGuide(W) {
    const wb = W ? W.base : 35, ws = W ? W.streak : 40,
          wo = W ? W.officer : 10, wv = W ? W.veteran : 10, wsoc = W ? W.social : 5;
    const pct = (n) => `<span class="rg-pct">до ${Math.round(n)}% ценности</span>`;
    const rar = (k) => (tierRarity(k) || {}).name || "";

    const mag = MAG_LADDER.map((t) =>
      guideRune(tico(t.key), tname(t.key), `пик ≥ ×${t.mult} нормы`, tcol(t.key), rar(t.key)));
    const streaks = STREAK_LADDER_F.map((t) =>
      guideRune(tico(t.key), tname(t.key), `${t.w} нед. подряд`, tcol(t.key), rar(t.key)));
    const officers = OFFICER_RANKS.map((r) =>
      guideRune(r.ico, r.name, `пост «${r.name}»`, "#caa15a", ""));
    const socials = [
      guideRune("◈", "ВКонтакте", "вступить в VK клана", "#5a91d8", ""),
      guideRune("✈", "Telegram", "вступить в Telegram клана", "#3aa0e0", ""),
      guideRune("✦", "Общительность", "активность в чатах (из «Участники»)", "#57d982", ""),
    ];
    const vet = guideRune("★", "Ветеран", "состоял в клане с основания", "#ffd24a", "");

    return `<div class="rg-head"><span>✦ Все доступные роли клана</span>` +
      `<button class="rg-close" type="button" aria-label="Закрыть">✕</button></div>` +
      `<div class="rg-body">` +
      `<p class="rg-intro">Все роли — <b>каменные руны</b> по веткам, как в личном ` +
      `«Зале доблести» (кнопка 🏆 у ника в таблице). Итоговая <b>ценность для клана</b> = ` +
      `<b style="color:#57d982">доблесть</b> (база × множитель серии) + офицерство + ` +
      `общительность + ветеран. Доли веток настраивает админ — сейчас ` +
      `доблесть и серии вместе ≈ <b>${Math.round(wb + ws)}%</b>, это главное.</p>` +

      `<section class="rg-group"><h3 class="rg-gtitle">⚔ Доблесть и серии ${pct(wb + ws)}</h3>` +
      `<p class="rg-gintro">Главная ветка. <b>Перевыполнение</b> даёт базу ценности, а ` +
      `<b>серии</b> её УМНОЖАЮТ. Множитель растёт, пока бьёшь норму неделя за неделей, и ` +
      `<b>сбрасывается, если серия прервётся</b> — поэтому стабильность ценится выше всего.</p>` +
      `<h4 class="rg-stitle">Перевыполнение — база ${pct(wb)}</h4>` +
      `<p class="rg-snote">База ценности растёт плавно: даже выполнение нормы (×1) даёт ≈30% базы, дальше — чем сильнее перекрыл норму в лучшую неделю, тем выше (до 100% при ×13). Открывается навсегда.</p>` +
      guideRunes(mag) +
      `<h4 class="rg-stitle">Серии — множитель ${pct(ws)}</h4>` +
      `<p class="rg-snote">Сколько недель подряд перевыполняешь норму. Чем длиннее и мощнее серия — тем больше множитель. Срыв серии гасит руны и сбрасывает множитель.</p>` +
      `<p class="rg-snote rg-afk">💤 <b>Статус АФК — это пауза, а не срыв.</b> Пока у тебя АФК, серия НЕ обнуляется за невыполненную норму и предупреждения не начисляются. Как только снова перевыполнишь норму — серия продолжится с того же места. Более того: если даже в АФК ты набираешь доблесть — она идёт в зачёт (статистика, пик, серия считаются как обычно).</p>` +
      guideRunes(streaks) + `</section>` +

      `<section class="rg-group"><h3 class="rg-gtitle">✠ Офицерство ${pct(wo)}</h3>` +
      `<p class="rg-gintro">Своя руна за каждый достигнутый пост. Добавляет ценность ` +
      `(слабый множитель: +25%, если ты офицер сейчас). Доблесть не умножает.</p>` +
      guideRunes(officers) + `</section>` +

      `<section class="rg-group"><h3 class="rg-gtitle">✦ Общительность ${pct(wsoc)}</h3>` +
      `<p class="rg-gintro">За соцсети и активность в чатах (из таблицы «Участники»). ` +
      `Небольшой бонус, доблесть не умножает.</p>` +
      guideRunes(socials) + `</section>` +

      `<section class="rg-group"><h3 class="rg-gtitle">⭐ Ветеран ${pct(wv)}</h3>` +
      `<p class="rg-gintro">Состоял в клане с основания. Отдельная руна — даёт ценность ` +
      `сама по себе, без множителя. Присваивает офицер.</p>` +
      guideRunes([vet]) + `</section>` +
      `</div>`;
  }

  let RG_OVERLAY = null;
  function rgEsc(e) { if (e.key === "Escape") closeRoleGuide(); }
  function closeRoleGuide() {
    if (RG_OVERLAY) { RG_OVERLAY.remove(); RG_OVERLAY = null; }
    document.removeEventListener("keydown", rgEsc);
  }
  async function openRoleGuide() {
    if (RG_OVERLAY) return;
    injectEditStyles();                 // стили каменных рун (.ach-rune ...)
    let W = null;
    try { W = await API.valorWeights(); } catch (_) {}
    if (RG_OVERLAY) return;             // защита от двойного клика
    RG_OVERLAY = document.createElement("div");
    RG_OVERLAY.className = "rg-overlay";
    const modal = document.createElement("div");
    modal.className = "rg-modal";
    modal.innerHTML = buildRoleGuide(W);
    RG_OVERLAY.appendChild(modal);
    document.body.appendChild(RG_OVERLAY);
    RG_OVERLAY.addEventListener("click", (e) => {
      if (e.target === RG_OVERLAY || e.target.closest(".rg-close")) closeRoleGuide();
    });
    document.addEventListener("keydown", rgEsc);
  }

  // Кнопка «Посмотреть все доступные роли» в шапке столбца «Роли».
  // Видна всем, включая гостя (это справка, а не правка).
  function initRolesGuideBtn() {
    const ths = document.querySelectorAll("#valor-table thead th");
    for (const th of ths) {
      const lbl = th.querySelector(".ch-label") || th;
      const name = lbl.textContent.replace(/\s+/g, " ").replace(/\?\s*$/, "").trim();
      if (name === "Роли") {
        if (th.querySelector(".roles-guide-btn")) return;
        const b = document.createElement("button");
        b.type = "button";
        b.className = "roles-guide-btn";
        b.innerHTML = `<span class="rgb-ic">✦</span>Посмотреть все доступные роли`;
        b.title = "Открыть полный список ролей клана";
        b.addEventListener("click", (e) => { e.stopPropagation(); openRoleGuide(); });
        th.appendChild(b);
        return;
      }
    }
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", initRolesGuideBtn);
  else initRolesGuideBtn();

  function renderScore(s) {
    if (!s) return `<span style="color:#888">—</span>`;
    const cls = pctClass(s.total);
    const G = window.ClanValue;            // показываем как золото (×MULT)
    const g = (v) => G.fmt(v);             // большое золотое число
    // Ветка доблести: база (перевыполнение) × множитель серии.
    const valLine = `• доблесть: база ${g(s.doblest_base)}` +
      (s.peak_ratio ? ` (пик ×${Number(s.peak_ratio).toFixed(1)})` : "") +
      ` × серия ×${Number(s.streak_mult || 1).toFixed(2)}` +
      (s.over_streak_cur ? ` (${s.over_streak_cur} нед.)` : "") +
      ` = ${g(s.doblest_value)}`;
    const officerLine = s.top_rank
      ? `• офицерство: ${g(s.officer)} = база ${g(s.officer_base)} × ${Number(s.officer_mult || 1).toFixed(2)}` +
        ` (макс: ${s.top_rank}${s.cur_rank && s.cur_rank !== s.top_rank ? `, сейчас: ${s.cur_rank}` : ``}${s.is_cur_officer ? `, офицер сейчас` : ``})`
      : `• офицерство: ${g(s.officer)}`;
    const tip = `★ Ценность клану: ${g(s.total)} золота\n`
      + valLine + "\n"
      + officerLine + "\n"
      + `• общительность: ${g(s.social)} (VK ${s.vk ? "✓" : "—"}, TG ${s.tg ? "✓" : "—"}, ${s.chat_msgs || 0} сообщ.${s.social_mult > 1 ? `, ×${Number(s.social_mult).toFixed(2)}` : ``})\n`
      + `• ветеран: ${g(s.veteran)}`
      + (s.immunity_adjusted ? `\nИммунитет новичка активен.` : ``);
    return `<span class="norm-cell score-cell ${cls}" title="${esc(tip)}"
      >${G.badge(s.total)}</span>`;
  }

  // Накопительная ценность за всё время (золото, копится по неделям).
  function renderScoreAll(s) {
    if (!s) return `<span style="color:#888">—</span>`;
    const G = window.ClanValue;
    const tip = `★ Ценность за всё время: ${G.fmt(s.total_all_time)} золота\n` +
      `Копится каждую неделю: накопленная доблесть + текущие офицерство, ` +
      `общительность, ветеран. Только растёт.`;
    return `<span class="norm-cell score-cell p100" title="${esc(tip)}">${G.badge(s.total_all_time)}</span>`;
  }

  function pctClass(pct) {
    // pct: 0..100 → класс цвета
    if (pct >= 100) return "p100";
    if (pct >=  80) return "p80";
    if (pct >=  60) return "p60";
    if (pct >=  40) return "p40";
    if (pct >=  20) return "p20";
    return "p0";
  }

  // Дни недели для UI иммунитета. dow: 0=Пн..6=Вс
  const DOW_LABELS = ["Пн","Вт","Ср","Чт","Пт","Сб","Вс"];
  const DOW_NAMES_FULL = ["понедельник","вторник","среду","четверг","пятницу","субботу","воскресенье"];

  function fmtImmuneDate(iso) {
    // "2026-06-07" → "7 июн"
    if (!iso) return "";
    const m = ["янв","фев","мар","апр","мая","июн",
                "июл","авг","сен","окт","ноя","дек"];
    const d = new Date(iso + "T00:00:00");
    if (isNaN(d.getTime())) return iso;
    return `${d.getDate()} ${m[d.getMonth()]}`;
  }

  function renderNorm(m, norm) {
    if (m.is_afk) {
      const a = m.afk_info;
      const note = m.afk_note || "";
      const noteTip = note ? `\n💬 Комментарий: ${note}` : "";
      const noteMark = note ? ` <span class="afk-note-mark" title="${esc(note)}">💬</span>` : "";
      if (a && a.weeks) {
        // Доблесть недельная (сброс по понедельникам), поэтому за время АФК
        // суммируем недельные значения — кто фармил даже в АФК.
        const total = a.valor_total || 0;
        const gainHtml = total > 0
          ? ` · <b style="color:#7CFC00">+${total}</b>`
          : ` · <b style="color:#888">0</b>`;
        let tip = `АФК ${a.weeks} нед. (с ${a.since_week}). Норматив не оценивается.\n`;
        tip += total > 0
          ? `Набрал(а) доблести за время АФК суммарно: ${total}.`
          : `Доблесть за время АФК не набиралась.`;
        if (a.weekly && a.weekly.length) {
          tip += "\nПо неделям (набрано за неделю):";
          for (const w of a.weekly) {
            tip += `\n  ${w.week}: ${w.valor == null ? "—" : w.valor}`;
          }
        }
        return `<span class="norm-cell norm-afk" title="${esc(tip + noteTip)}"
          >АФК · ${a.weeks} нед.${gainHtml}${noteMark}</span>`;
      }
      return `<span class="norm-cell norm-afk"
        title="${esc("АФК — норматив не оценивается" + noteTip)}">АФК${noteMark}</span>`;
    }
    // ── Иммунитет имеет приоритет над обычной оценкой ──
    const imm = m.immunity;
    if (imm && imm.status === "active") {
      const until = fmtImmuneDate(imm.immune_until);
      const tip = `Иммунитет новичка активен.\n` +
        `Принят: ${imm.accepted_date}\nЗакончится: ${imm.immune_until}\n` +
        `На время иммунитета норматив не оценивается.`;
      return `<span class="norm-cell norm-immune norm-immune-active"
        title="${esc(tip)}"
        ><span class="shield">🛡</span> Иммун до ${until}</span>`;
    }
    if (imm && imm.status === "extended") {
      const dowName = DOW_NAMES_FULL[imm.ended_dow] || "?";
      const tip = `Иммунитет заканчивается в ${dowName} — слишком поздно ` +
        `чтобы успеть набрать норматив. Эта неделя оценивается как ` +
        `иммунная, отсчёт пойдёт со следующей.`;
      const dowL = DOW_LABELS[imm.ended_dow] || "?";
      return `<span class="norm-cell norm-immune norm-immune-extended norm-immune-d${imm.ended_dow}"
        title="${esc(tip)}"
        ><span class="shield">🛡</span> Продлён · окон. ${dowL}</span>`;
    }
    const wc = m.warning_count || 0;
    const pct = m.norm_pct;
    const valor = m.valor != null ? m.valor : 0;

    if (imm && imm.status === "grace") {
      const dowL  = DOW_LABELS[imm.ended_dow] || "?";
      const dowN  = DOW_NAMES_FULL[imm.ended_dow] || "?";
      const effN  = m.effective_norm || norm;
      const main  = `${valor}/${effN}`;
      const cls   = pctClass(pct == null ? 0 : pct);
      const ok    = (m.valor || 0) >= effN;
      const baseTip = `Иммунитет закончился в ${dowN} (скидка ${imm.credit_pct}%). ` +
        `Эффективный норматив этой недели: ${effN} вместо ${norm}. ` +
        `Набрано: ${valor}.`;
      const headTxt = ok ? `✓ ${main}` : `${main} · ${pct ?? 0}%`;
      return `<span class="norm-cell norm-immune norm-immune-grace norm-immune-d${imm.ended_dow} norm-${cls}"
        title="${esc(baseTip)}"
        ><span class="shield">🛡</span> ${headTxt}
        <small class="dow-tag">кон. ${dowL}</small></span>`;
    }

    // Текст: 11/14 • 78%
    const main = `${valor}/${norm}`;
    if (m.norm_met === true) {
      return `<span class="norm-cell norm-good"
        title="норматив выполнен полностью">✓ ${main}</span>`;
    }
    if (pct == null) {
      return `<span class="norm-cell norm-unknown" title="нет данных">?</span>`;
    }
    // Не выполнен — только пилюля % выполнения. Предупреждения отображаются
    // отдельно, в колонке «Предупреждения».
    const cls = pctClass(pct);
    const tip = `${pct}% от норматива`;
    return `<span class="norm-cell norm-${cls}" title="${esc(tip)}"
      >${main} · ${pct}%</span>`;
  }

  function renderCompliance(c) {
    if (!c) {
      return `<span class="norm-cell" style="color:#888"
        title="нет данных">—</span>`;
    }
    // Нет оценённых недель (все недели — АФК/иммун) → не оценивался, а не «0%».
    if (!c.weeks_count) {
      return `<span class="norm-cell" style="color:#888"
        title="нет оценённых недель — всё время под иммунитетом или в АФК">—</span>`;
    }
    const cls = pctClass(c.avg_pct);
    const tip = `${c.weeks_met} / ${c.weeks_count} недель с полным выполнением`;
    return `<span class="norm-cell comp-cell norm-${cls}" title="${esc(tip)}"
      >${c.avg_pct}%
      <small style="opacity:0.7">${c.weeks_met}/${c.weeks_count}</small>
    </span>`;
  }

  // ── Единый чип предупреждения для ВСЕХ столбцов ──
  // Формат: «Предупреждение ⚠ N». ЦВЕТ = СУРОВОСТЬ: лёгкое — зелёный,
  // среднее — жёлтый, суровое — красный (по % набранной нормы). ТИТУЛ —
  // отдельный строгий цвет (фиолетовый). РУЧНОЕ — цвет суровости + значок ✎.
  // Короткое пояснение — в красивом окошке (кастомный тултип) при наведении.
  function sev3(pct) {
    return pct >= 67 ? "light" : pct >= 34 ? "mid" : "severe";
  }
  // нормализация уровней ручных предупреждений (старые + новые значения)
  const MSEV = { light: "light", mid: "mid", severe: "severe",
                  ok: "light", low: "mid", bad: "mid", crit: "severe" };
  const _MWARN_SEV = new Set(["light", "mid", "severe"]);
  const SEVRANK = { light: 0, mid: 1, severe: 2 };
  // Человеческие названия суровости — первая строка тултипа предупреждения.
  const SEV_NAME = { light: "Лёгкое", mid: "Среднее", severe: "Суровое" };
  const sevTitle = (sev) => `${SEV_NAME[sev] || "Среднее"} предупреждение`;

  // colorCls — класс цвета (wsev-* или wtype-title); wtip — короткий текст.
  // «2026-W22» → «W22»;  «2026-06-02T..» → «02.06»
  function weekShort(w) {
    const s = String(w || ""); const i = s.indexOf("-W");
    return i >= 0 ? "W" + s.slice(i + 2) : s;
  }
  function dateShort(iso) {
    const p = String(iso || "").slice(0, 10).split("-");
    return p.length === 3 ? p[2] + "." + p[1] : String(iso || "");
  }
  const _MON = ["янв", "фев", "мар", "апр", "мая", "июн",
                "июл", "авг", "сен", "окт", "ноя", "дек"];
  // Понедельник ISO-недели (ISO 8601).
  function isoWeekMonday(year, week) {
    const s = new Date(Date.UTC(year, 0, 1 + (week - 1) * 7));
    const dow = s.getUTCDay();
    if (dow <= 4) s.setUTCDate(s.getUTCDate() - dow + 1);
    else s.setUTCDate(s.getUTCDate() + 8 - dow);
    return s;
  }
  // «2026-W22» → «25–31 мая 2026»
  function weekRange(wk) {
    const m = /^(\d{4})-W(\d{1,2})$/.exec(String(wk || ""));
    if (!m) return "";
    const mon = isoWeekMonday(+m[1], +m[2]);
    const sun = new Date(mon); sun.setUTCDate(mon.getUTCDate() + 6);
    const d1 = mon.getUTCDate(), m1 = mon.getUTCMonth();
    const d2 = sun.getUTCDate(), m2 = sun.getUTCMonth();
    return m1 === m2
      ? `${d1}–${d2} ${_MON[m2]} ${+m[1]}`
      : `${d1} ${_MON[m1]} – ${d2} ${_MON[m2]} ${+m[1]}`;
  }
  // «W22 · 25–31 мая 2026 (собрано 31 мая 23:14)»
  function weekFull(wk) {
    if (!wk) return "";
    let out = `${weekShort(wk)} · ${weekRange(wk)}`;
    const meta = DATA.weeks_meta && DATA.weeks_meta[wk];
    if (meta && meta.captured_at) {
      const c = String(meta.captured_at);
      const p = c.slice(0, 10).split("-");   // YYYY-MM-DD
      const t = c.slice(11, 16);             // HH:MM
      if (p.length === 3)
        out += ` (собрано ${+p[2]} ${_MON[+p[1] - 1]} ${t} UTC)`;
    }
    return out;
  }
  function warnChip(colorCls, n, wtip, opts) {
    opts = opts || {};
    const mark = opts.manual
      ? `<span class="wmark" aria-hidden="true">✎</span>` : "";
    // Неделя/дата выдачи — НЕ на чипе, только в тултипе (opts.corner → wtip).
    return `<span class="wchip ${colorCls}" data-wtip="${esc(wtip)}">` +
      `${mark}Предупреждение <span class="tri">⚠</span> ${n}` +
      `${opts.extra || ""}</span>`;
  }

  // Колонка «Предупреждения» — по одному чипу на тип + кнопки «+» / «✕».
  function renderWarnings(m) {
    const ws = m.warnings || [];
    const tw = m.title_warn;
    const manual = m.manual_warnings || [];
    const chips = [];
    // Норматив — суровость по худшей неделе; в тултипе — недели с датами.
    // Grace-недели (иммун только-только спал, неполная неделя) — на ступень
    // мягче: человек физически имел меньше времени набрать норматив.
    if (ws.length) {
      const SOFTER = { severe: "mid", mid: "light", light: "light" };
      const effSev = (w) => (w.grace ? SOFTER[sev3(w.pct)] : sev3(w.pct));
      const sorted = ws.slice().sort((a, b) => (a.week < b.week ? -1 : 1));
      const detail = sorted.map((w) =>
        `${weekFull(w.week)}\n  ${w.valor}/${w.norm} = ${w.pct}%` +
        (w.grace ? " (после иммунитета, неполная неделя)" : "")).join("\n");
      // худшая эффективная суровость по всем неделям
      const sev = ws.map(effSev).reduce(
        (a, b) => (SEVRANK[b] > SEVRANK[a] ? b : a), "light");
      const ndel = IS_OFFICER ? ` <button class="warn-dismiss-btn" ` +
        `data-canon="${esc(m.nick_canon)}" data-kind="norm" ` +
        `title="Снять все предупреждения по нормативу">✕</button>` : "";
      chips.push(warnChip("wsev-" + sev, ws.length,
        `${sevTitle(sev)}\nНорматив не выполнен\n${detail}`, { extra: ndel }));
    }
    // Титул — строгий цвет; в тултипе — неделя проставления с датой
    if (tw) {
      const since = m.title_warn_since;
      const tdel = IS_OFFICER ? ` <button class="warn-dismiss-btn" ` +
        `data-canon="${esc(m.nick_canon)}" data-kind="title" ` +
        `title="Снять предупреждение из титула">✕</button>` : "";
      chips.push(warnChip("wtype-title", tw,
        `Предупреждение в титуле\nВыставлено руководством гильдии` +
        (since ? `\nОтмечено: ${weekFull(since)}` : ``), { extra: tdel }));
    }
    // Ручные — цвет по худшей суровости + значок ✎; уголок = дата добавления
    if (manual.length) {
      let worstSev = "light";
      manual.forEach((w) => {
        const s = MSEV[w.severity] || "mid";
        if (SEVRANK[s] > SEVRANK[worstSev]) worstSev = s;
      });
      const detail = manual.map((w) => {
        const a = String(w.created_at || "");
        const dt = a.slice(0, 10) + " " + a.slice(11, 16) + " UTC";
        return `${dt}: ${w.reason || "(без причины)"}` +
          (w.created_by ? ` — ${w.created_by}` : ``);
      }).join("\n");
      const latest = manual[manual.length - 1];
      const del = IS_OFFICER ? ` <button class="warn-del-btn" data-id="${latest.id}" ` +
        `title="Снять последнее ручное">✕</button>` : "";
      chips.push(warnChip("wsev-" + worstSev, manual.length,
        `${sevTitle(worstSev)}\nРучное (от офицера)\n${detail}`,
        { manual: true, extra: del }));
    }
    const addBtn = IS_OFFICER ? `<button class="warn-add-btn" data-nick="${esc(m.nick)}" ` +
      `title="Добавить ручное предупреждение">+</button>` : "";
    const body = chips.length
      ? chips.join("")
      : `<span class="no-warn" data-wtip="Активных предупреждений нет">✓</span>`;
    return `<div class="warn-list">${body}${addBtn}</div>`;
  }

  function renderSocials(s) {
    if (!s) return `<span class="soc-empty">—</span>`;
    const VK_ICON = `<svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor"><path d="M2 5h3c.6 6.4 3.4 9.7 5.4 9.7.6 0 .8-.3.8-1.3v-3c0-.8-.2-1-.6-1.2L9.8 9c-.3-.2-.4-.4-.3-.7l.2-.3h3.5c.6 0 .8.3.8 1.1v3.4c0 .6.3.8.6.8.4 0 .8-.2 1.5-.9 1.8-2 3-4.6 3-4.6.1-.4.4-.5.7-.5h3c.5 0 .6.2.5.7-.2 1-2.3 4-2.3 4-.2.3-.3.5 0 .8l1 1c1.7 1.9 2 2.8 2 3.4 0 .5-.4.7-.9.7h-3c-.7 0-.9-.3-1.6-1l-1.3-1.3c-.6-.5-.8-.7-1.2-.7-.4 0-.6.2-.6 1v2.4c0 .5-.2.8-1 .8-2.7 0-5.7-1.6-7.8-4.6C3.2 12 2 8 2 5z"/></svg>`;
    const TG_ICON = `<svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor"><path d="M9.4 16.5l-.4 4.5c.5 0 .7-.2 1-.5l2.5-2.4 5 3.7c1 .5 1.6.3 1.8-.9L22.9 4c.3-1.3-.5-1.9-1.5-1.5L2 9.8c-1.3.5-1.3 1.2-.2 1.5l4.9 1.5L18 5.6c.5-.3 1-.2.6.2"/></svg>`;
    const out = [];
    // VK
    if (s.vk_screen_name) {
      out.push(`<a class="soc-chip soc-vk" target="_blank" rel="noopener"
        href="https://vk.com/${esc(s.vk_screen_name)}"
        title="VK · ${esc(s.vk_display || s.vk_screen_name)}"
        >${VK_ICON}<span>${esc(s.vk_screen_name)}</span></a>`);
    } else if (s.vk_id) {
      out.push(`<a class="soc-chip soc-vk" target="_blank" rel="noopener"
        href="https://vk.com/id${esc(s.vk_id)}"
        title="VK · ${esc(s.vk_display || '')}"
        >${VK_ICON}<span>id${esc(s.vk_id)}</span></a>`);
    }
    // TG
    if (s.tg_username) {
      out.push(`<a class="soc-chip soc-tg" target="_blank" rel="noopener"
        href="https://t.me/${esc(s.tg_username)}"
        title="Telegram · ${esc(s.tg_display || ('@' + s.tg_username))}"
        >${TG_ICON}<span>@${esc(s.tg_username)}</span></a>`);
    } else if (s.tg_id) {
      out.push(`<span class="soc-chip soc-tg soc-noid"
        title="Telegram · ${esc(s.tg_display || '')} (нет публичного @username)"
        >${TG_ICON}<span>id ${esc(s.tg_id)}</span></span>`);
    }
    return out.length
      ? `<div class="soc-row">${out.join("")}</div>`
      : `<span class="soc-empty">—</span>`;
  }

  function renderTitle(m) {
    // Числовой титул 1–9 = предупреждения, выставленные офицером в игре.
    // Показываем единым чипом «Предупреждение ⚠ N» (тип «титул»).
    // Обычный (нечисловой) титул — просто текстом.
    // Титул показываем как есть (обычным текстом). Предупреждения по титулу
    // отображаются только в колонке «Предупреждения».
    return esc(m.title);
  }

  function renderTrend(t) {
    if (!t) {
      return `<span class="trend trend-none" title="нет данных предыдущей недели">—</span>`;
    }
    if (t.kind === "new") {
      return `<span class="trend trend-new" title="вступил в клан с прошлой недели"
        >★ new</span>`;
    }
    if (t.kind === "lost") {
      return `<span class="trend trend-dead" title="нет данных доблести сейчас">✕</span>`;
    }
    // Стабильно — позитивная оценка «держится ровно», не упрёк.
    if (t.kind === "flat") {
      const dSign = t.delta > 0 ? "+" : "";
      const tipS = t.pct_delta != null
        ? `Держится стабильно (Δ ${t.pct_delta > 0 ? "+" : ""}${t.pct_delta} п.п.)`
        : `Держится стабильно (Δ ${dSign}${t.delta})`;
      return `<span class="trend trend-stable" title="${esc(tipS)}">✓ Стабильно</span>`;
    }
    const arrow = t.kind === "up" ? "▲" : t.kind === "down" ? "▼" : "▬";
    const sign = t.delta > 0 ? "+" : "";
    const pdSign = (t.pct_delta != null && t.pct_delta > 0) ? "+" : "";
    // Главное — изменение % выполнения норматива (если есть), плюс
    // абсолютный delta доблести в скобках.
    const pctLabel = t.pct_delta != null
      ? ` ${pdSign}${t.pct_delta}pp`
      : "";
    const tip = t.pct_delta != null
      ? `Δ % выполнения: ${pdSign}${t.pct_delta} п.п.; Δ доблести: ${sign}${t.delta}`
      : `Δ доблести ${sign}${t.delta} (норматив одинаковый)`;
    return `<span class="trend trend-${t.kind}" title="${esc(tip)}"
      >${arrow}${pctLabel}<small style="opacity:0.7"> ${sign}${t.delta}</small></span>`;
  }

  // Вторичная сортировка при РАВНОЙ «ценности для клана» (особенно для
  // нулей внизу списка): АФК держатся выше всех → затем иммунные
  // (по убыванию оставшихся дней иммуна) → затем все остальные «нулевые».
  // Не зависит от направления сортировки — группа АФК/иммунных всегда
  // прижата к верху своего блока равных значений.
  function statusTier(m) {
    if (m.is_afk) return 2;
    const im = m.immunity;
    if (im && (im.status === "active" || im.status === "extended")) return 1;
    return 0;
  }
  function immuneDaysLeft(m) {
    const im = m.immunity;
    if (!im || !im.immune_until) return 0;
    const d = new Date(im.immune_until + "T00:00:00");
    if (isNaN(d.getTime())) return 0;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((d - today) / 86400000);
  }
  function statusTieBreak(a, b) {
    const ta = statusTier(a), tb = statusTier(b);
    if (ta !== tb) return tb - ta;                 // выше tier → выше в списке
    if (ta === 1) return immuneDaysLeft(b) - immuneDaysLeft(a); // больше дней → выше
    return 0;
  }

  function applyFilterSort() {
    const q = $("valor-filter").value.trim().toLowerCase();
    let items = DATA.members.slice();
    if (q) {
      items = items.filter(m => {
        const hay = [m.nick, m.true_name, m.rank, m.title, m.class_, m.reg_note]
          .join(" ").toLowerCase();
        return hay.indexOf(q) >= 0;
      });
    }
    items.sort((a, b) => {
      const va = getSortVal(a, SORT.key);
      const vb = getSortVal(b, SORT.key);
      if (va < vb) return SORT.dir === "asc" ? -1 : 1;
      if (va > vb) return SORT.dir === "asc" ?  1 : -1;
      // При равной ценности — АФК выше, затем иммунные (по дням), затем 0.
      if (SORT.key === "score") return statusTieBreak(a, b);
      return 0;
    });
    return items;
  }

  function apply() {
    if (!DATA.snapshot) return;   // данные ещё не загружены
    const items = applyFilterSort();
    const norm = DATA.snapshot.valor_norm;
    const rows = items.map((m, i) => {
      const cls = m.class_ || "";
      // подсветка строки
      let rowCls = "m-row";
      const im = m.immunity;
      if (m.is_afk) rowCls += " row-afk";
      else if (im && (im.status === "active" || im.status === "extended"))
        rowCls += " row-immune";
      else if (im && im.status === "grace")
        rowCls += " row-immune-grace";
      else if (m.norm_met === false) rowCls += " row-bad";
      else if (m.norm_met === true)  rowCls += " row-good";
      const valorCell = m.valor == null
        ? `<span class="hist-cell" data-field="valor" style="color:#888">—</span>`
        : `<span class="hist-cell" data-field="valor">${esc(m.valor)}</span>`;
      const normLabel    = renderNorm(m, norm);
      const compLabel    = renderCompliance(m.compliance);
      const warnCell     = renderWarnings(m);
      const trendCell    = renderTrend(m.trend);
      const socialCell   = renderSocials(m.socials);
      const aiMark = m.ai_nick
        ? ` <span class="ai-nick" title="Ник распознан ИИ-зрением — проверьте и при необходимости исправьте вручную (только админ)">🤖</span>`
        : "";
      const sugHtml = (IS_ADMIN && m.ai_nick && m.suggest)
        ? ` <button class="ai-sug" data-act="merge-suggest" data-canon="${esc(m.nick_canon)}" data-target="${esc(m.suggest.nick)}" title="🤖 Возможно, ИИ распознал ник с ошибкой и это «${esc(m.suggest.nick)}». Нажми, чтобы подтвердить — записи объединятся, и кривой ник в будущем сам сматчится.">🤖→ ${esc(m.suggest.nick)}?</button>`
        : "";
      const adminBtns = IS_ADMIN
        ? ` <span class="row-admin">`
          + `<button class="radm" data-act="edit" data-id="${m.id}" title="✎ Редактировать строку — изменить ник и любые данные игрока. Исправленное написание ника держится из недели в неделю.">✎</button>`
          + `<button class="radm" data-act="merge" data-id="${m.id}" data-canon="${esc(m.nick_canon)}" data-nick="${esc(m.nick)}" title="🔗 «Это он и есть» — слить неверно распознанного игрока (как нового или ушедшего) в существующего. История объединится, кривой ник в будущем сам сматчится.">🔗</button>`
          + `<button class="radm" data-act="archive" data-canon="${esc(m.nick_canon)}" data-nick="${esc(m.nick)}" title="🗄 Кикнуть в архив — убрать игрока в «Покинули клан», даже если он ещё есть в снимке. Система запомнит, что его кикнули.">🗄</button>`
          + `<button class="radm" data-act="delete" data-id="${m.id}" data-nick="${esc(m.nick)}" title="🗑 Удалить фантом — убрать ошибочную строку OCR (дубль или мусор) из текущего снимка.">🗑</button>`
          + `</span>`
        : "";
      const achBtn = ` <button class="ach-btn" data-nick="${esc(m.nick)}" title="Посмотреть все достижения и прогресс ролей">🏆</button>`;
      // Кнопка истории снятых (прощённых) предупреждений — только если они есть.
      const dhistBtn = (IS_OFFICER && m.dismissed_count)
        ? ` <button class="dhist-btn" data-canon="${esc(m.nick_canon)}" data-nick="${esc(m.nick)}" title="История снятых предупреждений (${m.dismissed_count})">🕮${m.dismissed_count}</button>`
        : "";
      return `
        <tr class="${rowCls}" data-nick="${esc(m.nick)}" data-canon="${esc(m.nick_canon)}">
          <td class="m-cell-idx">${i + 1}</td>
          <td class="m-cell-name"><b>${esc(m.nick)}</b>${achBtn}${dhistBtn}${aiMark}${sugHtml}${adminBtns}</td>
          <td>${esc(m.true_name)}</td>
          <td class="socials-cell">${socialCell}</td>
          <td class="hist-cell" data-field="rank">${esc(m.rank)}</td>
          <td class="hist-cell" data-field="title">${renderTitle(m)}</td>
          <td class="col-note" title="${m.reg_note ? esc(m.reg_note) : ""}">${esc(m.reg_note || "")}</td>
          <td class="m-cell-num hist-cell" data-field="level">${m.level ?? ""}</td>
          <td class="hist-cell" data-field="class">${esc(cls)}</td>
          <td class="m-cell-num m-cell-total">${valorCell}</td>
          <td class="m-cell-num">${normLabel}${afkBtn(m)}</td>
          <td class="m-cell-num">${compLabel}</td>
          <td class="m-cell-warn">${warnCell}</td>
          <td class="m-cell-num">${trendCell}</td>
          <td class="tags-cell">${renderTags(m)}</td>
          <td class="tags-cell">${renderTagsAll(m)}</td>
          <td class="m-cell-num">${renderScore(m.score)}</td>
          <td class="m-cell-num">${renderScoreAll(m.score)}</td>
        </tr>`;
    }).join("");
    $("valor-tbody").innerHTML = rows;
    // Стрелки сортировки
    document.querySelectorAll("th[data-sort]").forEach(th => {
      th.classList.remove("sort-asc", "sort-desc");
      if (th.dataset.sort === SORT.key)
        th.classList.add(SORT.dir === "asc" ? "sort-asc" : "sort-desc");
    });
    applyFocus();   // подсветить ник, на который пришли со «Скринов сбора»
  }

  // ───────────────── Админ-редактор строки доблести ─────────────────
  // Доступен ТОЛЬКО админу. Правит написание ника (держится между неделями
  // через override по canon) и любые данные строки.
  function apiBase() { return (window.OFFICERS_CONFIG && window.OFFICERS_CONFIG.API_URL) || ""; }
  function authHeaders() {
    const h = { "Content-Type": "application/json" };
    let t = ""; try { t = localStorage.getItem("officer_session_token") || ""; } catch (_) {}
    if (t) h["Authorization"] = "Bearer " + t;
    return h;
  }
  function injectEditStyles() {
    if (document.getElementById("vedit-styles")) return;
    const s = document.createElement("style");
    s.id = "vedit-styles";
    s.textContent = `
      .ai-nick{cursor:help;filter:saturate(1.3)}
      .row-edit-btn{background:none;border:1px solid #2a6;color:#7CFC00;
        border-radius:4px;cursor:pointer;font-size:11px;line-height:1;
        padding:1px 5px;margin-left:6px;opacity:.65}
      .row-edit-btn:hover{opacity:1;background:#0c2a12}
      .vedit-overlay{position:fixed;inset:0;background:rgba(0,0,0,.72);
        display:flex;align-items:center;justify-content:center;z-index:9999}
      .vedit-card{background:#0a0f0a;border:1px solid #2a6;border-radius:10px;
        padding:18px 20px;width:min(420px,92vw);max-height:90vh;overflow:auto;
        box-shadow:0 0 30px rgba(40,255,80,.18);color:#cfe}
      .vedit-card h3{margin:0 0 12px;color:#7CFC00;font-weight:600;font-size:15px}
      .vedit-row{display:flex;align-items:center;gap:10px;margin:7px 0}
      .vedit-row span{flex:0 0 92px;color:#9fb;font-size:13px}
      .vedit-row input[type=text],.vedit-row input[type=number]{flex:1;
        background:#06120a;border:1px solid #1c4;border-radius:5px;color:#dff;
        padding:6px 8px;font-size:13px;font-family:inherit}
      .vedit-row input:focus{outline:none;border-color:#5e8}
      .vedit-check input{transform:scale(1.2)}
      .vedit-err{color:#f88;font-size:12px;min-height:16px;margin:6px 0 0}
      .vedit-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
      .vedit-btn{background:#11210f;border:1px solid #2a6;color:#bfe;
        border-radius:6px;padding:7px 14px;cursor:pointer;font-size:13px}
      .vedit-btn:hover{background:#16320f}
      .vedit-save{background:#13420f;border-color:#3c7;color:#dfffd0;font-weight:600}
      .vedit-save:disabled{opacity:.5;cursor:default}
      .row-admin{white-space:nowrap;margin-left:6px}
      .radm{background:none;border:1px solid #2a6;color:#8fd;border-radius:4px;
        cursor:pointer;font-size:11px;line-height:1;padding:1px 4px;margin-left:3px;opacity:.6}
      .radm:hover{opacity:1;background:#0c2a12}
      .ai-sug{background:#2a1f06;border:1px solid #a83;color:#fc6;border-radius:4px;
        cursor:pointer;font-size:11px;padding:1px 6px;margin-left:6px}
      .ai-sug:hover{background:#3a2b08}
      .dep-restore{background:#11210f;border:1px solid #2a6;color:#bfe;border-radius:5px;
        cursor:pointer;font-size:12px;padding:3px 9px}
      .dep-restore:hover{background:#16320f}
      .admin-help-btn{background:#11210f;border:1px solid #3c7;color:#cfffcf;
        border-radius:6px;cursor:pointer;font-size:13px;padding:6px 12px;margin:6px 0 6px 8px}
      .admin-help-btn:hover{background:#16320f}
      .ahelp-list{display:flex;flex-direction:column;gap:10px;margin-top:6px}
      .ahelp-item{display:flex;gap:10px;align-items:flex-start;
        border:1px solid #1c3a1c;border-radius:8px;padding:9px 11px;background:#06120a}
      .ahelp-ico{font-size:18px;flex:0 0 26px;text-align:center}
      .ahelp-txt b{color:#7CFC00;font-size:13px}
      .ahelp-txt div{color:#bcd;font-size:12px;margin-top:2px;line-height:1.45}
      .ahelp-note{color:#8a9;font-size:11px;margin-top:12px;font-style:italic}
      .vedit-card.wide{width:min(640px,95vw)}
      .ach-card h3{font-size:16px}
      .ach-sub{color:#9fb;font-size:11.5px;margin:8px 0 4px}
      /* Сводка-шапка как в игровом профиле */
      .ach-hdr{display:flex;gap:10px;flex-wrap:wrap;background:#06120a;
        border:1px solid #1c3a1c;border-radius:10px;padding:11px 12px;margin:4px 0 10px}
      .ach-hstat{flex:1 1 110px;text-align:center}
      .ach-hstat b{display:block;font-size:19px;color:#dfe;line-height:1.1}
      .ach-hstat b small{font-size:12px;color:#7aa}
      .ach-hstat span{font-size:10.5px;color:#8aa;text-transform:uppercase;letter-spacing:.4px}
      .ach-legend{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 4px;font-size:10.5px}
      .ach-leg small{color:#778;font-size:9.5px}
      .ach-sec-h{color:#7CFC00;font-weight:600;font-size:12.5px;margin:14px 0 7px;
        border-top:1px dashed #1c3a1c;padding-top:11px}
      .ach-sec-h:first-of-type{border-top:none;padding-top:0}
      .ach-row{display:flex;align-items:center;gap:10px;padding:5px 7px;
        border-radius:8px;margin:3px 0;border:1px solid transparent}
      .ach-row.lit{background:#0a160c}
      .ach-row.locked{opacity:.5}
      .ach-row.next{border-color:#3c7;background:#0c2410;box-shadow:0 0 8px rgba(40,255,80,.12)}
      /* Медальон-иконка по редкости */
      .ach-medal{flex:0 0 34px;width:34px;height:34px;border-radius:50%;
        display:flex;align-items:center;justify-content:center;font-size:16px;
        border:2px solid #444}
      .ach-nm{flex:1;font-size:13px;color:#cfe;display:flex;align-items:center;gap:7px;flex-wrap:wrap}
      .ach-rar{font-size:9.5px;border:1px solid #444;border-radius:4px;
        padding:0 5px;text-transform:uppercase;letter-spacing:.4px}
      .ach-req{color:#8aa;font-size:11px;white-space:nowrap}
      .ach-pts{font-size:11px;color:#667;min-width:34px;text-align:right}
      .ach-st{flex:0 0 20px;text-align:center;font-size:13px}
      .ach-bar{height:8px;background:#0a1c0e;border:1px solid #1f5a26;border-radius:5px;
        overflow:hidden;margin:4px 0 2px}
      .ach-bar i{display:block;height:100%;background:linear-gradient(90deg,#2a6,#7CFC00)}
      .ach-bar-lbl{color:#9fb;font-size:11px;margin-bottom:8px}
      /* ── Diablo-стиль зала доблести ── */
      .ach-diablo{background:linear-gradient(180deg,#0c0d12,#070809);border-color:#3a2f1a;
        box-shadow:0 0 34px rgba(0,0,0,.6),inset 0 0 60px rgba(60,40,10,.10)}
      .ach-diablo h3{color:#e8c879;text-shadow:0 0 10px rgba(232,200,121,.35);text-align:center}
      /* Главная XP-шкала (как уровень) */
      .ach-xpbar{margin:6px 0 12px;padding:9px 11px;border:1px solid #3a2f1a;border-radius:10px;
        background:radial-gradient(circle at 50% 0,#16130c,#0a0a0d)}
      .ach-xpbar-top{display:flex;justify-content:space-between;font-size:12px;color:#d8c79a;margin-bottom:6px}
      .ach-xpbar-top b{color:#ffd866}
      .ach-xpfill{height:12px;border-radius:7px;background:#0a0a0d;border:1px solid #4a3a1a;overflow:hidden}
      .ach-xpfill i{display:block;height:100%;
        background:linear-gradient(90deg,#7a5a18,#ffd866,#fff2c0);box-shadow:0 0 12px rgba(255,216,102,.5)}
      /* Цепочка-ветка с путём */
      .ach-chain{position:relative;margin:2px 0 6px}
      .ach-path{position:absolute;left:24px;top:14px;bottom:14px;width:3px;background:#26262e;border-radius:2px;overflow:hidden}
      .ach-path i{position:absolute;top:0;left:0;width:100%;opacity:.85;box-shadow:0 0 8px currentColor}
      .ach-nodes{position:relative;z-index:1}
      .ach-node{display:flex;align-items:center;gap:11px;padding:4px 6px;margin:2px 0;border-radius:8px}
      .ach-node.next{background:#10140c;border:1px solid #3c7}
      .ach-node.locked{opacity:.6}
      .ach-medal{flex:0 0 34px;width:34px;height:34px;border-radius:50%;display:flex;
        align-items:center;justify-content:center;font-size:16px;border:2px solid #444}
      .ach-nm{flex:1;font-size:13px;color:#cfe;display:flex;align-items:center;gap:7px;flex-wrap:wrap}
      .ach-rar{font-size:9.5px;border:1px solid #444;border-radius:4px;padding:0 5px;
        text-transform:uppercase;letter-spacing:.4px}
      .ach-req{color:#9a8f70;font-size:11px;white-space:nowrap}
      .ach-pts{font-size:11px;color:#667;min-width:34px;text-align:right}
      .ach-st{flex:0 0 20px;text-align:center;font-size:13px}
      /* ── 3 ветки каменных рун (Diablo 4) ── */
      .ach-card.ach-diablo{position:relative}
      .ach-multline{font-size:11.5px;color:#cdbf9a;background:#0c0d10;border:1px solid #2a2418;
        border-radius:8px;padding:7px 10px;margin:0 0 10px}
      .ach-multline b{color:#ffd866}
      .ach-sumline{font-size:12px;color:#cdbf9a;background:#0c0d10;border:1px solid #3a2f1a;
        border-radius:8px;padding:8px 11px;margin:0 0 10px;line-height:1.7}
      .ach-sum-t{color:#e3cd92;font-weight:600;margin-right:4px}
      .ach-sum-op{color:#8a8470;margin:0 3px}
      /* Зал: шапка с кнопками ФИКСИРОВАНА, скроллится только содержимое */
      .ach-card.ach-diablo{width:min(940px,96vw);max-height:94vh;
        display:flex;flex-direction:column;overflow:hidden}
      .ach-topbar{flex:0 0 auto;display:flex;gap:10px;align-items:center;
        flex-wrap:wrap;padding:0 0 10px;margin:0 0 6px;
        border-bottom:1px solid #2a2418}
      .ach-topbar .roles-guide-btn{margin:0}
      .ach-topbar .vedit-btn{margin-left:auto}
      .ach-scroll{flex:1 1 auto;overflow-y:auto;min-height:0;padding-right:4px}
      .ach-tree{display:flex;gap:12px;flex-wrap:wrap;justify-content:center;align-items:flex-start;margin-top:4px}
      .ach-branch{flex:1 1 150px;min-width:140px;max-width:210px;
        background:linear-gradient(180deg,#111017,#0a090c);border:1px solid #2c2a22;
        border-radius:12px;padding:9px 7px 10px;box-shadow:inset 0 0 26px rgba(0,0,0,.5)}
      .ach-branch-h{text-align:center;color:#e3cd92;font-weight:600;font-size:12px;margin-bottom:3px}
      .ach-branch-hint{text-align:center;color:#8a8470;font-size:9.5px;margin-bottom:7px;line-height:1.3}
      .ach-branch-runes{display:flex;flex-direction:column;align-items:center}
      .ach-rune-wrap{display:flex;flex-direction:column;align-items:center;text-align:center}
      .ach-rune{width:38px;height:38px;border-radius:9px;display:flex;align-items:center;
        justify-content:center;font-size:17px;border:2px solid #5a4a2a;color:#7a715a;
        background:linear-gradient(145deg,#26231c,#121013);
        box-shadow:inset 0 1px 0 rgba(255,255,255,.05),inset 0 -3px 6px rgba(0,0,0,.55)}
      .ach-rune-wrap.locked .ach-rune{filter:grayscale(1);opacity:.5}
      .ach-rune-cap{font-size:9.5px;color:#b9ad8e;margin-top:2px;max-width:96px;line-height:1.15}
      .ach-rune-wrap.locked .ach-rune-cap{color:#6a6458}
      .ach-rune-req{font-size:8.5px;color:#7e7660;margin-top:0}
      .ach-link{width:3px;height:9px;background:#2a2620;border-radius:2px;margin:1px 0}
      .ach-link.lit{box-shadow:0 0 6px currentColor}
      .ach-mfoot{margin-top:9px;padding-top:7px;border-top:1px dashed #2c2a22;text-align:center}
      .ach-mfoot-x{color:#ffd866;font-weight:700;font-size:14px;margin-right:5px}
      .ach-mfoot-v{color:#57d982;font-weight:600;font-size:13px}
      .ach-mfoot small{display:block;color:#8a8470;font-size:9px;margin-top:1px}
      .ach-subdiv{font-size:9.5px;color:#8a8470;text-transform:uppercase;letter-spacing:.5px;
        margin:7px 0 3px;border-top:1px dashed #2c2a22;padding-top:7px;width:100%;text-align:center}
      /* Ветеран — отдельным уголком среди рун (в дереве) */
      .ach-vet-corner{flex:0 0 auto;align-self:flex-start;display:flex;
        flex-direction:column;align-items:center;min-width:96px;max-width:120px;
        padding:9px 8px 10px;border:1px dashed #5a4a2a;border-radius:12px;
        background:linear-gradient(180deg,#14110a,#0a090c)}
      .ach-vet-corner .ach-vet-h{font-size:11px;color:#e3cd92;font-weight:600;margin-bottom:8px}
      .ach-vet-corner.locked{opacity:.55}
      /* Ветка «Доблесть и серии» — две параллельные полоски + × посередине */
      .branch-valor{flex:1 1 360px;max-width:430px}
      .ach-dual{display:flex;align-items:flex-start;justify-content:center;gap:6px}
      .ach-dual-side{flex:1 1 0;min-width:0;display:flex;flex-direction:column;align-items:center}
      .ach-side-h{font-size:10px;color:#b9ad8e;text-align:center;margin-bottom:6px;line-height:1.25}
      .ach-side-h small{color:#8a8470;font-size:9px}
      .ach-dual-mid{flex:0 0 58px;display:flex;flex-direction:column;align-items:center;
        justify-content:center;align-self:center;gap:3px}
      .ach-mult-badge{font-size:18px;font-weight:700;color:#ffd866;
        text-shadow:0 0 10px rgba(255,216,102,.5)}
      .ach-mult-eq{font-size:12px;color:#57d982;font-weight:600}
      .ach-mult-note{font-size:8.5px;color:#8a8470;text-align:center;line-height:1.25;text-transform:uppercase;letter-spacing:.3px}
      /* Руны в гайде «Все доступные роли» */
      .rg-runes{display:flex;flex-wrap:wrap;gap:11px;margin:8px 0 6px}
      .rg-rune{flex:0 0 auto;width:86px}
      .rg-rar{font-size:8.5px;opacity:.85;margin-top:1px;text-transform:uppercase;letter-spacing:.3px;text-align:center}
      .rg-pct{font-size:11px;color:#8a8470;font-weight:400;margin-left:8px}
      .rg-afk,.ach-afk{background:rgba(120,180,255,.08);border:1px solid rgba(120,180,255,.28);
        border-radius:8px;padding:7px 10px;color:#bcd6ff !important}
      .ach-afk{font-size:11px;margin:6px 0 2px}`;
    document.head.appendChild(s);
  }
  function closeEditModal() {
    const ov = document.getElementById("vedit-overlay");
    if (ov) ov.remove();
  }
  function openEditModal(m) {
    injectEditStyles();
    closeEditModal();
    const F = [
      ["nick", "Ник", m.nick ?? "", "text"],
      ["true_name", "Имя", m.true_name ?? "", "text"],
      ["rank", "Должность", m.rank ?? "", "text"],
      ["title", "Титул", m.title ?? "", "text"],
      ["class", "Класс", m.class_ ?? "", "text"],
      ["level", "Уровень", m.level ?? "", "number"],
      ["valor", "Доблесть", m.valor ?? "", "number"],
    ];
    const rows = F.map(([k, label, val, type]) =>
      `<label class="vedit-row"><span>${label}</span>
        <input data-k="${k}" type="${type}" value="${esc(String(val))}"></label>`).join("");
    const ov = document.createElement("div");
    ov.id = "vedit-overlay";
    ov.className = "vedit-overlay";
    ov.innerHTML = `
      <div class="vedit-card" role="dialog" aria-modal="true">
        <h3>Редактирование · ${esc(m.nick || "")}</h3>
        ${rows}
        <label class="vedit-row vedit-check"><span>АФК</span>
          <input data-k="is_afk" type="checkbox" ${m.is_afk ? "checked" : ""}></label>
        <label class="vedit-row"><span>Коммент. АФК</span>
          <input data-k="afk_note" type="text" value="${esc(m.afk_note || "")}"
            placeholder="причина / до какого числа (напр. «отпуск до 20.07»)"></label>
        <div class="vedit-err" id="vedit-err"></div>
        <div class="vedit-actions">
          <button id="vedit-cancel" class="vedit-btn">Отмена</button>
          <button id="vedit-save" class="vedit-btn vedit-save">Сохранить</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    ov.addEventListener("click", e => { if (e.target === ov) closeEditModal(); });
    ov.querySelector("#vedit-cancel").onclick = closeEditModal;
    ov.querySelector("#vedit-save").onclick = () => saveEdit(m);
    const first = ov.querySelector("input"); if (first) first.focus();
  }
  async function saveEdit(m) {
    const ov = document.getElementById("vedit-overlay");
    if (!ov) return;
    const body = {};
    ov.querySelectorAll("input[data-k]").forEach(inp => {
      const k = inp.dataset.k;
      if (k === "is_afk") { body[k] = inp.checked; return; }
      if (inp.type === "number") {
        body[k] = inp.value === "" ? null : parseInt(inp.value, 10);
      } else {
        body[k] = inp.value;
      }
    });
    const errEl = ov.querySelector("#vedit-err");
    const btn = ov.querySelector("#vedit-save");
    btn.disabled = true; errEl.textContent = "";
    try {
      const res = await fetch(apiBase() + "/valor/member/" + m.id, {
        method: "PATCH", credentials: "include",
        headers: authHeaders(), body: JSON.stringify(body),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(res.status === 403 ? "Только для администратора"
                        : (t || ("HTTP " + res.status)));
      }
      closeEditModal();
      await load();
    } catch (e) {
      errEl.textContent = e.message || "Ошибка сохранения";
      btn.disabled = false;
    }
  }
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeEditModal(); });

  // Универсальный админ-вызов API (PATCH/POST/DELETE) с обработкой ошибок.
  async function adminCall(method, path, body) {
    const init = { method, credentials: "include", headers: authHeaders() };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(apiBase() + path, init);
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      alert("Ошибка: " + (res.status === 403 ? "только для администратора"
                          : (t || ("HTTP " + res.status))));
      throw new Error("admin call failed");
    }
    return res.status === 204 ? null : res.json().catch(() => null);
  }

  // Делегированные админ-действия в строках таблицы.
  $("valor-tbody").addEventListener("click", async (ev) => {
    const b = ev.target.closest(".radm, .ai-sug");
    if (!b || !IS_ADMIN) return;
    ev.stopPropagation();
    const act = b.dataset.act;
    const id = b.dataset.id ? parseInt(b.dataset.id, 10) : null;
    const canon = b.dataset.canon;
    try {
      if (act === "edit") {
        const m = (DATA.members || []).find(x => x.id === id);
        if (m) openEditModal(m);
      } else if (act === "delete") {
        if (!confirm(`Удалить строку «${b.dataset.nick}» из текущего снимка?\n(для фантомов/дублей OCR)`)) return;
        await adminCall("DELETE", "/valor/member/" + id);
        await load();
      } else if (act === "archive") {
        const reason = prompt(`Кикнуть «${b.dataset.nick}» в архив доблести?\nПричина (необязательно):`, "");
        if (reason === null) return;
        await adminCall("POST", "/valor/archive", { canon, reason });
        await load(); await loadDeparted();
      } else if (act === "merge") {
        const target = (prompt(`«Это он и есть» — слить запись «${b.dataset.nick}» в существующего игрока.\nУкажите правильный ник:`, "") || "").trim();
        if (!target) return;
        await adminCall("POST", "/valor/merge", { source_canon: canon, target_nick: target });
        await load(); await loadDeparted();
      } else if (act === "merge-suggest") {
        const target = b.dataset.target;
        if (!confirm(`Подтвердить: это «${target}»?\nЗаписи будут объединены, кривой ник в будущем сам сматчится.`)) return;
        await adminCall("POST", "/valor/merge", { source_canon: canon, target_nick: target });
        await load(); await loadDeparted();
      }
    } catch (_) { /* adminCall уже показал alert */ }
  });

  // ── Справка по инструментам админа (data-driven — новые функции просто
  //    добавляются в массив и автоматически появляются в окне) ──
  const ADMIN_TOOLS = [
    { ico: "✎", t: "Редактировать строку",
      d: "Изменить ник, имя, должность, титул, класс, уровень, доблесть и статус АФК любого игрока. Исправленное написание ника держится из недели в неделю." },
    { ico: "🔗", t: "«Это он и есть» (слияние)",
      d: "Если ИИ-зрение распознало игрока как нового или другого человека из-за ошибки чтения — укажите правильный ник. История объединится, а кривой OCR-ник в будущих снимках будет автоматически сопоставляться с правильным игроком." },
    { ico: "🤖", t: "Подсказка похожего",
      d: "Рядом с ником, который распознал ИИ, система сама предлагает «возможно это X» (поиск по похожести среди участников и ушедших). Один клик — подтвердить слияние." },
    { ico: "🗄", t: "Кикнуть в архив",
      d: "Вручную переместить игрока из основного списка в «Покинули клан», даже если он ещё есть в снимке. Система запомнит, что его кикнули." },
    { ico: "↩", t: "Вернуть из архива",
      d: "Кнопка «вернуть» в разделе «Покинули клан». Возвращает ошибочно ушедшего/кикнутого обратно в основной список (если он есть в текущем снимке)." },
    { ico: "🗑", t: "Удалить фантом",
      d: "Удалить ошибочную строку OCR (дубль или мусор) из текущего снимка." },
    { ico: "🛡", t: "Авто-иммунитет новичкам",
      d: "Новичок (нет в прошлом снимке и в реестре) автоматически получает иммунитет 7 дней и помечается 🤖 — проверьте и при необходимости поправьте ник." },
  ];
  function openAdminHelp() {
    injectEditStyles();
    closeEditModal();
    const items = ADMIN_TOOLS.map(x => `
      <div class="ahelp-item"><div class="ahelp-ico">${x.ico}</div>
        <div class="ahelp-txt"><b>${esc(x.t)}</b><div>${esc(x.d)}</div></div></div>`).join("");
    const ov = document.createElement("div");
    ov.id = "vedit-overlay"; ov.className = "vedit-overlay";
    ov.innerHTML = `
      <div class="vedit-card wide" role="dialog" aria-modal="true">
        <h3>🛠 Инструменты администратора</h3>
        <div class="ahelp-list">${items}</div>
        <div class="ahelp-note">Доступно только при входе как администратор. Новые инструменты будут появляться здесь автоматически.</div>
        <div class="vedit-actions"><button id="vedit-cancel" class="vedit-btn">Закрыть</button></div>
      </div>`;
    document.body.appendChild(ov);
    ov.addEventListener("click", e => { if (e.target === ov) closeEditModal(); });
    ov.querySelector("#vedit-cancel").onclick = closeEditModal;
  }
  function injectAdminHelp() {
    if (document.getElementById("admin-help-btn")) return;
    injectEditStyles();
    const btn = document.createElement("button");
    btn.id = "admin-help-btn"; btn.className = "admin-help-btn";
    btn.textContent = "🛠 Инструменты админа";
    btn.onclick = openAdminHelp;
    const anchor = document.getElementById("valor-filter");
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(btn, anchor.nextSibling);
    else document.body.appendChild(btn);
  }

  // ──────────── Зал доблести: 3 ветки рун в стиле Diablo 4 (клик 🏆) ─────────
  // Доступно ВСЕМ ролям (данные из m.compliance/score, их получает каждый).
  const MAG_LADDER = [
    { key: "met", mult: 1.0 },
    { key: "over", mult: 1.5 }, { key: "double", mult: 2 },
    { key: "triple", mult: 3 }, { key: "record", mult: 4 },
    { key: "phenom", mult: 5.5 }, { key: "titan", mult: 7 },
    { key: "overlord", mult: 9.5 }, { key: "absolute", mult: 13 },
  ];
  const STREAK_LADDER_F = [
    { key: "streak2", w: 2 }, { key: "streak3", w: 3 }, { key: "month1", w: 4 },
    { key: "month2", w: 8 }, { key: "month3", w: 12 }, { key: "half1", w: 26 },
    { key: "year1", w: 52 }, { key: "year2", w: 104 }, { key: "year3", w: 156 },
    { key: "year5", w: 260 }, { key: "year10", w: 520 },
  ];
  const OFFICER_RANKS = [   // ветка офицерства (по возрастанию престижа), с Капитана
    { name: "Капитан", ord: 3, ico: "✜" },
    { name: "Майор", ord: 2, ico: "❰" }, { name: "Маршал", ord: 1, ico: "✠" },
    { name: "Мастер", ord: 0, ico: "♔" },
  ];
  const fmtN = (n) => Number(n).toLocaleString("ru-RU");
  function streakRarity(avgOfs) {
    if (avgOfs >= 0.55) return "mythic"; if (avgOfs >= 0.38) return "legendary";
    if (avgOfs >= 0.24) return "epic"; if (avgOfs >= 0.14) return "rare";
    if (avgOfs >= 0.07) return "uncommon"; return "common";
  }

  // Каменная руна Diablo-стиля: квадрат-камень + подпись. Возвращает {html,lit,col}.
  function rune(icon, name, sub, lit, col, isNext) {
    const cls = lit ? "lit" : (isNext ? "next" : "locked");
    // ТОЛЬКО достигнутые руны светятся (цвет + glow). «Следующая цель» —
    // тусклая серая пунктирная (НЕ светится), закрытые — серые с 🔒.
    const rs = lit
      ? `border-color:${col};color:${col};box-shadow:0 0 13px ${col}77,inset 0 -3px 7px rgba(0,0,0,.55);`
      : (isNext ? `border:2px dashed #57503a;color:#8a8470;opacity:.7;box-shadow:none;` : ``);
    return {
      lit, col, html:
      `<div class="ach-rune-wrap ${cls}">
        <div class="ach-rune" style="${rs}">${lit ? icon : (isNext ? "▸" : "🔒")}</div>
        <div class="ach-rune-cap"${lit ? ` style="color:${col}"` : ""}>${esc(name)}</div>
        ${sub ? `<div class="ach-rune-req">${esc(sub)}</div>` : ""}</div>`
    };
  }
  // Ветка-колонка: руны, соединённые линиями (линия загорается, когда
  // достигнута следующая руна) — как путь скилл-дерева Diablo.
  function branchCol(title, hint, runes, footer) {
    let body = "";
    runes.forEach((r, i) => {
      if (i > 0) body += `<div class="ach-link${r.lit ? " lit" : ""}"${r.lit ? ` style="background:${r.col};box-shadow:0 0 7px ${r.col}"` : ""}></div>`;
      body += r.html;
    });
    return `<div class="ach-branch"><div class="ach-branch-h">${title}</div>` +
      (hint ? `<div class="ach-branch-hint">${hint}</div>` : "") +
      `<div class="ach-branch-runes">${body}</div>` +
      (footer || "") + `</div>`;
  }
  // Футер ветки с множителем: «× M ⇒ золото».
  function multFooter(mult, value, note) {
    const gv = `<span class="ach-mfoot-v val-gold">${window.ClanValue.coin()}${window.ClanValue.fmt(value)}</span>`;
    if (!(mult > 1)) return `<div class="ach-mfoot">${gv}<small>золота</small></div>`;
    return `<div class="ach-mfoot"><span class="ach-mfoot-x">×${Number(mult).toFixed(2)}</span>` +
      `= ${gv}` + (note ? `<small>${esc(note)}</small>` : "") + `</div>`;
  }
  // Колонка рун с загорающимися линиями (без обёртки ветки).
  function runeCol(runes) {
    let body = "";
    runes.forEach((r, i) => {
      if (i > 0) body += `<div class="ach-link${r.lit ? " lit" : ""}"${r.lit ? ` style="background:${r.col};box-shadow:0 0 7px ${r.col}"` : ""}></div>`;
      body += r.html;
    });
    return `<div class="ach-branch-runes">${body}</div>`;
  }
  // Ветка «Доблесть и серии»: ДВЕ параллельные полоски — перевыполнение (база)
  // и серии (множитель), между ними знак ×, показывающий что серии умножают.
  function branchValor(magRunes, strRunes, mult, base, val) {
    return `<div class="ach-branch branch-valor">
      <div class="ach-branch-h">⚔ Доблесть и серии</div>
      <div class="ach-branch-hint">Серии-руны <b>умножают</b> ценность рун перевыполнения</div>
      <div class="ach-dual">
        <div class="ach-dual-side">
          <div class="ach-side-h">Перевыполнение<br><small>база ценности</small></div>
          ${runeCol(magRunes)}</div>
        <div class="ach-dual-mid">
          <div class="ach-mult-badge">×${mult.toFixed(2)}</div>
          <div class="ach-mult-eq val-gold">${window.ClanValue.coin()}${val == null ? "—" : window.ClanValue.fmt(val)}</div>
          <div class="ach-mult-note">серии<br>умножают<br>↑ базу</div>
        </div>
        <div class="ach-dual-side">
          <div class="ach-side-h">Серии<br><small>×множитель</small></div>
          ${runeCol(strRunes)}</div>
      </div></div>`;
  }
  function tcol(key) { const r = tierRarity(key); return r ? r.color : "#9fb"; }
  function tname(key) { return (TAG_META[key] || {}).label || key; }
  function tico(key) { return (TAG_META[key] || {}).icon || "◆"; }

  function openAchievements(m) {
    injectEditStyles();
    closeEditModal();
    const c = m.compliance || {};
    const s = m.score || {};
    const peak = c.peak_ratio || 0;
    const cur = c.over_streak_cur || 0;          // текущий стрик (сбрасывается)
    const curOfsSum = c.cur_ofs_sum || 0;
    const avgCurOfs = cur > 0 ? curOfsSum / cur : 0;
    const mult = s.streak_mult || 1;
    const norm = (DATA.snapshot && DATA.snapshot.valor_norm) || 0;

    // ── ВЕТКА 1: «Сила недели» (магнитуда, по пику) ──
    let magNext = false;
    const magRunes = MAG_LADDER.map(t => {
      const lit = peak >= t.mult; const isN = !lit && !magNext; if (isN) magNext = true;
      const req = norm ? `${fmtN(Math.ceil(t.mult * norm))} добл.` : `×${t.mult}`;
      return rune(tico(t.key), tname(t.key), req, lit, tcol(t.key), isN);
    });
    // Стрик-руны (по ТЕКУЩЕМУ стрику; редкость по магнитуде серии; сброс при потере)
    let strNext = false;
    const strRarCol = RARITY[streakRarity(avgCurOfs)].color;
    const strRunes = STREAK_LADDER_F.map(t => {
      const lit = cur >= t.w; const isN = !lit && !strNext; if (isN) strNext = true;
      const col = lit ? strRarCol : tcol(t.key);
      return rune(tico(t.key), tname(t.key), `${t.w} нед.`, lit, col, isN);
    });

    // ── ВЕТКА 2: Офицерство (по высшему посту; текущий — подсвечен) ──
    const topOrd = rankOrder(s.top_rank || "");
    const offRunes = OFFICER_RANKS.map(r => {
      const lit = topOrd <= r.ord;     // достиг хотя бы этого поста
      const isCur = (s.cur_rank || "").toLowerCase() === r.name.toLowerCase();
      const col = isCur ? "#ff8f3f" : "#caa15a";
      return rune(r.ico, r.name + (isCur ? " ·сейчас" : ""), lit ? (isCur ? "занимает" : "занимал") : "", lit, col, false);
    });

    // ── ВЕТКА 3: Общительность (VK + Telegram + чаты из «Участников») ──
    const socRunes = [
      rune("◈", "ВКонтакте", (s.vk || 0) > 0 ? "привязан" : "", (s.vk || 0) > 0, "#5a91d8", false),
      rune("✈", "Telegram", (s.tg || 0) > 0 ? "привязан" : "", (s.tg || 0) > 0, "#3aa0e0", false),
      rune("✦", "Общительность", `${s.chat_msgs || 0} сообщ.`, (s.chat || 0) > 0, "#57d982", false),
    ];

    // Руна ветерана — отдельным уголком среди рун (в дереве).
    const hasVet = (s.veteran || 0) > 0;
    const vetBox = `<div class="ach-vet-corner ${hasVet ? "lit" : "locked"}" title="Ветеран — состоял в первоначальном составе клана">
      <div class="ach-vet-h">⭐ Ветеран</div>
      <div class="ach-rune" style="${hasVet ? "border-color:#ffd24a;color:#ffd24a;box-shadow:0 0 13px #ffd24a88,inset 0 -3px 7px rgba(0,0,0,.55);" : ""}">${hasVet ? "★" : "🔒"}</div>
      <div class="ach-rune-cap"${hasVet ? ' style="color:#ffd24a"' : ""}>Ветеран</div>
      <div class="ach-rune-req">${hasVet ? window.ClanValue.fmt(s.veteran) + " зол." : "не получена"}</div></div>`;

    // Шапка: ЦЕННОСТЬ-ЗОЛОТО (главное, крупно) + множитель + стрик + пик.
    const G = window.ClanValue;
    const header = `<div class="ach-hdr">
      <div class="ach-hstat ach-hstat-gold"><b class="val-gold">${G.coin()}${G.fmt(s.total)}</b><span>★ ценность клану (золото)</span></div>
      <div class="ach-hstat"><b style="color:#ffd866">×${mult.toFixed(2)}</b><span>множитель серии</span></div>
      <div class="ach-hstat"><b style="color:#57d982">${cur}<small> нед.</small></b><span>текущий стрик</span></div>
      <div class="ach-hstat"><b style="color:#ffc83c">×${peak.toFixed(1)}</b><span>лучший пик</span></div>
    </div>`;
    // Пояснение множителя (значения — золотом).
    const base = s.doblest_base; const val = s.doblest_value;
    const multLine = `<div class="ach-multline">⚜ Доблесть <span class="val-gold">${base == null ? "—" : G.fmt(base)}</span> ${base == null ? "" : `× <b style="color:#ffd866">${mult.toFixed(2)}</b> (стрик) = <span class="val-gold">${G.fmt(val)}</span> золота`}.
      ${cur > 0 ? `Серия ${cur} нед. усиливает вклад${avgCurOfs >= 0.24 ? " — мощная!" : ""}.` : "Стрика нет — множитель ×1. Перевыполняй норму подряд, чтобы он рос."}</div>`;
    // Из чего складывается ИТОГОВАЯ ценность клану (наглядно, золотом).
    const sumLine = `<div class="ach-sumline">
      <span class="ach-sum-t">Итог за неделю =</span>
      ⚔ доблесть <span class="val-gold">${G.fmt(val)}</span>
      <span class="ach-sum-op">+</span> ✠ офицерство <span class="val-gold">${G.fmt(s.officer)}</span>
      <span class="ach-sum-op">+</span> ✦ общительность <span class="val-gold">${G.fmt(s.social)}</span>
      <span class="ach-sum-op">+</span> ⭐ ветеран <span class="val-gold">${G.fmt(s.veteran)}</span>
      <span class="ach-sum-op">=</span> <span class="val-gold">${G.coin()}${G.fmt(s.total)}</span> золота</div>`;

    const rarLegend = RARITY_ORDER.map(k =>
      `<span class="ach-leg" style="color:${RARITY[k].color}">● ${RARITY[k].name}</span>`).join("");

    const ov = document.createElement("div");
    ov.id = "vedit-overlay";
    ov.className = "vedit-overlay";
    ov.innerHTML = `
      <div class="vedit-card wide ach-card ach-diablo" role="dialog" aria-modal="true">
        <div class="ach-topbar">
          <button id="ach-allroles" class="roles-guide-btn" type="button"
            title="Открыть полный список ролей клана"><span class="rgb-ic">✦</span>Посмотреть все доступные роли</button>
          <button id="vedit-cancel" class="vedit-btn">✕ Закрыть</button>
        </div>
        <div class="ach-scroll">
          <h3>🏆 Зал доблести · ${esc(m.nick)}</h3>
          ${header}
          ${multLine}
          ${sumLine}
          <div class="ach-legend">${rarLegend}</div>
          <div class="ach-sub">✓ открыто · ▶ следующая цель · 🔒 закрыто. Линии загораются по мере прокачки. Стрик-руны множат доблесть и сбрасываются при потере серии.</div>
          <div class="ach-sub ach-afk">💤 Статус АФК — это пауза: серия не рвётся за невыполнение нормы и предупреждений нет. Наберёшь норму снова — серия продолжится. Доблесть, набранная даже в АФК, идёт в зачёт.</div>
          <div class="ach-tree">
            ${branchValor(magRunes, strRunes, mult, s.doblest_base, s.doblest_value)}
            ${branchCol("✠ Офицерство", "Слабый множитель за посты", offRunes,
              multFooter(s.officer_mult, s.officer, s.is_cur_officer ? "офицер сейчас" : ""))}
            ${branchCol("✦ Общительность", "Из таблицы «Участники»", socRunes,
              multFooter(s.social_mult, s.social, (s.chat_msgs || 0) + " сообщ."))}
            ${vetBox}
          </div>
        </div>
      </div>`;
    document.body.appendChild(ov);
    ov.addEventListener("click", e => { if (e.target === ov) closeEditModal(); });
    ov.querySelector("#vedit-cancel").onclick = closeEditModal;
    ov.querySelector("#ach-allroles").onclick = () => openRoleGuide();
  }

  $("valor-tbody").addEventListener("click", (ev) => {
    const nb = ev.target.closest(".ach-btn");
    if (nb) {
      ev.stopPropagation();
      const m = (DATA.members || []).find(x => x.nick === nb.dataset.nick);
      if (m) openAchievements(m);
      return;
    }
    const dh = ev.target.closest(".dhist-btn");
    if (dh) {
      ev.stopPropagation();
      openDismissHistory(dh.dataset.canon, dh.dataset.nick);
    }
  });

  // ── Окно «История снятых предупреждений» ──
  const KIND_RU = { norm: "По нормативу", title: "Из титула", manual: "Ручное" };
  async function openDismissHistory(canon, nick) {
    let items = [];
    try {
      const res = await API.valorDismissedHistory(canon);
      items = (res && res.items) || [];
    } catch (e) { alert("Ошибка: " + (e.detail || e.message || e)); return; }
    injectEditStyles();
    const fmtDT = (s) => s ? String(s).replace("T", " ").slice(0, 16) + " UTC" : "—";
    const rows = items.length ? items.map((it) => {
      const d = it.detail || {};
      let what = "";
      if (it.kind === "norm") {
        what = `неделя ${esc(d.week || it.ref)}`;
        if (d.valor != null) what += ` · набрано ${esc(d.valor)} из ${esc(d.norm)} (${esc(d.pct)}%)`;
        if (d.grace) {
          what += ` · <span class="dh-grace">норматив снижен (иммунитет спал среди недели`;
          if (d.full_norm != null && d.full_norm !== d.norm)
            what += `: полный ${esc(d.full_norm)} → ${esc(d.norm)}`;
          what += `)</span>`;
        }
      } else if (it.kind === "title") {
        what = `цифра в титуле: ${esc(d.value != null ? d.value : it.ref)}` +
          (d.title ? ` (титул «${esc(d.title)}»)` : "");
      } else {
        what = esc(it.ref || "");
      }
      return `<tr>
        <td class="dh-kind">${esc(KIND_RU[it.kind] || it.kind)}</td>
        <td>${what}</td>
        <td class="dh-reason">${it.reason ? esc(it.reason) : "<span class='dh-norsn'>—</span>"}</td>
        <td>${esc(it.created_by || "—")}</td>
        <td class="dh-dt">${fmtDT(it.created_at)}</td>
      </tr>`;
    }).join("") : `<tr><td colspan="5" class="dh-empty">Снятых предупреждений нет</td></tr>`;
    const ov = document.createElement("div");
    ov.className = "vedit-overlay";
    ov.innerHTML =
      `<div class="vedit-card dh-card">
        <div class="dh-head">
          <h3>🕮 История снятых предупреждений · <b>${esc(nick || "")}</b></h3>
          <button id="dh-close" class="vedit-btn">✕ Закрыть</button>
        </div>
        <div class="dh-scroll">
          <table class="dh-table">
            <thead><tr><th>Тип</th><th>Что было</th><th>Причина</th><th>Кто снял</th><th>Когда сняли</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        ${items.length ? `<div class="dh-foot">${IS_ADMIN ? `<button id="dh-restore" class="vedit-btn">↩ Вернуть все предупреждения</button>` : ""}</div>` : ""}
      </div>`;
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
    ov.querySelector("#dh-close").onclick = close;
    const rb = ov.querySelector("#dh-restore");
    if (rb) rb.onclick = async () => {
      if (!confirm("Вернуть ВСЕ снятые предупреждения этому игроку?")) return;
      try { await API.valorWarningRestore(canon); close(); await load(); }
      catch (e) { alert("Ошибка: " + (e.detail || e.message || e)); }
    };
  }

  // Двойной клик по строке игрока → перейти к нему в «Скрины сбора»
  // (последняя неделя). Только офицер/админ; гостю недоступно.
  $("valor-tbody").addEventListener("dblclick", (ev) => {
    if (!IS_OFFICER) return;
    if (ev.target.closest("button") || ev.target.closest("input") ||
        ev.target.closest("a")) return;
    const tr = ev.target.closest("tr.m-row");
    if (!tr || !tr.dataset.canon) return;
    location.href = "valor-screens.html?focus=" + encodeURIComponent(tr.dataset.canon);
  });

  // Одинарный клик по строке игрока → подсветить её (выделение). Доступно всем:
  // помогает не потерять строку глазами в длинной таблице. Повторный клик по той
  // же строке снимает выделение. Не мешаем кнопкам/ссылкам/инпутам/чипам/иконкам.
  $("valor-tbody").addEventListener("click", (ev) => {
    if (ev.target.closest(
      "button, input, a, .tag-chip, .ach-btn, .dhist-btn, .tag-add-btn")) return;
    const tr = ev.target.closest("tr.m-row");
    if (!tr) return;
    const tb = $("valor-tbody");
    const already = tr.classList.contains("m-row-focus");
    tb.querySelectorAll(".m-row-focus").forEach(
      x => x.classList.remove("m-row-focus", "m-row-flash"));
    if (!already) tr.classList.add("m-row-focus");
  });

  $("valor-filter").addEventListener("input", () => {
    // Сбрасываем горизонтальную прокрутку влево, чтобы при поиске колонка
    // «Имя» не оставалась спрятанной под sticky-колонкой «Ник».
    const wrap = document.querySelector(".members-table-wrap");
    if (wrap) wrap.scrollLeft = 0;
    apply();
  });

  // Сортировка по клику заголовка
  document.querySelectorAll("th[data-sort]").forEach(th => {
    th.addEventListener("click", () => {
      const k = th.dataset.sort;
      if (SORT.key === k) {
        SORT.dir = SORT.dir === "asc" ? "desc" : "asc";
      } else {
        SORT.key = k;
        SORT.dir = th.dataset.dir || "asc";
      }
      apply();
    });
  });

  // Popover-история для полей rank/title/level/class
  // Tag-add / Tag-remove handlers
  $("valor-tbody").addEventListener("click", async (ev) => {
    if (IS_GUEST) return;   // гость не редактирует роли
    const addBtn = ev.target.closest(".tag-add-btn");
    if (addBtn) {
      ev.stopPropagation();
      const nick = addBtn.dataset.nick;
      const tag = (prompt(
        `Добавить роль для «${nick}»?\nНапример: veteran, core, leader`,
        "veteran") || "").trim();
      if (!tag) return;
      try {
        await fetch((window.OFFICERS_CONFIG?.API_URL || "")
                     + "/valor/tags",
          { method: "POST", credentials: "include",
            headers: { "Content-Type": "application/json",
              "Authorization": "Bearer " + (localStorage.getItem("officer_session_token") || "") },
            body: JSON.stringify({ nick, tag }) });
        await load();
      } catch (e) { alert("Ошибка: " + (e.message || e)); }
      return;
    }
    const tagChip = ev.target.closest(".tag-chip");
    if (tagChip && ev.shiftKey) {
      ev.stopPropagation();
      const nick = tagChip.dataset.nick;
      const tag = tagChip.dataset.tag;
      if (AUTO_TAGS.has(tag)) {
        alert(`«${tag}» — авто-роль, она вычисляется бэкендом ` +
              `(социалки / офицерство). Удалить нельзя.`);
        return;
      }
      if (!confirm(`Снять роль «${tag}» с «${nick}»?`)) return;
      try {
        const u = (window.OFFICERS_CONFIG?.API_URL || "")
          + "/valor/tags?nick=" + encodeURIComponent(nick)
          + "&tag=" + encodeURIComponent(tag);
        await fetch(u, { method: "DELETE", credentials: "include",
          headers: { "Authorization": "Bearer " + (localStorage.getItem("officer_session_token") || "") } });
        await load();
      } catch (e) { alert("Ошибка: " + (e.message || e)); }
      return;
    }
  });

  // ── Ручные предупреждения: добавление (+) и удаление (✕) ──
  let WARN_POP = null;
  function closeWarnAdd() { if (WARN_POP) { WARN_POP.remove(); WARN_POP = null; } }
  function openWarnAdd(btn, nick) {
    closeWarnAdd();
    const pop = document.createElement("div");
    pop.className = "warn-add-pop";
    pop.innerHTML =
      `<div class="wap-title">Ручное предупреждение: <b>${esc(nick)}</b></div>` +
      `<div class="wap-sev">` +
        `<button type="button" data-sev="light"  class="wchip wsev-light">лёгкое</button>` +
        `<button type="button" data-sev="mid"     class="wchip wsev-mid">среднее</button>` +
        `<button type="button" data-sev="severe"  class="wchip wsev-severe">суровое</button>` +
      `</div>` +
      `<input class="wap-reason" type="text" maxlength="200" ` +
        `placeholder="За что? (причина, необязательно)">` +
      `<div class="wap-actions">` +
        `<button type="button" class="wap-add">Добавить</button>` +
        `<button type="button" class="wap-cancel">Отмена</button>` +
      `</div>`;
    document.body.appendChild(pop);
    const r = btn.getBoundingClientRect();
    let left = r.left, top = r.bottom + 6;
    if (left + pop.offsetWidth > window.innerWidth - 8)
      left = window.innerWidth - pop.offsetWidth - 8;
    pop.style.left = Math.max(8, left) + "px";
    pop.style.top = top + "px";
    let sev = "mid";
    const sevBtns = pop.querySelectorAll(".wap-sev button");
    const selSev = (s) => { sev = s; sevBtns.forEach(b =>
      b.classList.toggle("wap-on", b.dataset.sev === s)); };
    selSev("mid");
    sevBtns.forEach(b => b.addEventListener("click", () => selSev(b.dataset.sev)));
    pop.querySelector(".wap-cancel").addEventListener("click", closeWarnAdd);
    pop.querySelector(".wap-add").addEventListener("click", async () => {
      const reason = pop.querySelector(".wap-reason").value.trim();
      try {
        await fetch((window.OFFICERS_CONFIG?.API_URL || "") + "/valor/warning",
          { method: "POST", credentials: "include",
            headers: { "Content-Type": "application/json",
              "Authorization": "Bearer " + (localStorage.getItem("officer_session_token") || "") },
            body: JSON.stringify({ nick, severity: sev, reason }) });
        closeWarnAdd(); await load();
      } catch (e) { alert("Ошибка: " + (e.message || e)); }
    });
    pop.querySelector(".wap-reason").focus();
    WARN_POP = pop;
  }
  document.addEventListener("click", (e) => {
    if (WARN_POP && !e.target.closest(".warn-add-pop")
        && !e.target.closest(".warn-add-btn")) closeWarnAdd();
  });

  $("valor-tbody").addEventListener("click", async (ev) => {
    if (IS_GUEST) return;   // гость не редактирует предупреждения
    const addB = ev.target.closest(".warn-add-btn");
    if (addB) {
      ev.stopPropagation();
      openWarnAdd(addB, addB.dataset.nick);
      return;
    }
    const delB = ev.target.closest(".warn-del-btn");
    if (delB) {
      ev.stopPropagation();
      if (!confirm("Снять последнее ручное предупреждение?")) return;
      try {
        await fetch((window.OFFICERS_CONFIG?.API_URL || "")
          + "/valor/warning?id=" + encodeURIComponent(delB.dataset.id),
          { method: "DELETE", credentials: "include",
            headers: { "Authorization": "Bearer " + (localStorage.getItem("officer_session_token") || "") } });
        await load();
      } catch (e) { alert("Ошибка: " + (e.message || e)); }
      return;
    }
    // «Простить» авто-предупреждение по нормативу или из титула.
    const disB = ev.target.closest(".warn-dismiss-btn");
    if (disB) {
      ev.stopPropagation();
      const kind = disB.dataset.kind;
      const msg = kind === "title"
        ? "Снять предупреждение из титула у этого игрока?\n\nПричина снятия (необязательно):"
        : "Снять ВСЕ текущие предупреждения по нормативу у этого игрока?\n\nПричина снятия (необязательно):";
      const reason = prompt(msg, "");
      if (reason === null) return;   // отмена
      try {
        await API.valorWarningDismiss(disB.dataset.canon, kind, reason.trim());
        await load();
      } catch (e) { alert("Ошибка: " + (e.detail || e.message || e)); }
      return;
    }
  });

  // ── Статус АФК: дать/снять + комментарий (офицер/админ) ──
  function afkBtn(m) {
    if (!IS_OFFICER) return "";
    return ` <button class="afk-set-btn" data-id="${m.id}" ` +
      `data-afk="${m.is_afk ? 1 : 0}" data-note="${esc(m.afk_note || "")}" ` +
      `data-nick="${esc(m.nick)}" title="${m.is_afk ? "Снять АФК / изменить комментарий" : "Дать статус АФК (с комментарием)"}">💤</button>`;
  }
  let AFK_POP = null;
  function closeAfkPop() { if (AFK_POP) { AFK_POP.remove(); AFK_POP = null; } }
  function openAfkPop(btn) {
    closeAfkPop();
    const id = btn.dataset.id, nick = btn.dataset.nick;
    const cur = btn.dataset.afk === "1";
    const note = btn.dataset.note || "";
    const pop = document.createElement("div");
    pop.className = "warn-add-pop";
    pop.innerHTML =
      `<div class="wap-title">Статус АФК: <b>${esc(nick)}</b></div>` +
      `<label style="display:flex;align-items:center;gap:8px;margin:6px 0;color:#cfe;font-size:13px;cursor:pointer">` +
        `<input type="checkbox" class="afk-chk" ${cur ? "checked" : ""} style="transform:scale(1.3)"> в статусе АФК</label>` +
      `<input class="afk-note-inp" type="text" maxlength="200" value="${esc(note)}" ` +
        `placeholder="причина / до какого числа (напр. «отпуск до 20.07»)">` +
      `<div class="wap-actions">` +
        `<button type="button" class="wap-add">Сохранить</button>` +
        `<button type="button" class="wap-cancel">Отмена</button>` +
      `</div>`;
    document.body.appendChild(pop);
    const r = btn.getBoundingClientRect();
    let left = r.left;
    if (left + pop.offsetWidth > window.innerWidth - 8)
      left = window.innerWidth - pop.offsetWidth - 8;
    pop.style.left = Math.max(8, left) + "px";
    pop.style.top = (r.bottom + 6) + "px";
    pop.querySelector(".wap-cancel").addEventListener("click", closeAfkPop);
    pop.querySelector(".wap-add").addEventListener("click", async () => {
      const is_afk = pop.querySelector(".afk-chk").checked;
      const afk_note = pop.querySelector(".afk-note-inp").value.trim();
      try {
        const res = await fetch((window.OFFICERS_CONFIG?.API_URL || "") + "/valor/afk/" + id,
          { method: "POST", credentials: "include",
            headers: { "Content-Type": "application/json",
              "Authorization": "Bearer " + (localStorage.getItem("officer_session_token") || "") },
            body: JSON.stringify({ is_afk, afk_note }) });
        if (!res.ok) throw new Error("HTTP " + res.status);
        closeAfkPop(); await load();
      } catch (e) { alert("Ошибка: " + (e.message || e)); }
    });
    pop.querySelector(".afk-note-inp").focus();
    AFK_POP = pop;
  }
  document.addEventListener("click", (e) => {
    if (AFK_POP && !e.target.closest(".warn-add-pop")
        && !e.target.closest(".afk-set-btn")) closeAfkPop();
  });
  $("valor-tbody").addEventListener("click", (ev) => {
    const b = ev.target.closest(".afk-set-btn");
    if (!b || !IS_OFFICER) return;
    ev.stopPropagation();
    openAfkPop(b);
  });

  // ── Красивый тултип предупреждений (в стиле сайта) ──
  let WTIP = null, WTIP_EL = null;
  function hideWtip() { if (WTIP) { WTIP.remove(); WTIP = null; } WTIP_EL = null; }
  function showWtip(el) {
    const txt = el.getAttribute("data-wtip");
    if (!txt) return;
    hideWtip();
    // Цвет первой строки = по типу/суровости чипа.
    let tier = "";
    if (el.classList.contains("wsev-light")) tier = " wtip-light";
    else if (el.classList.contains("wsev-mid")) tier = " wtip-mid";
    else if (el.classList.contains("wsev-severe") ||
             el.classList.contains("wtype-title")) tier = " wtip-severe";
    const p = document.createElement("div");
    p.className = "wtip-pop" + tier;
    p.innerHTML = txt.split("\n")
      .map((l, i) => i === 0 ? `<b>${esc(l)}</b>` : esc(l)).join("<br>");
    // Индивидуальный цвет (роли): рамка + заголовок + тень в тон роли.
    const col = el.getAttribute("data-wtipcolor");
    if (col) {
      p.style.borderColor = col;
      p.style.boxShadow = `0 4px 22px ${col}3a, 0 0 50px rgba(0,0,0,0.7)`;
      const bEl = p.querySelector("b");
      if (bEl) bEl.style.color = col;
    }
    document.body.appendChild(p);
    const r = el.getBoundingClientRect();
    const m = 8;
    let left = r.left + r.width / 2 - p.offsetWidth / 2;
    let top = r.bottom + 7;
    if (left < m) left = m;
    if (left + p.offsetWidth > window.innerWidth - m)
      left = window.innerWidth - p.offsetWidth - m;
    if (top + p.offsetHeight > window.innerHeight - m && r.top - p.offsetHeight - 7 > m)
      top = r.top - p.offsetHeight - 7;
    p.style.left = Math.round(left) + "px";
    p.style.top = Math.round(top) + "px";
    WTIP = p; WTIP_EL = el;
  }
  $("valor-tbody").addEventListener("mouseover", (e) => {
    const c = e.target.closest("[data-wtip]");
    if (c && c !== WTIP_EL) showWtip(c);
  });
  $("valor-tbody").addEventListener("mouseout", (e) => {
    const c = e.target.closest("[data-wtip]");
    if (c && !c.contains(e.relatedTarget)) hideWtip();
  });
  window.addEventListener("scroll", hideWtip, true);

  // History popover (по клику на ячейки с историей)
  $("valor-tbody").addEventListener("click", async (ev) => {
    const cell = ev.target.closest(".hist-cell");
    if (!cell) return;
    const tr = cell.closest("tr");
    const nick = tr.dataset.nick;
    const field = cell.dataset.field;
    const fieldLabel = {rank:"должности", title:"титула",
                         level:"уровня", class:"класса",
                         valor:"доблести"}[field];
    closePopover();
    const popover = document.createElement("div");
    popover.className = "valor-popover";
    const wideClass = field === "valor" ? " valor-history" : "";
    popover.className += wideClass;
    popover.innerHTML = `<div class="hl">История ${fieldLabel}
      <b>${esc(nick)}</b></div><div class="body">Загрузка…</div>`;
    document.body.appendChild(popover);
    const r = cell.getBoundingClientRect();
    popover.style.top  = (window.scrollY + r.bottom + 4) + "px";
    popover.style.left = (window.scrollX + r.left)        + "px";
    try {
      const data = await API.valorHistory(nick, field);
      const hist = (data[field] || []).slice();
      if (!hist.length) {
        popover.querySelector(".body").textContent = "(пусто)";
      } else if (field === "valor") {
        // Биржевой вид: дата | значение | Δ | %
        // hist приходит от backend ORDER BY week DESC. Развернём для
        // расчёта дельт от предыдущей недели и снова показ desc.
        const asc = hist.slice().reverse();  // самая ранняя сверху
        for (let i = 0; i < asc.length; i++) {
          const cur = parseInt(asc[i].value, 10);
          const prev = i > 0 ? parseInt(asc[i-1].value, 10) : null;
          asc[i]._val = isNaN(cur) ? null : cur;
          if (prev != null && !isNaN(prev) && asc[i]._val != null) {
            asc[i]._delta = asc[i]._val - prev;
            asc[i]._pct = prev === 0
              ? null
              : Math.round((asc[i]._delta / prev) * 1000) / 10;
          } else {
            asc[i]._delta = null;
            asc[i]._pct = null;
          }
        }
        const desc = asc.slice().reverse();  // newest first
        const max = Math.max(1, ...asc.map(h => h._val || 0));
        popover.querySelector(".body").innerHTML = `
          <div class="vh-head">
            <span>неделя</span>
            <span>доблесть</span>
            <span>Δ</span>
            <span>%</span>
          </div>
          ${desc.map(h => {
            const cls = h._delta == null ? "n"
              : h._delta > 0 ? "u" : h._delta < 0 ? "d" : "f";
            const sign = h._delta > 0 ? "+" : "";
            const pctTxt = h._pct == null ? ""
              : `${sign}${h._pct}%`;
            const dTxt = h._delta == null ? ""
              : `${sign}${h._delta}`;
            const pct = h._val == null ? 0
              : Math.round((h._val / max) * 100);
            return `
              <div class="vh-row vh-${cls}">
                <span class="w">${esc(h.week)}</span>
                <span class="v">${h._val ?? "—"}</span>
                <span class="d">${dTxt}</span>
                <span class="p">${pctTxt}</span>
                <div class="bar" style="width:${pct}%"></div>
              </div>`;
          }).join("")}
        `;
      } else {
        popover.querySelector(".body").innerHTML = hist.map(h => `
          <div class="row"><span class="w">${esc(h.week)}</span>
            <span class="v">${esc(h.value || "—")}</span></div>
        `).join("");
      }
    } catch (e) {
      const dt = e.detail;
      const msg = (typeof dt === "string" ? dt
                   : typeof dt === "object" ? JSON.stringify(dt)
                   : e.message);
      popover.querySelector(".body").textContent = "Ошибка: " + msg;
    }
  });

  function closePopover() {
    const old = document.querySelector(".valor-popover");
    if (old) old.remove();
  }
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".valor-popover") &&
        !e.target.closest(".hist-cell")) closePopover();
  });

  // ── Timeline-график доблести ──
  let CHART = null;
  let TL_RAW = null;

  async function loadTimeline() {
    $("tl-loading").hidden = false;
    try {
      const weeks = +$("tl-weeks").value || 12;
      TL_RAW = await API.valorTimeline(weeks);
      renderTimeline();
    } catch (e) {
      $("tl-stats").innerHTML =
        `<span style="color:#ff8080">Ошибка timeline: ${esc(e.detail || e.message)}</span>`;
    } finally {
      $("tl-loading").hidden = true;
    }
  }

  function pickColor(i, n) {
    const hue = Math.round((i / Math.max(1, n)) * 320);
    return `hsl(${hue} 70% 60%)`;
  }

  function renderTimeline() {
    if (!TL_RAW || !TL_RAW.periods.length) {
      $("tl-stats").innerHTML =
        `<span>график появится со следующего снапшота</span>`;
      if (CHART) { CHART.destroy(); CHART = null; }
      $("tl-legend").innerHTML = "";
      return;
    }
    const top = +$("tl-topn").value;
    const q = ($("tl-filter").value || "").trim().toLowerCase();
    let series = TL_RAW.series.slice();
    if (q) {
      series = series.filter(s =>
        (s.nick + " " + (s.true_name || "")).toLowerCase().includes(q));
    }
    if (top > 0) series = series.slice(0, top);

    $("tl-stats").innerHTML = `
      <span>недель: <b>${TL_RAW.periods.length}</b></span>
      <span>в графике: <b>${series.length}</b></span>
      <span>всего сокланов на графике: <b>${TL_RAW.overall.people}</b></span>
      <span>сумма доблести: <b>${TL_RAW.overall.total}</b></span>
    `;

    // Линия СУММЫ доблести всего клана по неделям (по ВСЕМ сокланам,
    // не зависит от фильтра/топ-N) — на отдельной правой оси.
    const clanTotals = (TL_RAW.overall && TL_RAW.overall.week_totals) || [];
    const totalDs = clanTotals.length ? [{
      label: "🏆 Сумма по клану",
      data: clanTotals,
      borderColor: "#ffd24a",
      backgroundColor: "rgba(255,210,74,0.12)",
      borderWidth: 3, tension: 0.2, pointRadius: 4, pointHoverRadius: 7,
      yAxisID: "yTotal", fill: true, order: 99,
    }] : [];

    const ctx = $("tl-canvas").getContext("2d");
    if (CHART) CHART.destroy();
    CHART = new Chart(ctx, {
      type: "line",
      data: {
        labels: TL_RAW.periods,
        datasets: totalDs.concat(series.map((s, i) => ({
          label: s.nick + (s.true_name ? "  ·  " + s.true_name : ""),
          data: s.counts,
          borderColor: pickColor(i, series.length),
          backgroundColor: pickColor(i, series.length),
          tension: 0.2,
          pointRadius: 3,
          pointHoverRadius: 6,
          yAxisID: "y",
        }))),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "nearest", axis: "x", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: { mode: "index", intersect: false },
        },
        scales: {
          x: { ticks: { color: "#a0a0a0" }, grid: { color: "rgba(255,255,255,0.03)" } },
          y: { ticks: { color: "#a0a0a0" }, grid: { color: "rgba(255,255,255,0.05)" },
                beginAtZero: true,
                title: { display: true, text: "доблесть игрока", color: "#7a8a7a" } },
          yTotal: { position: "right", beginAtZero: true,
                ticks: { color: "#ffd24a" }, grid: { drawOnChartArea: false },
                title: { display: true, text: "сумма по клану", color: "#ffd24a" } },
        },
      },
    });
    // Своя легенда — кликабельная (toggle dataset). data-i = индекс датасета
    // в графике (с учётом линии суммы, которая идёт первой).
    const off = totalDs.length;   // 0 или 1
    const totalLeg = off ? `<span class="leg-item leg-total" data-i="0"
        style="color:#ffd24a;font-weight:700">🏆 Сумма по клану <small>(${TL_RAW.overall.total})</small></span>` : "";
    $("tl-legend").innerHTML = totalLeg + series.map((s, i) => `
      <span class="leg-item" data-i="${i + off}" style="color:${pickColor(i, series.length)}"
        >● ${esc(s.nick)}${s.true_name ? " · " + esc(s.true_name) : ""}
        <small>(${s.total})</small></span>
    `).join(" ");
    // Клик по элементу легенды = показать ТОЛЬКО его (изоляция). Повторный
    // клик по нему же — вернуть все линии. Так можно смотреть и отдельного
    // человека, и «Сумма по клану» отдельно.
    const legItems = [...$("tl-legend").querySelectorAll(".leg-item")];
    let isoI = null;
    const applyIso = () => {
      CHART.data.datasets.forEach((ds, di) => {
        CHART.getDatasetMeta(di).hidden = (isoI !== null && di !== isoI);
      });
      legItems.forEach(el => {
        const sel = isoI !== null && +el.dataset.i === isoI;
        el.classList.toggle("leg-on", sel);                       // выбранный — подсветка
        el.classList.toggle("leg-off", isoI !== null && !sel);    // остальные — серые
      });
      CHART.update();
    };
    legItems.forEach(el => {
      el.addEventListener("click", () => {
        const i = +el.dataset.i;
        isoI = (isoI === i) ? null : i;
        applyIso();
      });
    });
  }

  $("tl-weeks").addEventListener("change", loadTimeline);
  $("tl-topn").addEventListener("change", renderTimeline);
  $("tl-filter").addEventListener("input", renderTimeline);
  const csBtn = document.getElementById("combined-stats-btn");
  if (csBtn) csBtn.addEventListener("click", () => window.CombinedStats.open());

  // ── Departed ────────────────────────────────────────────────────
  let DEPARTED = [];
  async function loadDeparted() {
    try {
      DEPARTED = await API.valorDeparted();
    } catch (e) {
      DEPARTED = [];
    }
    $("dep-count").textContent =
      DEPARTED.length ? `(${DEPARTED.length})` : "(никого)";
    if (!DEPARTED.length) return;
    $("dep-tbody").innerHTML = DEPARTED.map(d => `
      <tr class="m-row">
        <td><b>${esc(d.nick)}</b></td>
        <td>${esc(d.true_name)}</td>
        <td>${esc(d.last_week)}</td>
        <td>${esc(d.last_rank)}</td>
        <td>${esc(d.last_title)}</td>
        <td class="m-cell-num">${d.last_level ?? ""}</td>
        <td>${esc(d.last_class)}</td>
        <td class="m-cell-num">${d.last_valor ?? ""}</td>
        <td class="m-cell-num">
          ${(d.warning_count || 0) > 0
            ? `<span class="warn-badge">⚠ ${d.warning_count}</span>`
            : '—'}
        </td>
        ${IS_ADMIN
          ? `<td><button class="dep-restore" data-canon="${esc(d.nick_canon)}" data-nick="${esc(d.nick)}" title="↩ Вернуть в основной список — если игрок ушёл/был кикнут по ошибке. Вернётся, если он есть в текущем снимке.">↩ вернуть</button></td>`
          : ""}
      </tr>
    `).join("");
  }

  // Восстановление из архива (только админ).
  $("dep-tbody").addEventListener("click", async (ev) => {
    const b = ev.target.closest(".dep-restore");
    if (!b || !IS_ADMIN) return;
    if (!confirm(`Вернуть «${b.dataset.nick}» из архива в основной список?`)) return;
    try {
      await adminCall("POST", "/valor/restore", { canon: b.dataset.canon });
      await load(); await loadDeparted();
    } catch (_) { /* alert уже показан */ }
  });

  $("dep-toggle").addEventListener("click", () => {
    const w = $("dep-wrap");
    const open = w.style.display !== "none";
    w.style.display = open ? "none" : "block";
    $("dep-arrow").textContent = open ? "▶" : "▼";
  });

  // Баннер «сервер недоступен» — повтор без перезагрузки страницы.
  const netRetry = $("net-retry");
  if (netRetry) netRetry.addEventListener("click", () => {
    showNetBanner(false);
    loadMe();
    load().then(() => { loadTimeline(); loadDeparted(); });
  });

  loadMe().then(() => {
    if (IS_ADMIN) injectAdminHelp();
    apply();          // перерисовать с учётом роли (no-op если данные не готовы)
    loadDeparted();   // обновить архив с кнопками «вернуть»
  });
  load().then(() => { apply(); loadTimeline(); loadDeparted(); });
})();
