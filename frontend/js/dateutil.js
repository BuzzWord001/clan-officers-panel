// Преобразование между ДД.ММ.ГГГГ (UI) и YYYY-MM-DD (API/БД).
(function () {
  const RE = /^(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{4})$/;

  function parseRus(s) {
    if (!s) return null;
    const m = String(s).trim().match(RE);
    if (!m) return null;
    const [, d, mo, y] = m;
    const day = parseInt(d, 10);
    const month = parseInt(mo, 10);
    const year = parseInt(y, 10);
    if (month < 1 || month > 12) return null;
    if (day < 1 || day > 31) return null;
    if (year < 2000 || year > 2100) return null;
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() + 1 !== month || date.getDate() !== day) {
      return null;
    }
    return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  function fmtRus(iso) {
    if (!iso) return "";
    const [y, m, d] = String(iso).split("-");
    if (!y || !m || !d) return iso;
    return `${d}.${m}.${y}`;
  }

  function today() {
    const d = new Date();
    return fmtRus(d.toISOString().slice(0, 10));
  }

  // Навешать на text-input авто-форматирование при вводе/paste.
  // Разрешаем: цифры и точки. Подставляем точку после ввода 2-й и 4-й цифры.
  function bindDateInput(input) {
    input.setAttribute("inputmode", "numeric");
    input.setAttribute("maxlength", "10");
    input.setAttribute("autocomplete", "off");

    const reformat = () => {
      const raw = input.value.replace(/[^\d]/g, "").slice(0, 8);
      let out = raw;
      if (raw.length > 4) out = `${raw.slice(0, 2)}.${raw.slice(2, 4)}.${raw.slice(4)}`;
      else if (raw.length > 2) out = `${raw.slice(0, 2)}.${raw.slice(2)}`;
      input.value = out;
    };

    input.addEventListener("input", reformat);
    input.addEventListener("paste", () => setTimeout(reformat, 0));
  }

  window.DateRu = { parseRus, fmtRus, today, bindDateInput };
})();
