// Вкладка «Доблесть» — список сокланов из последнего valor-snapshot'а.
// Клик по «Должности» / «Титулу» / «Уровню» / «Классу» открывает popover
// с историей изменений (взято с GET /valor/history).
(async function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));

  let DATA = { snapshot: null, members: [] };
  let SORT = { key: "valor", dir: "desc" };

  async function loadMe() {
    try {
      const me = await API.me();
      const who = me?.role === "admin"
        ? `${esc(me.username)} · админ`
        : `${esc(me.username)} · офицер`;
      $("who").textContent = who;
      if (me.role !== "admin") {
        document.querySelectorAll(".admin-only").forEach(el =>
          el.style.display = "none");
      }
    } catch (e) {
      location.href = "login.html";
    }
  }

  $("logout-btn").addEventListener("click", async () => {
    try { await API.logout(); } catch (_) {}
    location.href = "login.html";
  });

  async function load() {
    $("valor-loading").hidden = false;
    try {
      DATA = await API.valorCurrent();
    } catch (e) {
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
    const afk = m.filter(x => x.is_afk).length;
    const metGood = m.filter(x => x.norm_met === true).length;
    const metBad  = m.filter(x => x.norm_met === false).length;
    const totalValor = m.reduce((a, x) => a + (x.valor || 0), 0);
    $("valor-summary").innerHTML = `
      <span>неделя: <b>${esc(s.week)}</b></span>
      <span>норматив: <b>${esc(s.valor_norm)}</b></span>
      <span>всего: <b>${m.length}</b></span>
      <span>норматив выполнили: <b style="color:#88ff88">${metGood}</b></span>
      <span>не выполнили: <b style="color:#ff8080">${metBad}</b></span>
      <span>АФК: <b style="color:#ffd080">${afk}</b></span>
      <span>сумма доблести: <b>${totalValor}</b></span>
    `;
  }

  function getSortVal(m, key) {
    if (key === "level" || key === "valor")
      return m[key] == null ? -1 : m[key];
    if (key === "class") return (m.class_ || "").toLowerCase();
    if (key === "norm") {
      // выполнено(1) → невыполнено(0) → АФК(null)
      if (m.norm_met === true)  return 2;
      if (m.norm_met === false) return 0;
      return 1;
    }
    return (m[key] || "").toString().toLowerCase();
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
      if (m.is_afk) rowCls += " row-afk";
      else if (m.norm_met === false) rowCls += " row-bad";
      else if (m.norm_met === true)  rowCls += " row-good";
      const valorCell = m.valor == null
        ? `<span style="color:#888">—</span>` : esc(m.valor);
      let normLabel;
      if (m.is_afk) normLabel = `<span style="color:#ffd080">АФК</span>`;
      else if (m.norm_met === true)  normLabel = `<span style="color:#88ff88">✓</span>`;
      else if (m.norm_met === false) normLabel = `<span style="color:#ff8080">✕</span>`;
      else normLabel = `<span style="color:#888">?</span>`;
      return `
        <tr class="${rowCls}" data-nick="${esc(m.nick)}">
          <td class="m-cell-idx">${i + 1}</td>
          <td class="m-cell-name"><b>${esc(m.nick)}</b></td>
          <td>${esc(m.true_name)}</td>
          <td class="hist-cell" data-field="rank">${esc(m.rank)}</td>
          <td class="hist-cell" data-field="title">${esc(m.title)}</td>
          <td class="m-cell-num hist-cell" data-field="level">${m.level ?? ""}</td>
          <td class="hist-cell" data-field="class">${esc(cls)}</td>
          <td class="m-cell-num m-cell-total">${valorCell}</td>
          <td class="m-cell-num">${normLabel}</td>
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

  $("valor-filter").addEventListener("input", apply);

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
  $("valor-tbody").addEventListener("click", async (ev) => {
    const cell = ev.target.closest(".hist-cell");
    if (!cell) return;
    const tr = cell.closest("tr");
    const nick = tr.dataset.nick;
    const field = cell.dataset.field;
    const fieldLabel = {rank:"должности", title:"титула",
                         level:"уровня", class:"класса"}[field];
    closePopover();
    const popover = document.createElement("div");
    popover.className = "valor-popover";
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
      } else {
        popover.querySelector(".body").innerHTML = hist.map(h => `
          <div class="row"><span class="w">${esc(h.week)}</span>
            <span class="v">${esc(h.value || "—")}</span></div>
        `).join("");
      }
    } catch (e) {
      popover.querySelector(".body").textContent = "Ошибка: " +
        (e.detail || e.message);
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

  loadMe();
  load();
})();
