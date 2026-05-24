// Адрес API бэкенда. Подменить после поднятия Cloudflare Tunnel.
window.OFFICERS_CONFIG = {
  API_URL: "https://wear-thickness-valued-cir.trycloudflare.com",
  // Bot username для Telegram Login Widget (без @). Подставится в <script data-telegram-login="...">.
  TG_LOGIN_BOT: "santdevil_officers_bot",
  // VK app_id для Implicit Flow (popup → oauth.vk.com/blank.html → токен).
  // Подойдёт любой Standalone/Web app, кастомные redirect URI не нужны.
  VK_APP_ID: "54607613",
};
