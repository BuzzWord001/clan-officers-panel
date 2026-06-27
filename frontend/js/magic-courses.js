/* Курсы волшебства — трекер обучения (ТОЛЬКО админ).
 *
 * Порт десктопного Learning Tracker: прогресс просмотра по курсам, дневная
 * норма, темп и прогноз завершения. Прогресс редактируется вручную (отметка
 * «пройдено» + часы просмотра); та же модель примет авто-трекинг VK-плеера.
 */
(function () {
  "use strict";

  var ST = null;                 // последнее состояние от бэкенда
  var collapsed = {};            // свёрнутые фазы

  // ── утилиты ──────────────────────────────────────────────────────────
  function h(hours) {
    hours = +hours || 0;
    if (hours < 1 && hours > 0) return Math.round(hours * 60) + " мин";
    var hh = Math.floor(hours), mm = Math.round((hours - hh) * 60);
    return mm ? hh + "ч " + mm + "м" : hh + " ч";
  }
  function rusDate(iso) {
    if (!iso) return "—";
    var p = iso.split("-");
    return p.length === 3 ? p[2] + "." + p[1] + "." + p[0] : iso;
  }
  function plur(n, one, few, many) {
    n = Math.abs(n) % 100; var n1 = n % 10;
    if (n > 10 && n < 20) return many;
    if (n1 > 1 && n1 < 5) return few;
    if (n1 === 1) return one;
    return many;
  }
  function el(html) { var d = document.createElement("div"); d.innerHTML = html; return d.firstElementChild; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  // ── загрузка/гард ────────────────────────────────────────────────────
  async function boot() {
    var me = null;
    try { me = await API.me(); } catch (e) { me = null; }
    document.body.setAttribute("data-role", (me && me.role) || "");
    var who = document.getElementById("who");
    if (who && me) who.textContent = me.name ? (me.name + " · " + me.role) : me.role;
    if (!me || me.role !== "admin") {
      // раздел только для админа — мягкий редирект
      location.replace("clan-valor.html");
      return;
    }
    document.documentElement.classList.remove("booting");   // админ ок — показать (анти-вспышка)
    var lo = document.getElementById("logout-btn");
    if (lo) lo.addEventListener("click", async function () {
      try { await API.logout(); } catch (e) {} location.href = "login.html"; });
    await reload();
  }

  async function reload() {
    try { ST = await API.chamberCourses(); }
    catch (e) {
      document.getElementById("mc-root").innerHTML =
        '<div class="mc-loading">Не удалось загрузить: ' + esc(e.message || e) + '</div>';
      return;
    }
    render();
  }

  // ── рендер ───────────────────────────────────────────────────────────
  function render() {
    var s = ST.stats;
    var root = document.getElementById("mc-root");
    root.innerHTML = "";
    root.appendChild(renderHero(s));
    ST.phases.forEach(function (ph) { root.appendChild(renderPhase(ph)); });
    root.appendChild(el(
      '<div class="mc-hint">Прогресс пока отмечается вручную: галочка «пройдено» ' +
      'или часы просмотра. Когда подключим VK-плеер — шкала будет заполняться сама ' +
      'по реальному просмотру.</div>'));
  }

  function renderHero(s) {
    var ahead = s.ahead_days;
    var paceTxt;
    if (s.remaining_h <= 0) {
      paceTxt = '🎉 <b>Все курсы пройдены!</b>';
    } else if (s.actual_pace_h <= 0.01) {
      paceTxt = 'Отметь первый просмотр — и я начну считать твой темп и прогноз ' +
        'завершения.';
    } else {
      var faster = (ahead != null && ahead > 0);
      var slower = (ahead != null && ahead < 0);
      paceTxt = 'Темп: <b>' + s.actual_pace_h + ' ч/день</b> (план — ' +
        s.daily_target_h + ' ч/день). При таком темпе закончишь все курсы ' +
        '~<b>' + rusDate(s.finish_actual) + '</b>';
      if (faster) paceTxt += ' — это на <b>' + ahead + ' ' +
        plur(ahead, "день", "дня", "дней") + ' быстрее</b> плана.';
      else if (slower) paceTxt += ' — это на <b>' + (-ahead) + ' ' +
        plur(-ahead, "день", "дня", "дней") + ' дольше</b> плана. Добавь часов в день.';
      else paceTxt += ' — ровно по плану.';
    }

    var cards = [
      ["Просмотрено", h(s.done_h) + ' <small>/ ' + h(s.total_h) + '</small>', s.pct >= 50 ? "good" : ""],
      ["Курсов пройдено", s.done_courses + ' <small>/ ' + s.total_courses + '</small>', ""],
      ["Дневная норма", s.daily_target_h + ' <small>ч/день</small>', ""],
      ["Сегодня", h(s.today_watched_h) + ' <small>из ' + s.daily_target_h + ' ч</small>',
        s.today_watched_h >= s.daily_target_h ? "good" : (s.today_watched_h > 0 ? "" : "warn")],
      ["Текущий темп", s.actual_pace_h + ' <small>ч/день</small>', s.on_track ? "good" : "warn"],
      ["Осталось", (s.days_left_actual != null ? s.days_left_actual : "—") +
        ' <small>' + (s.days_left_actual != null ? plur(s.days_left_actual, "день", "дня", "дней") : "") +
        '</small>', ""],
      ["Прогноз завершения", rusDate(s.finish_actual), "good"],
      ["По плану (" + s.daily_target_h + "ч/д)", rusDate(s.finish_plan), ""],
    ];
    var cardsHtml = cards.map(function (c) {
      return '<div class="mc-card ' + c[2] + '"><div class="mc-k">' + c[0] +
        '</div><div class="mc-v">' + c[1] + '</div></div>';
    }).join("");

    var node = el(
      '<div class="mc-hero">' +
        '<h2>✦ Курс на AAA · UE5</h2>' +
        '<div class="mc-sub">Просмотрено ' + s.pct + '% · ' + h(s.done_h) + ' из ' +
          h(s.total_h) + ' (' + s.total_days + ' дней обучения по ' + s.daily_target_h + ' ч)</div>' +
        '<div class="mc-bar"><div class="mc-bar-fill" id="mc-fill"></div>' +
          '<div class="mc-bar-txt">' + s.pct + '%</div></div>' +
        '<div class="mc-cards">' + cardsHtml + '</div>' +
        '<div class="mc-pace">' + paceTxt + '</div>' +
        '<div class="mc-settings">' +
          '<div><label>Норма, ч/день</label>' +
            '<input type="number" id="mc-target" min="0.5" step="0.5" value="' + s.daily_target_h + '"></div>' +
          '<div><label>Дата старта</label>' +
            '<input type="date" id="mc-start" value="' + s.start_date + '"></div>' +
          '<button class="mc-btn" id="mc-save-settings">Сохранить</button>' +
          '<button class="mc-btn ghost" id="mc-reset-all">Сбросить весь прогресс</button>' +
        '</div>' +
      '</div>');

    setTimeout(function () {
      var f = node.querySelector("#mc-fill"); if (f) f.style.width = s.pct + "%";
    }, 40);
    node.querySelector("#mc-save-settings").addEventListener("click", saveSettings);
    node.querySelector("#mc-reset-all").addEventListener("click", function () {
      if (confirm("Сбросить прогресс по ВСЕМ курсам?")) doReset(null);
    });
    return node;
  }

  function renderPhase(ph) {
    var open = !collapsed[ph.id];
    var node = el(
      '<div class="mc-phase">' +
        '<div class="mc-phase-h" data-ph="' + ph.id + '">' +
          '<span class="mc-ph-name">' + esc(ph.name || ("Фаза " + ph.id)) + '</span>' +
          '<div class="mc-phase-mini"><i style="width:' + ph.pct + '%"></i></div>' +
          '<span class="mc-ph-stat">' + ph.done + '/' + ph.total + ' · ' +
            h(ph.done_h) + ' / ' + h(ph.total_h) + '</span>' +
          '<span class="mc-ph-stat">' + (open ? "▾" : "▸") + '</span>' +
        '</div>' +
        '<div class="mc-phase-body"' + (open ? "" : ' hidden') + '></div>' +
      '</div>');
    var body = node.querySelector(".mc-phase-body");
    ST.courses.filter(function (c) { return c.phase_id === ph.id; })
      .forEach(function (c) { body.appendChild(renderCourse(c)); });
    node.querySelector(".mc-phase-h").addEventListener("click", function () {
      collapsed[ph.id] = !collapsed[ph.id];
      render();
    });
    return node;
  }

  function renderCourse(c) {
    var watchedH = +(c.watched_h || 0).toFixed(1);
    var node = el(
      '<div class="mc-course" data-id="' + c.id + '">' +
        '<div class="mc-chk ' + (c.completed ? "on" : "") + '" title="Отметить пройденным">' +
          (c.completed ? "✓" : "") + '</div>' +
        '<div class="mc-course-main">' +
          '<div class="mc-course-name">' + esc(c.name) +
            '<span class="mc-tag ' + c.type + '">' + c.type + '</span></div>' +
          '<div class="mc-course-meta">' + esc(c.category || "") +
            ' · ' + h(c.dur_h) + (c.why ? ' · ' + esc(c.why) : "") + '</div>' +
        '</div>' +
        '<div class="mc-cprog">' +
          '<div class="mc-cprog-bar"><i style="width:' + c.pct + '%"></i></div>' +
          '<div class="mc-cprog-txt">' +
            '<input type="number" min="0" step="0.5" value="' + watchedH +
            '" title="часов просмотрено"> / ' + h(c.dur_h) + '</div>' +
        '</div>' +
      '</div>');

    node.querySelector(".mc-chk").addEventListener("click", function () {
      setProgress(c.id, { completed: !c.completed });
    });
    var inp = node.querySelector("input");
    inp.addEventListener("change", function () {
      var hrs = Math.max(0, parseFloat(inp.value) || 0);
      setProgress(c.id, { watched_sec: Math.round(hrs * 3600) });
    });
    inp.addEventListener("click", function (e) { e.stopPropagation(); });
    return node;
  }

  // ── действия ─────────────────────────────────────────────────────────
  async function setProgress(courseId, patch) {
    try { ST = await API.chamberProgress(courseId, patch); render(); }
    catch (e) { alert("Ошибка: " + (e.message || e)); }
  }
  async function saveSettings() {
    var t = parseFloat(document.getElementById("mc-target").value);
    var sd = document.getElementById("mc-start").value;
    try { ST = await API.chamberSettings({ daily_target_h: t, start_date: sd }); render(); }
    catch (e) { alert("Ошибка: " + (e.message || e)); }
  }
  async function doReset(courseId) {
    try { ST = await API.chamberReset(courseId); render(); }
    catch (e) { alert("Ошибка: " + (e.message || e)); }
  }

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
