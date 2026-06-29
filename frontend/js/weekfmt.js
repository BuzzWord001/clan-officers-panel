/* Единый формат недель для всего сайта (window.WeekFmt).
 *
 * Неделя хранится как ISO-ключ «2026-W25». Игрокам показываем ДИАПАЗОН ДАТ
 * («23–29 июня 2026») — это понятнее, чем номер ISO-недели. Номер оставляем
 * мелким рядом для тех, кто привык считать неделями.
 *
 * Неделя в клане завершается в воскресенье вечером (сбор данных). ISO-неделя —
 * Пн…Вс, последний день Вс, поэтому диапазон Пн…Вс совпадает с нашей неделей. */
(function () {
  "use strict";
  var MON = ["января", "февраля", "марта", "апреля", "мая", "июня",
             "июля", "августа", "сентября", "октября", "ноября", "декабря"];

  // Понедельник ISO-недели (ISO 8601).
  function isoWeekMonday(year, week) {
    var s = new Date(Date.UTC(year, 0, 1 + (week - 1) * 7));
    var dow = s.getUTCDay();
    if (dow <= 4) s.setUTCDate(s.getUTCDate() - dow + 1);
    else s.setUTCDate(s.getUTCDate() + 8 - dow);
    return s;
  }
  function parse(wk) { return /^(\d{4})-W(\d{1,2})$/.exec(String(wk || "")); }

  // «2026-W25» → {mon, sun, year, week}
  function span(wk) {
    var m = parse(wk);
    if (!m) return null;
    var mon = isoWeekMonday(+m[1], +m[2]);
    var sun = new Date(mon); sun.setUTCDate(mon.getUTCDate() + 6);
    return { mon: mon, sun: sun, year: +m[1], week: +m[2] };
  }

  // Диапазон дат: «23–29 июня 2026» (или «28 июня – 4 июля 2026» через месяц).
  // opt.noYear — без года.
  function range(wk, opt) {
    var s = span(wk);
    if (!s) return String(wk || "");
    opt = opt || {};
    var d1 = s.mon.getUTCDate(), m1 = s.mon.getUTCMonth();
    var d2 = s.sun.getUTCDate(), m2 = s.sun.getUTCMonth();
    var y = opt.noYear ? "" : " " + s.year;
    return (m1 === m2)
      ? d1 + "–" + d2 + " " + MON[m2] + y
      : d1 + " " + MON[m1] + " – " + d2 + " " + MON[m2] + y;
  }

  // Короткий номер недели для человека: «нед. 25».
  function num(wk) {
    var m = parse(wk);
    return m ? "нед. " + (+m[2]) : String(wk || "");
  }

  // Главная метка раздела. mode:
  //   "long"  → «23–29 июня 2026» (по умолчанию)
  //   "withNum" → «23–29 июня 2026 · нед. 25»
  function label(wk, mode) {
    if (!parse(wk)) return String(wk || "");
    if (mode === "withNum") return range(wk) + " · " + num(wk);
    return range(wk);
  }

  window.WeekFmt = { range: range, num: num, label: label, span: span, MON: MON };
})();
