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
          </select>
          <select id="cs-top">
            <option value="20" selected>топ 20</option>
            <option value="40">топ 40</option>
            <option value="80">топ 80</option>
            <option value="0">все</option>
          </select>
          <input type="text" id="cs-filter" placeholder="фильтр имён"
                 style="background:#100608;border:1px solid var(--accent-dim);
                        color:var(--accent);padding:4px 8px;border-radius:3px;
                        font-family:'Cascadia Code',monospace;font-size:11px;">
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

  function render() {
    if (!DATA) return;
    const mem = (DATA.members || []).filter(m => m.score);
    const sortKey = document.getElementById("cs-sort").value;
    const top = +document.getElementById("cs-top").value;
    const q = (document.getElementById("cs-filter").value || "").trim().toLowerCase();
    let items = mem.slice();
    if (q) {
      items = items.filter(m =>
        ((m.nick || "") + " " + (m.true_name || ""))
          .toLowerCase().includes(q));
    }
    items.sort((a, b) => {
      const va = sortVal(a, sortKey);
      const vb = sortVal(b, sortKey);
      return vb - va;  // desc
    });
    if (top > 0) items = items.slice(0, top);

    // Сводка сверху
    const tot = items.reduce((a, m) => a + (m.score.total || 0), 0);
    const avg = items.length ? Math.round(tot / items.length * 10) / 10 : 0;
    document.getElementById("cs-stats").innerHTML = `
      <span>показано: <b>${items.length}</b></span>
      <span>средняя ценность: <b style="color:var(--accent)">${avg}/100</b></span>
      <span style="color:#88ff88">▌ доблесть</span>
      <span style="color:#69b7e4">▌ чаты</span>
      <span style="color:#b070dc">▌ соцсети</span>
      <span style="color:#ffe070">▌ ветеран</span>
    `;

    const ctx = document.getElementById("cs-canvas").getContext("2d");
    if (CHART) CHART.destroy();
    CHART = new Chart(ctx, {
      type: "bar",
      data: {
        labels: items.map(m => m.nick +
          (m.true_name ? " · " + m.true_name : "")),
        datasets: [
          {
            label: "Доблесть",
            data: items.map(m => m.score.compliance),
            backgroundColor: "rgba(80,220,80,0.7)",
            borderColor: "rgba(80,220,80,0.9)",
            borderWidth: 1,
          },
          {
            label: "Чаты",
            data: items.map(m => m.score.chat),
            backgroundColor: "rgba(105,183,228,0.7)",
            borderColor: "rgba(105,183,228,0.9)",
            borderWidth: 1,
          },
          {
            label: "Соцсети",
            data: items.map(m => m.score.socials),
            backgroundColor: "rgba(176,112,220,0.7)",
            borderColor: "rgba(176,112,220,0.9)",
            borderWidth: 1,
          },
          {
            label: "Ветеран",
            data: items.map(m => m.score.veteran),
            backgroundColor: "rgba(255,224,112,0.7)",
            borderColor: "rgba(255,224,112,0.9)",
            borderWidth: 1,
          },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        indexAxis: "y",
        plugins: {
          legend: { display: false },
          tooltip: {
            mode: "index", intersect: false,
            callbacks: {
              footer: (items) => {
                const total = items.reduce((a, t) => a + (t.parsed.x || 0), 0);
                return "Итого: " + Math.round(total * 10) / 10 + " / 100";
              },
            },
          },
        },
        scales: {
          x: { stacked: true, max: 100,
                ticks: { color: "#a0a0a0" },
                grid: { color: "rgba(255,255,255,0.04)" }, },
          y: { stacked: true,
                ticks: { color: "#a0a0a0", font: { size: 11 } },
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
    return s.total;
  }

  // Глобальная функция — вызывается со страниц
  window.CombinedStats = { open, close };
})();
