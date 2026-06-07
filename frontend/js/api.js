// fetch с cookies + Bearer-fallback. API_URL берётся из config.js.
//
// Cookie работает в Chrome/Edge с дефолтными настройками. В Firefox ETP,
// Brave, Yandex Browser, Chrome без 3p-cookies SameSite=None блокируется —
// поэтому login возвращает токен в body, фронт его кладёт в localStorage и
// шлёт в Authorization: Bearer. Cookie всё равно ставится — если доехала,
// браузер её сам приложит.
(function () {
  const BASE = (window.OFFICERS_CONFIG && window.OFFICERS_CONFIG.API_URL) || "";
  const TOKEN_KEY = "officer_session_token";

  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (_) { return ""; }
  }
  function setToken(t) {
    try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch (_) {}
  }

  // Best-effort: даже если основной fetch упал (РФ-блокировка, TLS, CORS),
  // попробуем отправить причину в telemetry. Если и она не дойдёт — кладём
  // запись в localStorage queue, выкатим при следующем успешном connect.
  function dropTelemetry(kind, message, url) {
    const payload = JSON.stringify({ kind, message: String(message).slice(0, 500), url });
    const ep = BASE + "/telemetry/connect-error";
    // sendBeacon работает в background и не показывает ошибок пользователю.
    try {
      if (navigator.sendBeacon) {
        const blob = new Blob([payload], { type: "application/json" });
        if (navigator.sendBeacon(ep, blob)) return;
      }
    } catch (_) {}
    // Фолбэк через fetch без credentials (preflight проще), без await.
    try {
      fetch(ep, {
        method: "POST", mode: "cors", credentials: "omit", keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: payload,
      }).catch(() => {
        // Совсем не достучались — копим в localStorage.
        try {
          const q = JSON.parse(localStorage.getItem("telemetryQueue") || "[]");
          q.push({ kind, message: String(message).slice(0, 500), url, at: Date.now() });
          localStorage.setItem("telemetryQueue", JSON.stringify(q.slice(-50)));
        } catch (_) {}
      });
    } catch (_) {}
  }

  // При успешном connect выгребаем накопленную очередь.
  function flushTelemetryQueue() {
    let q;
    try { q = JSON.parse(localStorage.getItem("telemetryQueue") || "[]"); } catch (_) { return; }
    if (!q || !q.length) return;
    localStorage.removeItem("telemetryQueue");
    for (const r of q) {
      dropTelemetry(r.kind || "queued", `[delayed ${r.at}] ${r.message || ""}`, r.url || "");
    }
  }

  async function request(method, path, body) {
    const init = {
      method,
      credentials: "include",
      headers: { "Accept": "application/json" },
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers["Content-Type"] = "application/json";
    }
    // Bearer фолбэк — если cookie доехала, сервер всё равно её предпочтёт.
    const tok = getToken();
    if (tok) init.headers["Authorization"] = "Bearer " + tok;
    let res;
    try {
      res = await fetch(BASE + path, init);
    } catch (netErr) {
      // Чистый network error (TLS, CORS, DNS, offline). Запрос даже до
      // сервера не дошёл — пробуем оповестить telemetry-endpoint.
      dropTelemetry("connect_error", netErr && netErr.message || "fetch failed", path);
      const err = new Error("Сервер недоступен — проверь интернет или попробуй позже");
      err.status = 0;
      err.detail = "network_error";
      throw err;
    }
    // Дошли до сервера — флашим накопленные ошибки прошлых попыток.
    flushTelemetryQueue();
    if (res.status === 204) return null;
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = { detail: text }; }
    if (!res.ok) {
      const err = new Error((data && data.detail) || res.statusText);
      err.status = res.status;
      err.detail = data && data.detail;
      throw err;
    }
    return data;
  }

  // Login сохраняет токен в localStorage (фолбэк на случай если cookie не доедет).
  async function loginAndStore(path, payload) {
    const data = await request("POST", path, payload);
    if (data && data.token) setToken(data.token);
    return data;
  }

  // ── Отображение «Ценности для клана» как игровой валюты ──
  // Внутренний счёт ≈0..200; для игроков умножаем на MULT (большие приятные
  // числа) и показываем с золотой монетой. Чисто визуально, логику не трогает.
  window.ClanValue = {
    MULT: 100,
    num(v) { return Math.round((Number(v) || 0) * this.MULT); },
    fmt(v) { return this.num(v).toLocaleString("ru-RU"); },
    // Золотая монета (CSS-иконка) + золотое число со свечением.
    coin() { return `<span class="gold-coin" aria-hidden="true"></span>`; },
    badge(v) { return `${this.coin()}<span class="val-gold">${this.fmt(v)}</span>`; },
  };

  window.API = {
    me:            () => request("GET",  "/auth/me"),
    logout:        async () => { try { return await request("POST", "/auth/logout"); } finally { setToken(""); } },
    loginOfficer:  (game_nick, password) => loginAndStore("/auth/login", { game_nick, password }),
    loginGuest:    () => loginAndStore("/auth/guest", {}),
    loginAdmin:    (username, password)  => loginAndStore("/auth/admin/login", { username, password }),
    setOfficerPwd: (new_password)        => request("POST", "/auth/admin/officer-password", { new_password }),
    updateAdmin:   (payload)             => request("POST", "/auth/admin/credentials", payload),

    list:          () => request("GET",  "/acceptances"),
    create:        (payload) => request("POST",  "/acceptances", payload),
    update:        (id, payload) => request("PATCH", `/acceptances/${id}`, payload),
    remove:        (id) => request("DELETE", `/acceptances/${id}`),
    accArchivedList: () => request("GET", "/acceptances/archived"),
    accArchive:    (id, reason) => request("POST", `/acceptances/${id}/archive`, { reason: reason || "" }),
    accUnarchive:  (id) => request("POST", `/acceptances/${id}/unarchive`),

    audit:         (limit = 200) => request("GET", `/audit?limit=${limit}`),
    auditDelete:   (id) => request("DELETE", `/audit/${id}`),
    auditClear:    () => request("DELETE", `/audit`),

    loginLog:        (limit = 200) => request("GET", `/admin/login-log?limit=${limit}`),
    loginLogClear:   () => request("DELETE", "/admin/login-log"),

    snapshotList:    () => request("GET",  "/admin/snapshots"),
    snapshotCreate:  () => request("POST", "/admin/snapshots"),
    snapshotInspect: (name) => request("GET",  `/admin/snapshots/${encodeURIComponent(name)}/inspect`),
    snapshotRestore: (name) => request("POST", `/admin/snapshots/${encodeURIComponent(name)}/restore`),
    snapshotDelete:  (name) => request("DELETE", `/admin/snapshots/${encodeURIComponent(name)}`),

    blocklist:        () => request("GET",  "/admin/blocklist"),
    blocklistAdd:     (payload) => request("POST", "/admin/blocklist", payload),
    blocklistRemove:  (id) => request("DELETE", `/admin/blocklist/${id}`),

    accessLog:        (limit = 500) => request("GET", `/admin/access-log?limit=${limit}`),
    accessLogClear:   () => request("DELETE", "/admin/access-log"),

    resolveIps:       (ips) => request("POST", "/admin/resolve-ips", { ips }),

    telemetry:        (limit = 200) => request("GET", `/admin/telemetry?limit=${limit}`),
    telemetryClear:   () => request("DELETE", "/admin/telemetry"),

    storage:          () => request("GET", "/admin/storage"),

    chatGroups:       () => request("GET", "/chat/groups"),
    chatStats:        () => request("GET", "/chat/stats"),
    chatList:         (params) => {
      // params: { chat_group, date_from, date_to, user, search, before_id, limit }
      const qs = Object.entries(params || {})
        .filter(([_, v]) => v !== undefined && v !== null && v !== "")
        .map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v))
        .join("&");
      return request("GET", "/chat/list" + (qs ? "?" + qs : ""));
    },
    chatMessageDelete: (id) => request("DELETE", `/chat/messages/${id}`),
    chatClearAll:      () => request("DELETE", "/chat/messages?confirm=yes"),
    chatMemberProfile: (q) => request("GET", `/chat/members/profile?q=${encodeURIComponent(q)}`),
    chatMembersActivity: () => request("GET", "/chat/members/activity"),
    chatMembersTimeline: (granularity, chatGroup, includeInactive) => {
      let qs = "granularity=" + encodeURIComponent(granularity || "week");
      if (chatGroup) qs += "&chat_group=" + encodeURIComponent(chatGroup);
      if (includeInactive === false) qs += "&include_inactive=false";
      return request("GET", "/chat/members/timeline?" + qs);
    },

    valorCurrent:   () => request("GET", "/valor/current"),
    valorScreenshotWeeks: () => request("GET", "/valor/screenshots/weeks"),
    valorScreenshots: (week) => request("GET", "/valor/screenshots?week=" + encodeURIComponent(week)),
    valorCompare: (week) => request("GET", "/valor/compare?week=" + encodeURIComponent(week)),
    valorMemberEdit: (id, fields) => request("PATCH", "/valor/member/" + id, fields),
    valorWeights:    () => request("GET", "/valor/weights"),
    valorWeightsSet: (w) => request("PUT", "/valor/weights", w),
    valorSessions:  () => request("GET", "/valor/sessions"),
    valorDeparted:  () => request("GET", "/valor/departed"),
    valorByCanon:   (weeks = 0) => request("GET", "/valor/by-canon?weeks=" + weeks),
    valorTimeline:  (weeks = 12) => request("GET", "/valor/timeline?weeks=" + weeks),
    valorHistory:   (nick, field) => {
      let qs = "nick=" + encodeURIComponent(nick);
      if (field) qs += "&field=" + encodeURIComponent(field);
      return request("GET", "/valor/history?" + qs);
    },
  };
})();
