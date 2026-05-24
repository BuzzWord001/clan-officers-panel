// Логин: TG Login Widget + VK Implicit Flow через popup.
//
// VK Implicit Flow: открываем popup на oauth.vk.com/authorize с response_type=token
// и redirect_uri=oauth.vk.com/blank.html. После авторизации VK редиректит popup
// на blank.html с access_token и user_id в URL fragment. Главное окно ждёт
// смены URL и парсит токен. Никаких кастомных redirect URI и client_secret.
(function () {
  const $ = (id) => document.getElementById(id);
  const cfg = window.OFFICERS_CONFIG || {};

  // Если уже залогинены — сразу на главную.
  API.me().then(() => { window.location.href = "index.html"; }).catch(() => {});

  function showError(msg) {
    $("login-error").textContent = msg;
  }

  // ── Telegram Login Widget ──
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

  // ── VK Implicit Flow (popup) ──
  const VK_REDIRECT = "https://oauth.vk.com/blank.html";
  let pollTimer = null;
  let popup = null;

  function openVkPopup() {
    if (!cfg.VK_APP_ID) {
      showError("VK-логин не настроен (VK_APP_ID в config.js)");
      return;
    }
    const url = new URL("https://oauth.vk.com/authorize");
    url.searchParams.set("client_id", cfg.VK_APP_ID);
    url.searchParams.set("display", "popup");
    url.searchParams.set("redirect_uri", VK_REDIRECT);
    url.searchParams.set("response_type", "token");
    url.searchParams.set("v", "5.199");
    url.searchParams.set("scope", "");
    url.searchParams.set("revoke", "1");

    const w = 700, h = 600;
    const x = (window.screen.width  - w) / 2;
    const y = (window.screen.height - h) / 2;
    popup = window.open(
      url.toString(), "vk_oauth",
      `width=${w},height=${h},left=${x},top=${y}`,
    );

    if (!popup) {
      showError("Popup заблокирован браузером. Разреши popup для этого сайта и попробуй снова.");
      return;
    }

    pollTimer = setInterval(checkVkPopup, 250);
  }

  function checkVkPopup() {
    if (!popup) { stopPolling(); return; }

    if (popup.closed) {
      stopPolling();
      showError("Окно VK закрыто. Попробуй ещё раз.");
      return;
    }

    // Доступ к popup.location.* выбросит SecurityError, пока popup на чужом
    // origin (oauth.vk.com). Как только VK редиректнет на blank.html — origin
    // станет тот же, и мы прочитаем hash.
    let hash = null;
    try {
      const href = popup.location.href || "";
      if (href.startsWith(VK_REDIRECT)) {
        hash = popup.location.hash;
      }
    } catch (_) {
      return;
    }

    if (!hash) return;
    stopPolling();
    popup.close();

    const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
    const error = params.get("error");
    if (error) {
      showError(`VK: ${params.get("error_description") || error}`);
      return;
    }
    const accessToken = params.get("access_token");
    const userId = params.get("user_id");
    if (!accessToken || !userId) {
      showError("VK: токен не получен");
      return;
    }

    API.loginVk(accessToken, parseInt(userId, 10))
      .then(() => { window.location.href = "index.html"; })
      .catch((e) => {
        if (e.status === 403) showError("Этого VK-аккаунта нет в списке офицеров.");
        else showError(e.detail || e.message || "Ошибка входа через VK");
      });
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  $("vk-login-btn").addEventListener("click", openVkPopup);
})();
