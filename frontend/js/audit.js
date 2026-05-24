// История изменений.
(async function () {
  const $ = (id) => document.getElementById(id);

  let me;
  try {
    me = await API.me();
  } catch (e) {
    window.location.href = "login.html";
    return;
  }
  const roleLabel = me.role === "admin" ? "АДМИНИСТРАТОР"
                  : me.role === "officer" ? "ОФИЦЕР" : me.role.toUpperCase();
  $("who").textContent = `${roleLabel} • ${me.name}`;
  if (me.role === "admin") {
    const tab = $("settings-tab");
    if (tab) tab.hidden = false;
  }
  $("logout-btn").addEventListener("click", async () => {
    try { await API.logout(); } catch (_) {}
    window.location.href = "login.html";
  });

  function fmtTs(iso) {
    if (!iso) return "";
    const d = new Date(iso + "Z");
    return d.toLocaleString("ru-RU", {
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  }

  function diffLines(before, after) {
    const keys = ["game_nick", "accepted_date", "note"];
    const out = [];
    for (const k of keys) {
      const b = before ? before[k] : undefined;
      const a = after  ? after[k]  : undefined;
      if (b !== a) {
        out.push(`${k}: ${JSON.stringify(b ?? "")} → ${JSON.stringify(a ?? "")}`);
      }
    }
    return out.length ? out.join("\n") : "—";
  }

  const ACTION_RU = { create: "ДОБАВЛЕНО", update: "ИЗМЕНЕНО", delete: "УДАЛЕНО" };

  function summarise(item) {
    if (item.action === "create" && item.after) {
      return `${item.after.game_nick} — принят ${item.after.accepted_date}`;
    }
    if (item.action === "delete" && item.before) {
      return `${item.before.game_nick} — принят ${item.before.accepted_date}`;
    }
    return diffLines(item.before, item.after);
  }

  try {
    const data = await API.audit(200);
    const list = $("audit-list");
    if (!data.length) {
      $("empty-state").hidden = false;
      return;
    }
    for (const it of data) {
      const div = document.createElement("div");
      div.className = "audit-item";
      div.innerHTML = `
        <div class="head">
          <span><span class="action ${it.action}">${ACTION_RU[it.action] || it.action.toUpperCase()}</span>
            • <span class="nick" style="color: var(--accent)"></span></span>
          <span class="actor"></span>
        </div>
        <div class="diff"></div>
      `;
      div.querySelector(".nick").textContent = it.game_nick || `#${it.acceptance_id || "?"}`;
      div.querySelector(".actor").textContent =
        `${fmtTs(it.timestamp)} • ${it.actor_platform}:${it.actor_name}`;
      div.querySelector(".diff").textContent = summarise(it);
      list.appendChild(div);
    }
  } catch (e) {
    $("audit-list").innerHTML = `<div class="empty">Ошибка: ${e.detail || e.message}</div>`;
  }
})();
