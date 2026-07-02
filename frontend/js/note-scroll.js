// Общий «свиток» примечаний о человеке — используется и в таблице Доблести,
// и в Реестре приёма, чтобы примечание выглядело и работало ОДИНАКОВО.
// Данные общие (valor_note_history + acceptances.note синхронны на бэкенде):
//   NoteScroll.renderCell({canon, nick, note, count, isOfficer})  -> HTML ячейки
//   NoteScroll.open({canon, nick, isAdmin, onChange})             -> модалка-свиток
// onChange(data) вызывается после загрузки/правки — страница обновляет свою
// ячейку (data = {notes, current, count}).
(function () {
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function fmtWhen(iso) {
    const p = String(iso || "").split(/[T ]/);
    const d = (p[0] || "").split("-");           // YYYY-MM-DD
    const t = (p[1] || "").slice(0, 5);          // HH:MM (UTC)
    if (d.length !== 3) return esc(iso || "");
    return `${d[2]}.${d[1]}.${d[0]}${t ? " " + t : ""}`;
  }
  const SRC = { registry: "реестр", seed: "реестр" };

  function entryHtml(e, isAdmin) {
    const who = e.author || (e.source === "seed" || e.source === "registry" ? "Реестр" : "—");
    const src = SRC[e.source] ? ` · ${SRC[e.source]}` : "";
    const del = isAdmin
      ? `<button class="ns-del" data-id="${e.id}" title="Удалить запись">✕</button>` : "";
    return `<div class="ns-entry">
      <div class="ns-meta"><span class="ns-when">${fmtWhen(e.created_at)}</span>
        <span class="ns-who">${esc(who)}${src}</span>${del}</div>
      <div class="ns-text">${esc(e.text)}</div>
    </div>`;
  }

  let OV = null;
  function close() { if (OV) { OV.remove(); OV = null; } }
  document.addEventListener("keydown", e => { if (e.key === "Escape") close(); });

  const NoteScroll = {
    // HTML ячейки примечания в таблице (Доблесть/Реестр).
    renderCell({ canon, nick, note, count, isOfficer }) {
      note = note || ""; count = count || 0;
      const dc = esc(canon), dn = esc(nick);
      if (!isOfficer) {
        return `<span class="cn-text" title="${esc(note)}">${esc(note)}</span>`;
      }
      if (!note) {
        return `<button type="button" class="cn-add" data-canon="${dc}" data-nick="${dn}"
          title="Добавить примечание" aria-label="Добавить примечание">+</button>`;
      }
      const short = note.length > 64 ? note.slice(0, 64) + "…" : note;
      const badge = count > 1
        ? `<span class="cn-badge" title="${count} записей в истории">${count}</span>` : "";
      return `<button type="button" class="cn-open" data-canon="${dc}" data-nick="${dn}"
          title="${esc(note)} · клик — история примечаний">
          <span class="cn-scroll" aria-hidden="true">📜</span><span class="cn-preview">${esc(short)}</span>${badge}</button>`;
    },

    // Открыть модалку-свиток истории примечаний.
    open({ canon, nick, isAdmin, onChange }) {
      close();
      const ov = document.createElement("div");
      ov.className = "ns-ov";
      ov.innerHTML = `
        <div class="ns-scroll" role="dialog" aria-modal="true">
          <div class="ns-cap ns-cap-top"></div>
          <div class="ns-sheet">
            <button class="ns-close" title="Закрыть">✕</button>
            <div class="ns-title">📜 Свиток · <b>${esc(nick)}</b></div>
            <div class="ns-sub">Летопись примечаний. Общая для Реестра и таблицы Доблести.</div>
            <div class="ns-list"><div class="ns-empty">Загрузка…</div></div>
            <div class="ns-add">
              <textarea class="ns-input" rows="2" maxlength="2000"
                placeholder="Вписать новую строку в свиток…  (Ctrl+Enter — добавить)"></textarea>
              <button class="ns-save" type="button">✒ Вписать</button>
            </div>
          </div>
          <div class="ns-cap ns-cap-bot"></div>
        </div>`;
      document.body.appendChild(ov);
      OV = ov;
      const box = ov.querySelector(".ns-scroll");
      ov.addEventListener("click", e => { if (e.target === ov) close(); });
      box.querySelector(".ns-close").onclick = close;

      const listEl = box.querySelector(".ns-list");
      function render(data) {
        const notes = (data && data.notes) || [];
        listEl.innerHTML = notes.length
          ? notes.map(e => entryHtml(e, isAdmin)).join("")
          : `<div class="ns-empty">Пока пусто — первая запись откроет свиток.</div>`;
        listEl.scrollTop = listEl.scrollHeight;
        if (onChange) onChange(data);
      }

      API.valorNotes(canon).then(render).catch(e => {
        listEl.innerHTML = `<div class="ns-empty">Ошибка: ${esc(e.detail || e.message)}</div>`;
      });

      const input = box.querySelector(".ns-input");
      const save = box.querySelector(".ns-save");
      async function doAdd() {
        const text = input.value.trim();
        if (!text) { input.focus(); return; }
        save.disabled = true;
        try {
          const data = await API.valorNoteAdd(canon, text);
          input.value = ""; render(data);
        } catch (e) {
          alert("Не удалось сохранить: " + (e.detail || e.message));
        } finally { save.disabled = false; }
      }
      save.onclick = doAdd;
      input.addEventListener("keydown", e => {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); doAdd(); }
      });
      setTimeout(() => input.focus(), 30);

      listEl.addEventListener("click", async e => {
        const del = e.target.closest(".ns-del");
        if (!del) return;
        if (!confirm("Удалить эту запись из свитка? (реестр пересинхронизируется)")) return;
        try {
          const data = await API.valorNoteDelete(del.dataset.id, canon);
          render(data);
        } catch (err) {
          alert("Не удалось удалить: " + (err.detail || err.message));
        }
      });
    },
    close,
  };
  window.NoteScroll = NoteScroll;
})();
