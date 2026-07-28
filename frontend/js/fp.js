/* Пассивный сбор отпечатка устройства визитёра (часовой пояс браузера и пр.).
   Часовой пояс VPN НЕ прячет — помогает вычислить, кто заходит за ссылками на чаты
   (по поясу + модели устройства даже за VPN). Работает тихо, один раз за визит. */
(function () {
  try {
    if (window.__fpSent) return;
    window.__fpSent = true;
    var BASE = (window.OFFICERS_CONFIG && window.OFFICERS_CONFIG.API_URL) || "";
    var tz = "";
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) {}
    var body = {
      tz: tz,
      tz_offset: (new Date()).getTimezoneOffset(),           // минуты; UTC+4 = -240
      lang: (navigator.language || navigator.userLanguage || ""),
      platform: (navigator.platform || ""),
      screen: (screen.width + "x" + screen.height),
      dev_mem: String(navigator.deviceMemory || ""),
      hw_cores: String(navigator.hardwareConcurrency || ""),
      touch: (("ontouchstart" in window) || navigator.maxTouchPoints > 0),
      url: (location.pathname || "").slice(0, 200)
    };
    // отложим на 1.5с после загрузки, чтобы не мешать основной странице
    setTimeout(function () {
      try {
        fetch(BASE + "/telemetry/fp", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          keepalive: true
        }).catch(function () {});
      } catch (e) {}
    }, 1500);
  } catch (e) {}
})();
