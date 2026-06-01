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
            <option value="comp">по доблести</option>
            <option value="chat">по активности в чатах</option>
            <option value="soc">по соцсетям</option>
            <option value="off">по офицерству</option>
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
      <span>средняя ценность: <b style="color:var(--accent)">${avgReg}/100</b></span>
      ${afkChip}
      ${immChip}
      <span style="color:#88ff88">▌ доблесть</span>
      <span style="color:#69b7e4">▌ чаты</span>
      <span style="color:#b070dc">▌ соцсети</span>
      <span style="color:#ffe070">▌ ветеран</span>
      <span style="color:#ff9a44">▌ офицер</span>
    `;

    // Чем больше людей — тем выше холст. ~24px на строку — комфортно
    // даже когда все 196 видны.
    const rowH = items.length > 60 ? 22 : items.length > 30 ? 26 : 30;
    const wrap = document.querySelector(".combined-modal .canvas-wrap");
    wrap.style.height = Math.max(380, items.length * rowH + 80) + "px";

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
        datasets: [
          {
            label: "Доблесть",
            data: items.map(m => m.score.compliance ?? 0),
            backgroundColor: "rgba(80,220,80,0.75)",
            borderColor: "rgba(80,220,80,0.95)",
            borderWidth: 1,
          },
          {
            label: "Чаты",
            data: items.map(m => m.score.chat ?? 0),
            backgroundColor: "rgba(105,183,228,0.75)",
            borderColor: "rgba(105,183,228,0.95)",
            borderWidth: 1,
          },
          {
            label: "Соцсети",
            data: items.map(m => m.score.socials ?? 0),
            backgroundColor: "rgba(176,112,220,0.75)",
            borderColor: "rgba(176,112,220,0.95)",
            borderWidth: 1,
          },
          {
            label: "Ветеран",
            data: items.map(m => m.score.veteran ?? 0),
            backgroundColor: "rgba(255,224,112,0.75)",
            borderColor: "rgba(255,224,112,0.95)",
            borderWidth: 1,
          },
          {
            label: "Офицер",
            data: items.map(m => m.score.officer ?? 0),
            backgroundColor: "rgba(255,154,68,0.78)",
            borderColor: "rgba(255,154,68,0.98)",
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
                const MAX = {"Доблесть":60,"Чаты":5,"Соцсети":5,
                              "Ветеран":16,"Офицер":14};
                const lbl = ctx.dataset.label;
                const val = Math.round((ctx.parsed.x || 0) * 10) / 10;
                const max = MAX[lbl] || 0;
                const m = items[ctx.dataIndex];
                const sc = m.score || {};
                if (lbl === "Доблесть" && sc.immunity_adjusted) {
                  return `  Доблесть: — не оценивается (иммунитет)`;
                }
                let suffix = "";
                if (lbl === "Офицер" && sc.top_rank) {
                  suffix = "  · " + sc.top_rank;
                } else if (lbl === "Чаты") {
                  suffix = "  · " + (sc.chat_msgs || 0) + " сообщ.";
                }
                return `  ${lbl}: ${val} / ${max}${suffix}`;
              },
              // Footer: итог + процент. Для иммунных — нормализованный.
              footer: (tts) => {
                if (!tts.length) return "";
                const m = items[tts[0].dataIndex];
                const sc = m.score || {};
                if (sc.immunity_adjusted) {
                  return `Итог: ~${sc.total} / 100 (норм. из ` +
                    `${sc.raw_total} / ${sc.max})`;
                }
                const total = tts.reduce((a, t) => a + (t.parsed.x || 0), 0);
                const rounded = Math.round(total * 10) / 10;
                const pct = Math.round(total);
                return `Итого: ${rounded} / 100 (${pct}%)`;
              },
            },
          },
        },
        scales: {
          x: { stacked: true, max: 100,
                ticks: { color: "#a0a0a0", stepSize: 10 },
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
    if (key === "comp") return s.compliance;
    if (key === "chat") return s.chat;
    if (key === "soc")  return s.socials;
    if (key === "off")  return s.officer || 0;
    return s.total;
  }

  // Глобальная функция — вызывается со страниц
  window.CombinedStats = { open, close };
})();
