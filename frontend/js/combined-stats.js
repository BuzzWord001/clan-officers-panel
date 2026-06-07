// Совмещённая статистика: доблесть + чат-активность + соцсети + ветеран.
// Открывается по кнопке как modal на странице «Доблесть» и «Участники».
// Stacked-bar Chart.js по каждому участнику: breakdown того что
// формирует его «ценность для клана».
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));

  let CHART = null;

  function makeModal() {
    const wrap = document.createElement("div");
    wrap.className = "combined-overlay";
    wrap.innerHTML = `
      <div class="combined-modal">
        <div class="head">
          <h2>Совмещённая ценность для клана</h2>
          <select id="cs-sort">
            <option value="total">сортировка: суммарно</option>
            <option value="comp">по доблести (×множитель)</option>
            <option value="ach">по бонусу серий</option>
            <option value="off">по офицерству</option>
            <option value="soc">по общительности</option>
            <option value="chat">по чатам</option>
          </select>
          <select id="cs-top">
            <option value="20">топ 20</option>
            <option value="40">топ 40</option>
            <option value="80">топ 80</option>
            <option value="0" selected>все</option>
          </select>
          <input type="text" id="cs-filter" placeholder="фильтр имён">
          <button class="x" id="cs-close" title="Закрыть">×</button>
        </div>
        <div class="body">
          <div class="ctrls" id="cs-stats"></div>
          <div class="canvas-wrap">
            <canvas id="cs-canvas"></canvas>
          </div>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener("click", (e) => {
      if (e.target === wrap || e.target.id === "cs-close") close();
    });
    return wrap;
  }

  let MODAL = null;
  let DATA = null;

  function close() {
    if (CHART) { try { CHART.destroy(); } catch (_) {} CHART = null; }
    if (MODAL) { MODAL.remove(); MODAL = null; }
  }

  async function open() {
    if (MODAL) return;
    MODAL = makeModal();
    document.getElementById("cs-sort").addEventListener("change", render);
    document.getElementById("cs-top").addEventListener("change", render);
    document.getElementById("cs-filter").addEventListener("input", render);
    // Загружаем все members с score
    try {
      DATA = await API.valorCurrent();
    } catch (e) {
      DATA = { members: [] };
    }
    render();
  }

  // Маркер pseudo-разделителя «Иммунные новички». Используется как
  // невыделяемая строка в Chart.js (data=0 во всех datasets, спец-label).
  const SEP_NICK = "__SEP_IMMUNE__";
  const SEP_AFK  = "__SEP_AFK__";
  function isImmuneAdjusted(m) {
    return m && m.score && m.score.immunity_adjusted;
  }
  function isAfk(m) {
    return !!(m && m.is_afk);
  }

  function render() {
    if (!DATA) return;
    const CV = window.ClanValue || { MULT: 1, num: (v) => v, fmt: (v) => String(v) };
    const mem = (DATA.members || []).filter(m => m.score);
    const sortKey = document.getElementById("cs-sort").value;
    const top = +document.getElementById("cs-top").value;
    const q = (document.getElementById("cs-filter").value || "").trim().toLowerCase();
    let pool = mem.slice();
    if (q) {
      pool = pool.filter(m =>
        ((m.nick || "") + " " + (m.true_name || ""))
          .toLowerCase().includes(q));
    }
    // Разделяем на 3 группы: обычные → АФК → иммунные. Сортируем каждую.
    // АФК классифицируем первыми (даже если у человека есть иммунитет) —
    // у них норматив тоже «не оценивается», и они должны быть НАД иммунными.
    const cmp = (a, b) => sortVal(b, sortKey) - sortVal(a, sortKey);
    const regular = pool.filter(m => !isAfk(m) && !isImmuneAdjusted(m)).sort(cmp);
    const afk     = pool.filter(m =>  isAfk(m)).sort(cmp);
    const immune  = pool.filter(m => !isAfk(m) &&  isImmuneAdjusted(m)).sort(cmp);
    let regCut = regular, afkCut = afk, immCut = immune;
    if (top > 0) {
      regCut = regular.slice(0, top);
      afkCut = afk.slice(0, top);
      immCut = immune.slice(0, top);
    }
    // Собираем единый список. Между группами вставляем pseudo-разделитель.
    // items[] — порядковый список, syncронный с labels/data.
    const items = regCut.slice();
    // АФК — над иммунными (у них тоже «вроде иммуна» — норматив не оценивается)
    if (afkCut.length) {
      items.push({ nick: SEP_AFK, _is_sep: true, _sep_kind: "afk", score: {} });
      items.push(...afkCut);
    }
    if (immCut.length) {
      // Pseudo-объект для строки-разделителя
      items.push({ nick: SEP_NICK, _is_sep: true, _sep_kind: "immune", score: {} });
      items.push(...immCut);
    }

    // Сводка сверху
    const totReg = regCut.reduce((a, m) => a + (m.score.total || 0), 0);
    const avgReg = regCut.length ? Math.round(totReg / regCut.length * 10) / 10 : 0;
    const totImm = immCut.reduce((a, m) => a + (m.score.total || 0), 0);
    const avgImm = immCut.length ? Math.round(totImm / immCut.length * 10) / 10 : 0;
    const afkChip = afkCut.length
      ? `<span style="color:#ffd080">💤 АФК: <b>${afkCut.length}</b></span>`
      : "";
    const immChip = immCut.length
      ? `<span style="color:#7bc7ff">🛡 иммунных: <b>${immCut.length}</b> (ср. ${avgImm}/100)</span>`
      : "";
    document.getElementById("cs-stats").innerHTML = `
      <span>показано: <b>${regCut.length + afkCut.length + immCut.length}</b>
        <small style="opacity:0.7">(${regCut.length} обычных)</small></span>
      <span>средняя ценность: <b class="val-gold"><span class="gold-coin"></span>${CV.fmt(avgReg)}</b></span>
      ${afkChip}
      ${immChip}
      <span style="color:#57d982">▌ перевыполнение (база)</span>
      <span style="color:#ffc83c">▌ серии (×множитель)</span>
      <span style="color:#ff8f3f">▌ офицерство</span>
      <span style="color:#3aa0e0">▌ общительность</span>
      <span style="color:#b07bd4">▌ ветеран</span>
    `;

    // Чем больше людей — тем выше холст. ~24px на строку — комфортно
    // даже когда все 196 видны.
    const rowH = items.length > 60 ? 22 : items.length > 30 ? 26 : 30;
    const wrap = document.querySelector(".combined-modal .canvas-wrap");
    wrap.style.height = Math.max(380, items.length * rowH + 80) + "px";

    // Ось X: Ценность может превышать 100 за счёт дисциплинарного бонуса
    // (напр. 106/100). Берём максимум по всем видимым и округляем вверх до 10,
    // но не ниже 100 — иначе самый дисциплинированный бар упирался бы в край.
    const maxTotal = items.reduce((mx, m) =>
      m._is_sep ? mx : Math.max(mx, m.score.total || 0), 0);
    const xMax = CV.num(Math.max(40, Math.ceil(maxTotal / 10) * 10));

    const ctx = document.getElementById("cs-canvas").getContext("2d");
    if (CHART) CHART.destroy();
    // Label для разделителей — заметные декоративные строки
    const SEP_LABELS = {
      afk:    "──── 💤 АФК ────",
      immune: "──── 🛡 ИММУННЫЕ НОВИЧКИ ────",
    };
    CHART = new Chart(ctx, {
      type: "bar",
      data: {
        labels: items.map(m => m._is_sep
          ? (SEP_LABELS[m._sep_kind] || SEP_LABELS.immune)
          : (m.nick + (m.true_name ? " · " + m.true_name : ""))),
        // Ветка доблести (база + бонус множителя серии) доминирует, далее
        // аддитивные: офицерство → общительность → ветеран. Зелёный-якорь
        // доблести + золотой бонус серий + тёплые/прохладные различимые цвета.
        datasets: [
          {
            // Перевыполнение (база по магнитудной руне ×N) — зелёный-якорь.
            label: "Перевыполнение",
            data: items.map(m => CV.num(m.score.doblest_base ?? 0)),
            backgroundColor: "rgba(87,217,130,0.84)",
            borderColor: "rgba(87,217,130,1)",
            borderWidth: 1,
          },
          {
            // Бонус серии (множитель): доля, которую добавил стрик. Золото.
            label: "Серии",
            data: items.map(m => CV.num(m.score.streak_bonus ?? 0)),
            backgroundColor: "rgba(255,200,60,0.92)",
            borderColor: "rgba(255,200,60,1)",
            borderWidth: 1,
          },
          {
            label: "Офицерство",
            data: items.map(m => CV.num(m.score.officer ?? 0)),
            backgroundColor: "rgba(255,143,63,0.82)",
            borderColor: "rgba(255,143,63,1)",
            borderWidth: 1,
          },
          {
            label: "Общительность",
            data: items.map(m => CV.num(m.score.social ?? 0)),
            backgroundColor: "rgba(58,160,224,0.80)",
            borderColor: "rgba(58,160,224,1)",
            borderWidth: 1,
          },
          {
            label: "Ветеран",
            data: items.map(m => CV.num(m.score.veteran ?? 0)),
            backgroundColor: "rgba(176,123,212,0.80)",
            borderColor: "rgba(176,123,212,1)",
            borderWidth: 1,
          },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        indexAxis: "y",
        // ВАЖНО: для горизонтальных баров индекс на оси Y. Без axis:"y"
        // режим "index" по умолчанию берёт ось X → тултип цеплял НЕ ту
        // строку (показывал статистику чужого человека).
        interaction: { mode: "index", intersect: false, axis: "y" },
        animation: items.length > 80 ? false : { duration: 250 },
        plugins: {
          legend: { display: false },
          tooltip: {
            mode: "index", intersect: false, axis: "y",
            // Скрываем категории с 0 баллов чтобы не зашумлять.
            // Для иммунных «Доблесть» показываем со спец-лейблом.
            // Для строки-разделителя — скрыть всё (через filter не
            // получится отменить весь tooltip, поэтому в title возвращаем
            // пустую строку и body будет пуст).
            filter: (tt) => {
              const m = items[tt.dataIndex];
              if (m && m._is_sep) return false;
              const sc = m && m.score;
              if (tt.dataset.label === "Доблесть" &&
                  sc && sc.immunity_adjusted) return true;
              return (tt.parsed.x || 0) > 0;
            },
            callbacks: {
              // Заголовок: ник + истинное имя на отдельных строках для
              // длинных имён, плюс «иммунитет» если он есть.
              // Разделитель — без tooltip.
              title: (tts) => {
                if (!tts.length) return "";
                const m = items[tts[0].dataIndex];
                if (m._is_sep) return "";
                const lines = [m.nick];
                if (m.true_name) lines.push("· " + m.true_name);
                if (m.is_afk) {
                  lines.push("💤 статус АФК — норматив не оценивается");
                } else if (m.immunity && m.immunity.status === "active") {
                  lines.push("🛡 иммунитет активен (до " +
                    m.immunity.immune_until + ")");
                } else if (m.immunity && m.immunity.status === "extended") {
                  lines.push("🛡 иммун продлён на след. неделю");
                } else if (m.immunity && m.immunity.status === "grace") {
                  lines.push("🛡 иммун снят (скидка " +
                    m.immunity.credit_pct + "%)");
                }
                return lines;
              },
              // Лейбл одной категории: «Доблесть: 42.5 / 60»
              // Для «Офицер» дописываем top_rank, для «Чаты» — кол-во сообщ.
              // Для иммунных — «Доблесть: не оценивается».
              label: (ctx) => {
                const lbl = ctx.dataset.label;
                const val = Math.round(ctx.parsed.x || 0).toLocaleString("ru-RU");
                const m = items[ctx.dataIndex];
                const sc = m.score || {};
                let suffix = "";
                if (lbl === "Перевыполнение") {
                  if (sc.peak_ratio) suffix = "  · лучшая руна ×" + Number(sc.peak_ratio).toFixed(1);
                } else if (lbl === "Серии") {
                  // Бонус множителя серии = база × (множитель−1).
                  const parts = ["множитель ×" + Number(sc.streak_mult || 1).toFixed(2)];
                  if (sc.over_streak_cur) parts.push("стрик " + sc.over_streak_cur + " нед.");
                  suffix = "  · " + parts.join(", ");
                } else if (lbl === "Офицерство") {
                  const p = [];
                  if (sc.top_rank) p.push(sc.top_rank + (sc.cur_rank && sc.cur_rank !== sc.top_rank ? " (сейчас " + sc.cur_rank + ")" : ""));
                  if (sc.officer_mult > 1) p.push("×" + Number(sc.officer_mult).toFixed(2));
                  if (p.length) suffix = "  · " + p.join(", ");
                } else if (lbl === "Общительность") {
                  const parts = [];
                  if (sc.vk) parts.push("VK"); if (sc.tg) parts.push("TG");
                  parts.push((sc.chat_msgs || 0) + " сообщ.");
                  if (sc.social_mult > 1) parts.push("×" + Number(sc.social_mult).toFixed(2));
                  suffix = "  · " + parts.join(", ");
                }
                return `  ${lbl}: ${val}${suffix}`;
              },
              // Footer: итоговая ценность клану.
              footer: (tts) => {
                if (!tts.length) return "";
                const m = items[tts[0].dataIndex];
                const sc = m.score || {};
                const note = sc.immunity_adjusted ? "  (иммунитет: доблесть не в зачёте)" : "";
                return `★ Ценность клану: ${CV.fmt(sc.total)} золота${note}`;
              },
            },
          },
        },
        scales: {
          x: { stacked: true, max: xMax,
                ticks: { color: "#a0a0a0", maxTicksLimit: 8,
                  callback: (v) => Number(v).toLocaleString("ru-RU") },
                grid: { color: "rgba(255,255,255,0.04)" }, },
          y: { stacked: true,
                ticks: {
                  color: (ctx) => {
                    const m = items[ctx.index];
                    if (m && m._is_sep)
                      return m._sep_kind === "afk" ? "#ffd080" : "#7bc7ff";
                    if (isAfk(m)) return "#ffd9a0";
                    if (isImmuneAdjusted(m)) return "#a8d4ff";
                    return "#c8c8c8";
                  },
                  font: (ctx) => {
                    const m = items[ctx.index];
                    if (m && m._is_sep) {
                      return { size: rowH >= 26 ? 13 : 12,
                                weight: "bold" };
                    }
                    return { size: rowH >= 26 ? 12 : 11 };
                  },
                  autoSkip: false,
                },
                grid: { color: "rgba(255,255,255,0.02)" }, },
        },
      },
    });
  }

  function sortVal(m, key) {
    const s = m.score;
    if (key === "ach")  return s.streak_bonus || 0;
    if (key === "comp") return s.doblest_value || 0;
    if (key === "chat") return s.chat || 0;
    if (key === "soc")  return s.social || 0;
    if (key === "off")  return s.officer || 0;
    return s.total;
  }

  // Глобальная функция — вызывается со страниц
  window.CombinedStats = { open, close };
})();
