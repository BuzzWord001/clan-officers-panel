// Логин администратора: username + admin password.
(function () {
  const $ = (id) => document.getElementById(id);

  const form = $("admin-form");
  const btn = $("admin-btn");
  const errBox = $("login-error");

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (!form.checkValidity()) { form.reportValidity(); return; }
    errBox.textContent = "";
    btn.disabled = true;
    const originalLabel = btn.textContent;
    btn.textContent = "Проверка…";

    const username = $("a-user").value.trim();
    const password = $("a-password").value;

    try {
      await API.loginAdmin(username, password);
      window.location.href = "settings.html";
    } catch (e) {
      if (e.status === 401) errBox.textContent = "Неверный логин или пароль.";
      else errBox.textContent = e.detail || e.message || "Ошибка входа.";
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  });
})();
