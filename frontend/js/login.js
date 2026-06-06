// Логин офицера: ник + общий пароль.
(function () {
  const $ = (id) => document.getElementById(id);
  const NICK_KEY = "officers.last_nick";

  // Если уже залогинены — сразу на главную (гостя — на таблицу Доблести,
  // т.к. index.html ему недоступен и был бы цикл редиректов).
  API.me().then((me) => {
    window.location.href = me && me.role === "guest"
      ? "clan-valor.html" : "index.html";
  }).catch(() => {});

  // Подставить последний ник из localStorage, чтобы не вбивать каждый раз.
  const lastNick = localStorage.getItem(NICK_KEY);
  if (lastNick) $("f-nick").value = lastNick;

  const form = $("login-form");
  const btn = $("login-btn");
  const errBox = $("login-error");

  // Сообщение, когда браузер режет и cookie, и localStorage (приватный режим
  // или встроенный браузер Telegram/VK) — вход физически не может удержаться.
  const BLOCKED_MSG =
    "Браузер блокирует вход. Откройте ссылку в обычном браузере " +
    "(меню «⋯» → «Открыть в Chrome/Safari»), а не во встроенном окне Telegram или VK.";

  // Подтверждаем, что сессия реально установилась (cookie ИЛИ Bearer-токен),
  // ПЕРЕД переходом на защищённую страницу. Иначе там me() вернёт 401 и
  // человека молча выкинет обратно на вход — это и выглядело как
  // «кнопка гостевого входа не работает».
  async function sessionEstablished(expectRoles) {
    try {
      const me = await API.me();
      return !!(me && expectRoles.includes(me.role));
    } catch (_) {
      return false;
    }
  }

  // Гостевой вход — без пароля, сразу на таблицу Доблести (только просмотр).
  const guestBtn = $("guest-btn");
  if (guestBtn) {
    guestBtn.addEventListener("click", async () => {
      errBox.textContent = "";
      guestBtn.disabled = true;
      const lbl = guestBtn.querySelector("span").textContent;
      guestBtn.querySelector("span").textContent = "Вход…";
      try {
        await API.loginGuest();
        if (!(await sessionEstablished(["guest"]))) {
          errBox.textContent = BLOCKED_MSG;
        } else {
          window.location.href = "clan-valor.html";
          return;
        }
      } catch (e) {
        errBox.textContent = e.detail || e.message || "Не удалось войти гостем.";
      }
      guestBtn.disabled = false;
      guestBtn.querySelector("span").textContent = lbl;
    });
  }

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
      try { localStorage.setItem(NICK_KEY, nick); } catch (_) {}
      if (!(await sessionEstablished(["officer", "admin"]))) {
        errBox.textContent = BLOCKED_MSG;
      } else {
        window.location.href = "index.html";
        return;
      }
    } catch (e) {
      if (e.status === 401) errBox.textContent = "Неверный пароль.";
      else if (e.status === 422) errBox.textContent = "Ник в неправильном формате.";
      else errBox.textContent = e.detail || e.message || "Ошибка входа.";
    }
    btn.disabled = false;
    btn.textContent = originalLabel;
  });
})();
