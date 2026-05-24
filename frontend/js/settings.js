// Admin Settings — смена паролей.
(async function () {
  const $ = (id) => document.getElementById(id);

  let me;
  try { me = await API.me(); } catch (_) { window.location.href = "admin_login.html"; return; }
  if (me.role !== "admin") {
    alert("Эта страница доступна только администратору.");
    window.location.href = "index.html";
    return;
  }
  $("who").textContent = `ADMIN :: ${me.name}`;
  $("logout-btn").addEventListener("click", async () => {
    try { await API.logout(); } catch (_) {}
    window.location.href = "admin_login.html";
  });

  function flash(el, text, ok) {
    el.textContent = text;
    el.style.color = ok ? "var(--accent)" : "var(--danger)";
    setTimeout(() => { el.textContent = ""; }, 5000);
  }

  // ── Officer password ──
  $("officer-pwd-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const a = $("op-new").value;
    const b = $("op-confirm").value;
    const status = $("op-status");
    if (a !== b) { flash(status, "Пароли не совпадают.", false); return; }
    try {
      await API.setOfficerPwd(a);
      $("op-new").value = "";
      $("op-confirm").value = "";
      flash(status, "✓ Новый пароль офицеров сохранён.", true);
    } catch (e) {
      flash(status, e.detail || e.message || "Ошибка", false);
    }
  });

  // ── Admin credentials ──
  $("admin-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const status = $("a-status");
    const payload = { current_password: $("a-current").value };
    const u = $("a-new-user").value.trim();
    const p = $("a-new-pwd").value;
    if (u) payload.new_username = u;
    if (p) payload.new_password = p;
    if (!u && !p) { flash(status, "Заполни хотя бы одно поле для смены.", false); return; }
    try {
      await API.updateAdmin(payload);
      $("a-current").value = "";
      $("a-new-user").value = "";
      $("a-new-pwd").value = "";
      flash(status, "✓ Креды администратора обновлены.", true);
      if (u) {
        setTimeout(() => { window.location.href = "admin_login.html"; }, 1500);
      }
    } catch (e) {
      if (e.status === 401) flash(status, "Текущий пароль неверный.", false);
      else flash(status, e.detail || e.message || "Ошибка", false);
    }
  });
})();
