// Тонкая обёртка над fetch с поддержкой cookies. API URL берётся из config.js.
(function () {
  const BASE = (window.OFFICERS_CONFIG && window.OFFICERS_CONFIG.API_URL) || "";

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
    const res = await fetch(BASE + path, init);
    if (res.status === 204) return null;
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const err = new Error((data && data.detail) || res.statusText);
      err.status = res.status;
      err.detail = data && data.detail;
      throw err;
    }
    return data;
  }

  window.API = {
    me:           () => request("GET", "/auth/me"),
    logout:       () => request("POST", "/auth/logout"),
    loginTg:      (payload) => request("POST", "/auth/tg", payload),
    loginVk:      (code, redirectUri) => request("POST", "/auth/vk", { code, redirect_uri: redirectUri }),
    list:         () => request("GET", "/acceptances"),
    create:       (payload) => request("POST", "/acceptances", payload),
    update:       (id, payload) => request("PATCH", `/acceptances/${id}`, payload),
    remove:       (id) => request("DELETE", `/acceptances/${id}`),
    audit:        (limit = 200) => request("GET", `/audit?limit=${limit}`),
  };
})();
