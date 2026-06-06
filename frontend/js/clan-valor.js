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
    const who = me?.role === "admin"
      ? `${esc(me.username || me.name || "")} · админ`
      : `${esc(me.username || me.name || "")} · офицер`;
    $("who").textContent = who;
    if (me.role !== "admin") {
      document.querySelectorAll(".admin-only").forEach(el =>
        el.style.display = "none");
    }
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
    veteran:    { label: "Ветеран", icon: "★", color: "#ffd24a",
                  cls: "tag-veteran",
                  tip: "Был в первоначальном составе клана." },
    in_socials: { label: "В соцсетях", icon: "◉", color: "#b88dff",
                  cls: "tag-socials",
                  tip: "Состоит в VK или Telegram клана." },
    officer:    { label: "Офицер", icon: "✦", color: "#ff9a44",
                  cls: "tag-officer",
                  tip: "Занимал офицерский пост (Лейтенант и выше)." },
  };
  // Авто-теги нельзя удалить вручную — они вычисляются на бэкенде.
  // Семейства ролей-достижений за доблесть.
  const FLAW_TAGS  = new Set(["immortal", "legend", "ace", "etalon"]);
  const COMBO_TAGS = new Set(["combo_legend", "combo_record", "combo_over"]);
  const PEAK_TAGS  = new Set(["absolute", "overlord", "titan", "phenom",
                               "record", "triple", "double", "over"]);
  const AUTO_TAGS = new Set([
    "in_socials", "officer",
    ...FLAW_TAGS, ...COMBO_TAGS, ...PEAK_TAGS]);
  // Источник множителя ×N для каждого семейства (из m.compliance).
  function tagMult(t, c) {
    if (!c) return 0;
    if (PEAK_TAGS.has(t))  return c.peak_ratio || 0;
    if (COMBO_TAGS.has(t)) return c.combo_geo || 0;
    if (FLAW_TAGS.has(t))  return c.geomean_all || 0;
    return 0;
  }

  function renderTags(m) {
    const tags = m.tags || [];
    const btn = `<button class="tag-add-btn" data-nick="${esc(m.nick)}"
      title="Добавить роль">+</button>`;
    if (!tags.length) return `<div class="tag-row">${btn}</div>`;
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
      let tip = `${meta.label}${showMult ? " ×" + mult.toFixed(1) : ""}\n${meta.tip}`;
      if (t === "officer" && m.top_rank) tip += ` Макс. пост: ${m.top_rank}.`;
      // Когда роль получена — только в тултипе, с расшифровкой недели в дату.
      let whenTip = "";
      if (isAch && c) {
        if (PEAK_TAGS.has(t) && c.peak_week)
          whenTip = weekFull(c.peak_week);
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
      // Достижения — инлайн-цвет по роли (+ свечение у топовых).
      let style = "";
      if (isAch && meta.color) {
        const col = meta.color;
        style = ` style="color:${col};border-color:${col};background:${col}1f;` +
                (meta.glow ? `box-shadow:0 0 9px ${col}66;` : ``) + `"`;
      }
      const wcol = meta.color ? ` data-wtipcolor="${meta.color}"` : "";
      return `<span class="tag-chip ${meta.cls}${auto}"${style} data-wtip="${esc(tip)}"${wcol}
        data-nick="${esc(m.nick)}" data-tag="${esc(t)}"
        ><span class="ic">${meta.icon}</span>${esc(meta.label)}${multHtml}</span>`;
    }).join("");
    return `<div class="tag-row">${chips}${btn}</div>`;
  }

  // ── Гайд «Все доступные роли» ──────────────────────────────────────
  // Как получить каждую роль (понятным языком). Пороги совпадают с
  // расчётом на бэкенде (db.py) и тултипами TAG_META.
  const ROLE_HOWTO = {
    etalon:   "Пройди минимум 3 учтённых недели и не провали ни одной нормы доблести. База «безупречной истории».",
    ace:      "Безупречная история (без провалов) + в среднем за неделю набираешь ≥ 1.4× нормы.",
    legend:   "Безупречная история + средняя кратность набора ≥ 2× нормы.",
    immortal: "Безупречная история + средняя кратность ≥ 3× нормы. Вершина дисциплины клана.",
    combo_over:   "Перевыполни норму (≥ 1.5×) три недели подряд и дольше.",
    combo_record: "Серия ≥ 3 недель подряд со средней кратностью серии ≥ 2×.",
    combo_legend: "Серия ≥ 3 недель подряд со средней кратностью серии ≥ 3×.",
    over:     "Набери за неделю ≥ 1.5× нормы.",
    double:   "Набери за неделю ≥ 2× нормы.",
    triple:   "Набери за неделю ≥ 3× нормы.",
    record:   "Лучшая неделя ≥ 4× нормы.",
    phenom:   "Лучшая неделя ≥ 5.5× нормы.",
    titan:    "Лучшая неделя ≥ 7× нормы.",
    overlord: "Лучшая неделя ≥ 9.5× нормы.",
    absolute: "Лучшая неделя ≥ 13× нормы (≈ 189 доблести) — почти технический потолок.",
    veteran:    "Состоял в клане с момента основания. Роль присваивает офицер вручную.",
    officer:    "Занимал офицерский пост — Лейтенант или выше. Начисляется автоматически по истории должностей.",
    in_socials: "Вступи в VK- или Telegram-сообщество клана и привяжи аккаунт через бота регистрации — роль появится сама.",
  };

  // Структура гайда: группы → ветки → роли (по возрастанию престижа).
  const ROLE_GUIDE = [
    { group: "Достижения за доблесть", icon: "🏆",
      gintro: "Начисляются автоматически по истории доблести. Внутри каждой ветки роли идут по возрастанию — выше стоит более редкая и престижная. Цвет и свечение чипа отражают силу достижения.",
      sub: [
        { title: "Ветка «Безупречная история»",
          note: "Считается, когда у тебя нет ни одного провала норматива (с 3-й учтённой недели). Ступень зависит от средней кратности набора за всё время.",
          tags: ["etalon", "ace", "legend", "immortal"] },
        { title: "Ветка «Серии перевыполнений»",
          note: "Считается за перевыполнение нормы (≥ 1.5×) несколько недель подряд. Ступень — по средней кратности самой длинной серии.",
          tags: ["combo_over", "combo_record", "combo_legend"] },
        { title: "Ветка «Сила одного пика»",
          note: "Считается по лучшей отдельной неделе — во сколько раз перекрыта норма. Достаточно один раз достичь порога.",
          tags: ["over", "double", "triple", "record", "phenom", "titan", "overlord", "absolute"] },
      ] },
    { group: "Статусные роли", icon: "🛡",
      gintro: "Не зависят от доблести — отмечают место человека в клане.",
      flat: ["veteran", "officer", "in_socials"] },
  ];

  // Чип роли — РОВНО как в таблице (renderTags): достижениям инлайн-цвет +
  // свечение, статусным — их CSS-классы; авто-теги получают пунктир.
  function guideChip(t) {
    const meta = TAG_META[t] || { label: t, icon: "·", cls: "tag-default", tip: t };
    const isAch = meta.cls && meta.cls.indexOf("tag-ach") >= 0;
    let style = "";
    if (isAch && meta.color) {
      const col = meta.color;
      style = ` style="color:${col};border-color:${col};background:${col}1f;` +
              (meta.glow ? `box-shadow:0 0 9px ${col}66;` : ``) + `"`;
    }
    const auto = AUTO_TAGS.has(t) ? " tag-auto" : "";
    return `<span class="tag-chip ${meta.cls}${auto}"${style}` +
      `><span class="ic">${meta.icon}</span>${esc(meta.label)}</span>`;
  }

  function guideRows(tags) {
    return tags.map((t) =>
      `<div class="rg-row">` +
        `<div class="rg-chip">${guideChip(t)}</div>` +
        `<div class="rg-how">${esc(ROLE_HOWTO[t] || (TAG_META[t] || {}).tip || "")}</div>` +
      `</div>`).join("");
  }

  function buildRoleGuide() {
    let html =
      `<div class="rg-head"><span>✦ Все доступные роли клана</span>` +
      `<button class="rg-close" type="button" aria-label="Закрыть">✕</button></div>` +
      `<div class="rg-body">` +
      `<p class="rg-intro">Роли показываются в столбце «Роли» у каждого участника. ` +
      `Достижения за доблесть начисляются <b>автоматически</b> по истории набора, ` +
      `статусные — по составу клана и должности. Ниже — все роли по возрастанию ` +
      `престижа и как получить каждую.</p>`;
    ROLE_GUIDE.forEach((g) => {
      html += `<section class="rg-group">` +
        `<h3 class="rg-gtitle">${esc(g.icon)} ${esc(g.group)}</h3>`;
      if (g.gintro) html += `<p class="rg-gintro">${esc(g.gintro)}</p>`;
      const subs = g.sub || [{ tags: g.flat }];
      subs.forEach((s) => {
        if (s.title) html += `<h4 class="rg-stitle">${esc(s.title)}</h4>`;
        if (s.note)  html += `<p class="rg-snote">${esc(s.note)}</p>`;
        html += `<div class="rg-list">${guideRows(s.tags)}</div>`;
      });
      html += `</section>`;
    });
    return html + `</div>`;
  }

  let RG_OVERLAY = null;
  function rgEsc(e) { if (e.key === "Escape") closeRoleGuide(); }
  function closeRoleGuide() {
    if (RG_OVERLAY) { RG_OVERLAY.remove(); RG_OVERLAY = null; }
    document.removeEventListener("keydown", rgEsc);
  }
  function openRoleGuide() {
    if (RG_OVERLAY) return;
    RG_OVERLAY = document.createElement("div");
    RG_OVERLAY.className = "rg-overlay";
    const modal = document.createElement("div");
    modal.className = "rg-modal";
    modal.innerHTML = buildRoleGuide();
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
    const officerLine = s.top_rank
      ? `• офицер: ${s.officer} / 14 (макс: ${s.top_rank}` +
        (s.cur_rank && s.cur_rank !== s.top_rank
          ? `, сейчас: ${s.cur_rank}` : ``) + `)`
      : `• офицер: 0 / 14`;
    // Иммунные — доблесть не оценивается, score нормализован к /100
    const compLine = s.compliance == null
      ? `• доблесть: не оценивается (иммунитет)`
      : `• доблесть: ${s.compliance} / 60`;
    const disc = s.discipline || 0;
    const ofMax = s.overfulfill_max || 20;
    const headLine = s.immunity_adjusted
      ? `Итог: ~${s.total} / 100 (норм. из ${s.raw_total} / ${s.max})\n` +
         `Иммунитет: доблесть исключена из оценки.\n`
      : disc > 0
        ? `Итог: ${s.total} / 100  (база ${s.raw_total} + перевыполнение ${disc})\n`
        : `Итог: ${s.total} / 100\n`;
    // Порядок — по ценности: доблесть ≫ ПЕРЕВЫПОЛНЕНИЕ > ветеран > офицер >
    // соцсети ≈ чаты. Перевыполнение — второй по значимости (бонус сверх 100).
    const discLine = disc > 0
      ? `• перевыполнение: +${disc} / ${ofMax} (сверх нормы ` +
        `${Math.round(s.over_avg || 0)}% · серия ${s.max_streak || 0} нед.)\n`
      : "";
    const tip = headLine
      + compLine + "\n"
      + discLine
      + `• ветеран: ${s.veteran} / 16\n`
      + officerLine + "\n"
      + `• соцсети: ${s.socials} / 5\n`
      + `• чаты: ${s.chat} / 5 (${s.chat_msgs} сообщ.)`;
    // Иммунные — «*»; выдающиеся (>100 за счёт перевыполнения) — «★».
    const star = s.immunity_adjusted
      ? `<small class="imm-mark" title="скор нормализован — без компонента доблести">*</small>`
      : (!s.immunity_adjusted && s.total > 100)
        ? `<small class="disc-mark" title="перевыполнение доблести сверх нормы">★</small>`
        : "";
    return `<span class="norm-cell score-cell ${cls}" title="${esc(tip)}"
      ><b>${s.total}</b>${star}<small style="opacity:0.7">/100</small></span>`;
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
      if (a && a.weeks) {
        const g = a.valor_gained;
        // Доблесть, набранная за время АФК: + (рос даже в АФК), 0, или —.
        let gainHtml = "", gainTip;
        if (g == null) {
          gainTip = "Доблесть за время АФК: нет данных.";
        } else if (g > 0) {
          gainHtml = ` · <b style="color:#7CFC00">+${g}</b>`;
          gainTip = `Набрал(а) доблесть даже в АФК: +${g} ` +
            `(с ${a.valor_start} до ${a.valor_now}).`;
        } else {
          gainHtml = ` · <b style="color:#888">0</b>`;
          gainTip = `Доблесть за время АФК не росла (${a.valor_now}).`;
        }
        let tip = `АФК ${a.weeks} нед. (с ${a.since_week}). Норматив не ` +
          `оценивается.\n${gainTip}`;
        if (a.weekly && a.weekly.length) {
          // Понедельно: сколько набрал ЗА эту неделю АФК (дельта) + накоплено.
          tip += "\nНабор по неделям АФК:";
          for (const w of a.weekly) {
            const dl = w.gained == null
              ? "—"
              : (w.gained > 0 ? `+${w.gained}` : `${w.gained}`);
            tip += `\n  ${w.week}: ${dl}  (всего ${w.valor == null ? "—" : w.valor})`;
          }
        }
        return `<span class="norm-cell norm-afk" title="${esc(tip)}"
          >АФК · ${a.weeks} нед.${gainHtml}</span>`;
      }
      return `<span class="norm-cell norm-afk"
        title="АФК — норматив не оценивается">АФК</span>`;
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
    // Норматив — суровость по худшей неделе; в тултипе — недели с датами
    if (ws.length) {
      const worstW = ws.reduce((a, b) => (b.pct < a.pct ? b : a));
      const sorted = ws.slice().sort((a, b) => (a.week < b.week ? -1 : 1));
      const detail = sorted.map((w) =>
        `${weekFull(w.week)}\n  ${w.valor}/${w.norm} = ${w.pct}%`).join("\n");
      const sev = sev3(worstW.pct);
      chips.push(warnChip("wsev-" + sev, ws.length,
        `${sevTitle(sev)}\nНорматив не выполнен\n${detail}`));
    }
    // Титул — строгий цвет; в тултипе — неделя проставления с датой
    if (tw) {
      const since = m.title_warn_since;
      chips.push(warnChip("wtype-title", tw,
        `Предупреждение в титуле\nВыставлено руководством гильдии` +
        (since ? `\nОтмечено: ${weekFull(since)}` : ``)));
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
      const del = ` <button class="warn-del-btn" data-id="${latest.id}" ` +
        `title="Снять последнее ручное">✕</button>`;
      chips.push(warnChip("wsev-" + worstSev, manual.length,
        `${sevTitle(worstSev)}\nРучное (от офицера)\n${detail}`,
        { manual: true, extra: del }));
    }
    const addBtn = `<button class="warn-add-btn" data-nick="${esc(m.nick)}" ` +
      `title="Добавить ручное предупреждение">+</button>`;
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
        const hay = [m.nick, m.true_name, m.rank, m.title, m.class_]
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
      const editBtn = IS_ADMIN
        ? ` <button class="row-edit-btn" data-edit-id="${m.id}" title="Редактировать строку (админ)">✎</button>`
        : "";
      return `
        <tr class="${rowCls}" data-nick="${esc(m.nick)}">
          <td class="m-cell-idx">${i + 1}</td>
          <td class="m-cell-name"><b>${esc(m.nick)}</b>${aiMark}${editBtn}</td>
          <td>${esc(m.true_name)}</td>
          <td class="socials-cell">${socialCell}</td>
          <td class="hist-cell" data-field="rank">${esc(m.rank)}</td>
          <td class="hist-cell" data-field="title">${renderTitle(m)}</td>
          <td class="m-cell-num hist-cell" data-field="level">${m.level ?? ""}</td>
          <td class="hist-cell" data-field="class">${esc(cls)}</td>
          <td class="m-cell-num m-cell-total">${valorCell}</td>
          <td class="m-cell-num">${normLabel}</td>
          <td class="m-cell-num">${compLabel}</td>
          <td class="m-cell-warn">${warnCell}</td>
          <td class="m-cell-num">${trendCell}</td>
          <td class="tags-cell">${renderTags(m)}</td>
          <td class="m-cell-num">${renderScore(m.score)}</td>
        </tr>`;
    }).join("");
    $("valor-tbody").innerHTML = rows;
    // Стрелки сортировки
    document.querySelectorAll("th[data-sort]").forEach(th => {
      th.classList.remove("sort-asc", "sort-desc");
      if (th.dataset.sort === SORT.key)
        th.classList.add(SORT.dir === "asc" ? "sort-asc" : "sort-desc");
    });
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
      .vedit-save:disabled{opacity:.5;cursor:default}`;
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
  $("valor-tbody").addEventListener("click", (ev) => {
    const eb = ev.target.closest(".row-edit-btn");
    if (!eb || !IS_ADMIN) return;
    ev.stopPropagation();
    const id = parseInt(eb.dataset.editId, 10);
    const m = (DATA.members || []).find(x => x.id === id);
    if (m) openEditModal(m);
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

    const ctx = $("tl-canvas").getContext("2d");
    if (CHART) CHART.destroy();
    CHART = new Chart(ctx, {
      type: "line",
      data: {
        labels: TL_RAW.periods,
        datasets: series.map((s, i) => ({
          label: s.nick + (s.true_name ? "  ·  " + s.true_name : ""),
          data: s.counts,
          borderColor: pickColor(i, series.length),
          backgroundColor: pickColor(i, series.length),
          tension: 0.2,
          pointRadius: 3,
          pointHoverRadius: 6,
        })),
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
                beginAtZero: true },
        },
      },
    });
    // Своя легенда — кликабельная (toggle dataset)
    $("tl-legend").innerHTML = series.map((s, i) => `
      <span class="leg-item" data-i="${i}" style="color:${pickColor(i, series.length)}"
        >● ${esc(s.nick)}${s.true_name ? " · " + esc(s.true_name) : ""}
        <small>(${s.total})</small></span>
    `).join(" ");
    $("tl-legend").querySelectorAll(".leg-item").forEach(el => {
      el.addEventListener("click", () => {
        const i = +el.dataset.i;
        const meta = CHART.getDatasetMeta(i);
        meta.hidden = !meta.hidden;
        el.classList.toggle("leg-off", meta.hidden);
        CHART.update();
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
      </tr>
    `).join("");
  }

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

  loadMe();
  load().then(() => { loadTimeline(); loadDeparted(); });
})();
