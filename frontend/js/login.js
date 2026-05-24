// Логин офицера: ник + общий пароль.
(function () {
  const $ = (id) => document.getElementById(id);
  const NICK_KEY = "officers.last_nick";

  // Если уже залогинены — сразу на главную.
  API.me().then(() => { window.location.href = "index.html"; }).catch(() => {});

  // Подставить последний ник из localStorage, чтобы не вбивать каждый раз.
  const lastNick = localStorage.getItem(NICK_KEY);
  if (lastNick) $("f-nick").value = lastNick;

  const form = $("login-form");
  const btn = $("login-btn");
  const errBox = $("login-error");

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    errBox.textContent = "";
    btn.disabled = true;
    const originalLabel = btn.textContent;
    btn.textContent = "Проверка…";

    const nick = $("f-nick").value.trim();
    const password = $("f-password").value;

    try {
      await API.loginOfficer(nick, password);
      localStorage.setItem(NICK_KEY, nick);
      window.location.href = "index.html";
    } catch (e) {
      if (e.status === 401) errBox.textContent = "Неверный пароль.";
      else if (e.status === 422) errBox.textContent = "Ник в неправильном формате.";
      else errBox.textContent = e.detail || e.message || "Ошибка входа.";
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  });
})();
