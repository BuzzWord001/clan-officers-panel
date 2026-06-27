// Вкладка «Архив доблести» — список всех weekly-снимков.
// В будущем: клик по строке → галерея R2-скринов этой сессии.
(async function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
  const fmtDT = (s) => {
    if (!s) return "";
    try {
      return s.replace("T", " ").substring(0, 19);
    } catch { return s; }
  };

  async function loadMe() {
    try {
      const me = await API.me();
      // Гость не допущен к архиву доблести (require_officer) — на его раздел.
      if (me.role !== "officer" && me.role !== "admin") {
        location.href = "clan-valor.html";
        return;
      }
      document.documentElement.classList.remove("booting");   // роль ок — показать (анти-вспышка)
      $("who").textContent = me?.role === "admin"
        ? `${esc(me.username)} · админ`
        : `${esc(me.username)} · офицер`;
      // CSS-гейт: body[data-role=admin] показывает вкладку «Настройки».
      document.body.setAttribute("data-role", me?.role || "");
    } catch { location.href = "login.html"; }
  }

  $("logout-btn").addEventListener("click", async () => {
    try { await API.logout(); } catch (_) {}
    location.href = "login.html";
  });

  async function load() {
    $("archive-loading").hidden = false;
    let sessions = [];
    try {
      sessions = await API.valorSessions();
    } catch (e) {
      $("archive-tbody").innerHTML = `<tr><td colspan="6" class="m-error">
        Ошибка: ${esc(e.detail || e.message)}</td></tr>`;
      return;
    } finally { $("archive-loading").hidden = true; }
    if (!sessions.length) {
      $("archive-empty").hidden = false;
      $("archive-summary").innerHTML =
        `<span>Снимков ещё нет. Отправь первый из десктоп-приложения «PW Анализ доблести».</span>`;
      return;
    }
    const totalMembers = sessions.reduce((a, s) => a + (s.members_count || 0), 0);
    $("archive-summary").innerHTML = `
      <span>снимков: <b>${sessions.length}</b></span>
      <span>всего записей: <b>${totalMembers}</b></span>
    `;
    $("archive-tbody").innerHTML = sessions.map(s => `
      <tr class="m-row">
        <td><b>${esc(s.week)}</b></td>
        <td>${esc(fmtDT(s.captured_at))}</td>
        <td class="m-cell-num">${s.valor_norm}</td>
        <td class="m-cell-num">${s.screens_count || 0}</td>
        <td class="m-cell-num">${s.members_count}</td>
        <td>${esc(s.notes || "")}</td>
      </tr>
    `).join("");
  }

  loadMe();
  load();
})();
