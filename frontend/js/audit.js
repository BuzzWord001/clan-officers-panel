// История изменений.
(async function () {
  const $ = (id) => document.getElementById(id);

  let me;
  try {
    me = await API.me();
  } catch (_) { window.location.href = "login.html"; return; }

  // Гость сюда не допущен (аудит — офицерам/админу) — на его раздел.
  if (me.role !== "officer" && me.role !== "admin") {
    window.location.href = "clan-valor.html";
    return;
  }

  const roleLabel = me.role === "admin" ? "АДМИНИСТРАТОР"
                  : me.role === "officer" ? "ОФИЦЕР" : me.role.toUpperCase();
  $("who").textContent = `${roleLabel} • ${me.name}`;
  // CSS-гейт админ-группы вкладок через body[data-role].
  document.body.setAttribute("data-role", me.role);
  const isAdmin = me.role === "admin";
  if (isAdmin) {
    $("clear-all").hidden = false;
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

  const FIELD_RU = {
    game_nick: "ник",
    title: "титул",
    accepted_date: "дата",
    note: "примечание",
  };
  const ACTION_RU = { create: "ДОБАВЛЕНО", update: "ИЗМЕНЕНО", delete: "УДАЛЕНО",
    archive: "В АРХИВ", unarchive: "ИЗ АРХИВА",
    warn_add: "ПРЕДУПР. +", warn_remove: "ПРЕДУПР. −",
    afk_on: "АФК ВКЛ", afk_off: "АФК ВЫКЛ" };

  function diffLines(before, after) {
    const keys = ["game_nick", "title", "accepted_date", "note"];
    const out = [];
    for (const k of keys) {
      const b = before ? before[k] : undefined;
      const a = after  ? after[k]  : undefined;
      if (b !== a) {
        out.push(`${FIELD_RU[k] || k}: «${b ?? ""}» → «${a ?? ""}»`);
      }
    }
    return out.length ? out.join("\n") : "—";
  }

  function summarise(item) {
    if (item.action === "create" && item.after) {
      return `${item.after.game_nick} — принят ${DateRu.fmtRus(item.after.accepted_date)}`;
    }
    if (item.action === "delete" && item.before) {
      return `${item.before.game_nick} — принят ${DateRu.fmtRus(item.before.accepted_date)}`;
    }
    return diffLines(item.before, item.after);
  }

  async function reload() {
    try {
      const data = await API.audit(200);
      render(data);
    } catch (e) {
      $("audit-list").innerHTML = `<div class="empty">Ошибка: ${e.detail || e.message}</div>`;
    }
  }

  function render(data) {
    const list = $("audit-list");
    list.innerHTML = "";
    if (!data.length) {
      $("empty-state").hidden = false;
      return;
    }
    $("empty-state").hidden = true;

    for (const it of data) {
      const div = document.createElement("div");
      div.className = "audit-item";
      div.dataset.id = it.id;
      div.innerHTML = `
        <div class="head">
          <span><span class="action ${it.action}">${ACTION_RU[it.action] || it.action.toUpperCase()}</span>
            • <span class="nick" style="color: var(--accent)"></span></span>
          <span>
            <span class="actor"></span>
            <button class="audit-del" hidden title="Удалить запись из истории">×</button>
          </span>
        </div>
        <div class="diff"></div>
      `;
      div.querySelector(".nick").textContent = it.game_nick || `#${it.acceptance_id || "?"}`;
      div.querySelector(".actor").textContent =
        `${fmtTs(it.timestamp)} • ${it.actor_name}`;
      div.querySelector(".diff").textContent = summarise(it);

      if (isAdmin && (it.actor_ip || it.actor_user_agent)) {
        const meta = document.createElement("div");
        meta.className = "audit-meta";
        const ip = it.actor_ip || "—";
        const ua = (it.actor_user_agent || "—").slice(0, 120);
        meta.textContent = `IP: ${ip}    UA: ${ua}`;
        div.appendChild(meta);
      }

      if (isAdmin) {
        const btn = div.querySelector(".audit-del");
        btn.hidden = false;
        btn.addEventListener("click", async () => {
          if (!confirm("Удалить эту запись из истории?")) return;
          try {
            await API.auditDelete(it.id);
            await reload();
          } catch (e) {
            alert(`Не удалось удалить: ${e.detail || e.message}`);
          }
        });
      }
      list.appendChild(div);
    }
  }

  $("clear-all").addEventListener("click", async () => {
    if (!confirm("Полностью очистить журнал изменений? Это нельзя отменить.")) return;
    try {
      await API.auditClear();
      await reload();
    } catch (e) {
      alert(`Не удалось очистить: ${e.detail || e.message}`);
    }
  });

  await reload();
})();
