// fetch с cookies. API_URL берётся из config.js.
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

  window.API = {
    me:            () => request("GET",  "/auth/me"),
    logout:        () => request("POST", "/auth/logout"),
    loginOfficer:  (game_nick, password) => request("POST", "/auth/login", { game_nick, password }),
    loginAdmin:    (username, password)  => request("POST", "/auth/admin/login", { username, password }),
    setOfficerPwd: (new_password)        => request("POST", "/auth/admin/officer-password", { new_password }),
    updateAdmin:   (payload)             => request("POST", "/auth/admin/credentials", payload),

    list:          () => request("GET",  "/acceptances"),
    create:        (payload) => request("POST",  "/acceptances", payload),
    update:        (id, payload) => request("PATCH", `/acceptances/${id}`, payload),
    remove:        (id) => request("DELETE", `/acceptances/${id}`),

    audit:         (limit = 200) => request("GET", `/audit?limit=${limit}`),
    auditDelete:   (id) => request("DELETE", `/audit/${id}`),
    auditClear:    () => request("DELETE", `/audit`),

    snapshotList:    () => request("GET",  "/admin/snapshots"),
    snapshotCreate:  () => request("POST", "/admin/snapshots"),
    snapshotRestore: (name) => request("POST", `/admin/snapshots/${encodeURIComponent(name)}/restore`),
    snapshotDelete:  (name) => request("DELETE", `/admin/snapshots/${encodeURIComponent(name)}`),
  };
})();
