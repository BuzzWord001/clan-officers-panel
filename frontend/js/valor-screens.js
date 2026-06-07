// Скрины сбора ↔ распознанные данные: папки по неделям + сравнение скринов с
// тем, как база распознала строки, с правкой (админ) и копированием.
(async function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  let me, IS_ADMIN = false;
  try { me = await API.me(); } catch (_) { location.href = "login.html"; return; }
  if (!me || me.role === "guest") { location.href = "clan-valor.html"; return; }
  IS_ADMIN = me.role === "admin";
  $("who").textContent = (me.username || me.name || "") +
    (IS_ADMIN ? " · админ" : " · офицер");
  document.body.setAttribute("data-role", me.role || "");
  $("logout-btn").addEventListener("click", async () => {
    try { await API.logout(); } catch (_) {}
    location.href = "login.html";
  });

  // ── Лайтбокс ──
  const lb = $("vs-lightbox"), lbImg = $("vs-lightbox-img");
  lb.addEventListener("click", () => { lb.hidden = true; lbImg.src = ""; });
  const openLightbox = (url) => { lbImg.src = url; lb.hidden = false; };

  // ── Тост (копирование) ──
  let toastT = null;
  function toast(msg) {
    const el = $("cmp-toast"); el.textContent = msg; el.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => { el.hidden = true; }, 1400);
  }
  function copy(text) {
    navigator.clipboard?.writeText(text).then(
      () => toast("Скопировано: " + text), () => toast("Не удалось скопировать"));
  }

  let DATA = null, openWeek = null;

  // ── Загрузка недели для сравнения ──
  async function loadWeek(week, cardEl) {
    document.querySelectorAll(".vs-folder").forEach(e => e.classList.remove("vs-folder-on"));
    if (cardEl) cardEl.classList.add("vs-folder-on");
    openWeek = week;
    $("cmp").hidden = false;
    $("cmp-meta").textContent = "Загрузка " + week + "…";
    $("cmp-shots").innerHTML = ""; $("cmp-rows").innerHTML = "";
    try {
      DATA = await API.valorCompare(week);
    } catch (e) {
      $("cmp-meta").textContent = "Ошибка: " + (e.detail || e.message); return;
    }
    const sn = DATA.snapshot || {};
    $("cmp-meta").innerHTML = `<b>${esc(week)}</b> · норма ${sn.valor_norm ?? "?"} · ` +
      `${DATA.members.length} строк · ${DATA.screenshots.length} кадров`;
    renderShots();
    renderRows();
  }

  // ── Левая колонка: скрины ──
  function renderShots() {
    const box = $("cmp-shots");
    box.innerHTML = DATA.screenshots.map(s =>
      `<figure class="cmp-shot" data-idx="${s.idx}">
         <img loading="lazy" src="${esc(s.url)}" alt="кадр ${s.idx}" data-full="${esc(s.url)}">
         <figcaption>кадр #${s.idx}</figcaption>
       </figure>`).join("");
    box.querySelectorAll(".cmp-shot img").forEach(img =>
      img.addEventListener("click", () => openLightbox(img.dataset.full)));
  }

  // ── Правая колонка: распознанные строки ──
  function badges(m) {
    const b = [];
    b.push(m.in_registry
      ? `<span class="cmp-badge bdg-reg" title="ник совпал с реестром (надёжно)">реестр</span>`
      : `<span class="cmp-badge bdg-ai" title="ник распознан ИИ, в реестре не найден — проверить">ИИ-ник</span>`);
    if (m.flag_ocr_suspect)
      b.push(`<span class="cmp-badge bdg-sus" title="система сомневается в распознавании">⚠ проверить</span>`);
    if (m.is_afk) b.push(`<span class="cmp-badge bdg-afk">АФК</span>`);
    return b.join(" ");
  }
  const cell = (v) => `<td class="cmp-c" title="клик — копировать">${esc(v == null || v === "" ? "—" : v)}</td>`;

  function rowsHtml(list) {
    return list.map((m) =>
      `<tr class="cmp-row${m.flag_ocr_suspect || !m.in_registry ? " cmp-row-warn" : ""}" data-i="${m._i}">
        <td class="cmp-num">${m._i + 1}</td>
        <td class="cmp-nick"><span class="cmp-nick-t" title="клик — копировать">${esc(m.nick)}</span><br>${badges(m)}</td>
        ${cell(m.true_name)}${cell(m.rank)}${cell(m.title)}${cell(m.level)}
        ${cell(m.class)}<td class="cmp-c cmp-valor" title="клик — копировать">${m.valor == null ? "—" : m.valor}</td>
        <td class="cmp-act">${IS_ADMIN ? `<button class="cmp-ed" data-id="${m.id}" title="править">✎</button>` : ""}</td>
      </tr>`).join("");
  }

  function renderRows() {
    DATA.members.forEach((m, i) => { m._i = i; });
    const box = $("cmp-rows");
    box.innerHTML =
      `<table class="cmp-table"><thead><tr>
        <th>#</th><th>Ник / распознавание</th><th>Имя</th><th>Должн.</th>
        <th>Титул</th><th>Ур</th><th>Класс</th><th>Добл</th><th></th>
      </tr></thead><tbody>${rowsHtml(DATA.members)}</tbody></table>`;
    bindRows();
  }

  function applyFilter() {
    const q = ($("cmp-filter").value || "").trim().toLowerCase();
    const onlySus = $("cmp-suspect").checked;
    const list = DATA.members.filter(m => {
      if (onlySus && !(m.flag_ocr_suspect || !m.in_registry)) return false;
      if (!q) return true;
      return [m.nick, m.true_name, m.class, m.title, m.rank]
        .some(v => (v || "").toLowerCase().includes(q));
    });
    $("cmp-rows").querySelector("tbody").innerHTML = rowsHtml(list);
    bindRows();
  }

  function bindRows() {
    const tbody = $("cmp-rows").querySelector("tbody");
    if (!tbody) return;
    // копирование значений
    tbody.querySelectorAll(".cmp-c, .cmp-nick-t").forEach(c =>
      c.addEventListener("click", () => copy(c.textContent.trim())));
    // клик по строке (не по кнопке/значению) → подскролить скрины к кадру
    tbody.querySelectorAll(".cmp-row").forEach(tr => {
      tr.addEventListener("click", (e) => {
        if (e.target.closest(".cmp-ed") || e.target.closest(".cmp-c") ||
            e.target.closest(".cmp-nick-t")) return;
        scrollToFrame(+tr.dataset.i);
        tbody.querySelectorAll(".cmp-row-on").forEach(x => x.classList.remove("cmp-row-on"));
        tr.classList.add("cmp-row-on");
      });
    });
    if (IS_ADMIN) tbody.querySelectorAll(".cmp-ed").forEach(b =>
      b.addEventListener("click", () => openEdit(+b.dataset.id)));
  }

  // Примерный кадр для строки i: пропорция позиции среди всех строк.
  function scrollToFrame(i) {
    const shots = DATA.screenshots; if (!shots.length) return;
    const fi = Math.min(shots.length - 1,
      Math.round(i / Math.max(1, DATA.members.length - 1) * (shots.length - 1)));
    const el = $("cmp-shots").querySelector(`.cmp-shot[data-idx="${shots[fi].idx}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("cmp-shot-on");
      setTimeout(() => el.classList.remove("cmp-shot-on"), 1600);
    }
  }

  // ── Правка строки (админ) ──
  function openEdit(id) {
    const m = DATA.members.find(x => x.id === id); if (!m) return;
    const ov = $("cmp-edit");
    const f = (lbl, key, val, type) =>
      `<label class="ce-f"><span>${lbl}</span>
        <input data-k="${key}" type="${type || "text"}" value="${esc(val == null ? "" : val)}"></label>`;
    ov.innerHTML =
      `<div class="ce-box">
        <div class="ce-h">Правка строки · <b>${esc(m.nick)}</b></div>
        ${f("Ник", "nick", m.nick)}
        ${f("Имя (true_name)", "true_name", m.true_name)}
        ${f("Должность", "rank", m.rank)}
        ${f("Титул", "title", m.title)}
        ${f("Уровень", "level", m.level, "number")}
        ${f("Класс", "class", m.class)}
        ${f("Доблесть", "valor", m.valor, "number")}
        <label class="ce-f ce-chk"><input data-k="is_afk" type="checkbox" ${m.is_afk ? "checked" : ""}> АФК</label>
        <div class="ce-btns">
          <button id="ce-save" class="ce-save">Сохранить</button>
          <button id="ce-cancel" class="ce-cancel">Отмена</button>
        </div>
        <div class="ce-msg" id="ce-msg"></div>
      </div>`;
    ov.hidden = false;
    ov.querySelector("#ce-cancel").onclick = () => { ov.hidden = true; };
    ov.onclick = (e) => { if (e.target === ov) ov.hidden = true; };
    ov.querySelector("#ce-save").onclick = async () => {
      const fields = {};
      ov.querySelectorAll("[data-k]").forEach(inp => {
        const k = inp.dataset.k;
        if (k === "is_afk") fields[k] = inp.checked;
        else if (inp.type === "number") fields[k] = inp.value === "" ? null : parseInt(inp.value, 10);
        else fields[k] = inp.value;
      });
      const msg = ov.querySelector("#ce-msg"); msg.textContent = "Сохранение…";
      try {
        await API.valorMemberEdit(id, fields);
        // обновим локальные данные и таблицу
        Object.assign(m, {
          nick: fields.nick, true_name: fields.true_name, rank: fields.rank,
          title: fields.title, level: fields.level, class: fields.class,
          valor: fields.valor, is_afk: fields.is_afk,
        });
        ov.hidden = true;
        toast("Сохранено: " + m.nick);
        applyFilter();
      } catch (e) {
        msg.textContent = "Ошибка: " + (e.detail || e.message);
      }
    };
  }

  // ── Папки недель ──
  try {
    const weeks = await API.valorScreenshotWeeks();
    $("vs-loading").hidden = true;
    if (!weeks.length) { $("vs-empty").hidden = false; return; }
    $("vs-weeks").innerHTML = weeks.map(w =>
      `<button class="vs-folder" data-week="${esc(w.week)}">
         <span class="vs-folder-ic">📁</span>
         <span class="vs-folder-w">${esc(w.week)}</span>
         <span class="vs-folder-c">${w.count} кадр.</span></button>`).join("");
    $("vs-weeks").querySelectorAll(".vs-folder").forEach(el =>
      el.addEventListener("click", () => loadWeek(el.dataset.week, el)));
    $("cmp-filter").addEventListener("input", applyFilter);
    $("cmp-suspect").addEventListener("change", applyFilter);
    const first = $("vs-weeks").querySelector(".vs-folder");
    if (first) loadWeek(first.dataset.week, first);
  } catch (e) {
    $("vs-loading").textContent = "Ошибка загрузки: " + (e.detail || e.message);
  }
})();
