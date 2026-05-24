// Логин: TG Login Widget + VK ID OAuth (code flow через redirect).
(function () {
  const $ = (id) => document.getElementById(id);
  const cfg = window.OFFICERS_CONFIG || {};

  // Если уже залогинены — сразу на главную.
  API.me().then(() => { window.location.href = "index.html"; }).catch(() => {});

  function showError(msg) {
    $("login-error").textContent = msg;
  }

  // ── Telegram Login Widget ──
  // Widget вызывает callback с пейлоадом; шлём его на /auth/tg.
  window.onTelegramAuth = async function (user) {
    try {
      await API.loginTg(user);
      window.location.href = "index.html";
    } catch (e) {
      if (e.status === 403) showError("Этого Telegram-аккаунта нет в списке офицеров.");
      else showError(e.detail || e.message || "Ошибка входа через Telegram");
    }
  };

  if (cfg.TG_LOGIN_BOT) {
    const s = document.createElement("script");
    s.async = true;
    s.src = "https://telegram.org/js/telegram-widget.js?22";
    s.setAttribute("data-telegram-login", cfg.TG_LOGIN_BOT);
    s.setAttribute("data-size", "large");
    s.setAttribute("data-radius", "0");
    s.setAttribute("data-onauth", "onTelegramAuth(user)");
    s.setAttribute("data-request-access", "write");
    $("tg-login-mount").appendChild(s);
  } else {
    $("tg-login-mount").innerHTML =
      '<div style="color: var(--muted); font-size: 11px; letter-spacing: 2px;">TG-логин не настроен (TG_LOGIN_BOT в config.js)</div>';
  }

  // ── VK ID ──
  // Code flow: redirect на oauth.vk.com → возврат с ?code=... → шлём на /auth/vk.
  const REDIRECT_URI = window.location.origin + window.location.pathname;

  $("vk-login-btn").addEventListener("click", () => {
    if (!cfg.VK_APP_ID) {
      showError("VK-логин не настроен (VK_APP_ID в config.js)");
      return;
    }
    const url = new URL("https://oauth.vk.com/authorize");
    url.searchParams.set("client_id", cfg.VK_APP_ID);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("v", "5.199");
    url.searchParams.set("display", "page");
    window.location.href = url.toString();
  });

  // Возврат с VK с ?code=...
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  if (code) {
    // Чистим строку запроса чтобы не повторить обмен при F5.
    history.replaceState({}, "", REDIRECT_URI);
    API.loginVk(code, REDIRECT_URI)
      .then(() => { window.location.href = "index.html"; })
      .catch((e) => {
        if (e.status === 403) showError("Этого VK-аккаунта нет в списке офицеров.");
        else showError(e.detail || e.message || "Ошибка входа через VK");
      });
  }

  const error = params.get("error");
  if (error) {
    showError(`VK: ${params.get("error_description") || error}`);
    history.replaceState({}, "", REDIRECT_URI);
  }
})();
