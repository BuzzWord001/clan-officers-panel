// Архив скринов сбора доблести — папки по неделям, доступ офицерам/админу.
(async function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

  let me;
  try { me = await API.me(); }
  catch (_) { location.href = "login.html"; return; }
  if (!me || me.role === "guest") { location.href = "clan-valor.html"; return; }
  $("who").textContent = (me.username || me.name || "") +
    (me.role === "admin" ? " · админ" : " · офицер");
  document.body.setAttribute("data-role", me.role || "");
  $("logout-btn").addEventListener("click", async () => {
    try { await API.logout(); } catch (_) {}
    location.href = "login.html";
  });

  // Лайтбокс — клик по миниатюре открывает полный кадр.
  const lb = $("vs-lightbox"), lbImg = $("vs-lightbox-img");
  lb.addEventListener("click", () => { lb.hidden = true; lbImg.src = ""; });
  function openLightbox(url) { lbImg.src = url; lb.hidden = false; }

  function fmtWeek(w) { return w; }   // «2026-W23» как есть

  let openWeek = null;

  async function showWeek(week, cardEl) {
    document.querySelectorAll(".vs-folder").forEach(e => e.classList.remove("vs-folder-on"));
    if (cardEl) cardEl.classList.add("vs-folder-on");
    const view = $("vs-view");
    if (openWeek === week) {          // повторный клик — свернуть
      openWeek = null; view.innerHTML = "";
      if (cardEl) cardEl.classList.remove("vs-folder-on");
      return;
    }
    openWeek = week;
    view.innerHTML = `<div class="chat-loading">Загрузка скринов недели ${esc(week)}…</div>`;
    try {
      const data = await API.valorScreenshots(week);
      const shots = data.shots || [];
      if (!shots.length) { view.innerHTML = `<div class="empty">У недели ${esc(week)} скринов нет.</div>`; return; }
      view.innerHTML =
        `<div class="vs-view-head">📂 <b>${esc(week)}</b> — ${shots.length} кадр(ов). Клик по кадру — открыть крупно.</div>` +
        `<div class="vs-grid">` + shots.map(s =>
          `<div class="vs-thumb"><img loading="lazy" src="${esc(s.url)}" alt="кадр ${s.idx}" data-full="${esc(s.url)}">` +
          `<span class="vs-thumb-n">#${s.idx}</span></div>`).join("") + `</div>`;
      view.querySelectorAll(".vs-thumb img").forEach(img =>
        img.addEventListener("click", () => openLightbox(img.dataset.full)));
    } catch (e) {
      view.innerHTML = `<div class="empty">Ошибка: ${esc(e.detail || e.message)}</div>`;
    }
  }

  try {
    const weeks = await API.valorScreenshotWeeks();
    $("vs-loading").hidden = true;
    if (!weeks.length) { $("vs-empty").hidden = false; return; }
    const box = $("vs-weeks");
    box.innerHTML = weeks.map(w =>
      `<button class="vs-folder" data-week="${esc(w.week)}">` +
        `<span class="vs-folder-ic">📁</span>` +
        `<span class="vs-folder-w">${esc(w.week)}</span>` +
        `<span class="vs-folder-c">${w.count} кадр.</span></button>`).join("");
    box.querySelectorAll(".vs-folder").forEach(el =>
      el.addEventListener("click", () => showWeek(el.dataset.week, el)));
    // Сразу открыть самую свежую неделю.
    const first = box.querySelector(".vs-folder");
    if (first) showWeek(first.dataset.week, first);
  } catch (e) {
    $("vs-loading").textContent = "Ошибка загрузки: " + (e.detail || e.message);
  }
})();
