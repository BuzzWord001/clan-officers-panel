// Привязывает к кнопкам .pwd-toggle поведение «показать/скрыть пароль».
// Кнопка должна иметь data-pwd-for="<id поля input type=password>" и содержать
// два SVG: .i-eye (по умолчанию — пароль скрыт) и .i-eye-off (пароль виден).
(function () {
  function bind(btn) {
    const id = btn.dataset.pwdFor;
    const input = document.getElementById(id);
    if (!input) return;

    btn.addEventListener("click", () => {
      const shown = input.type === "text";
      input.type = shown ? "password" : "text";
      btn.classList.toggle("is-on", !shown);
      btn.setAttribute(
        "aria-label",
        shown ? "Показать пароль" : "Скрыть пароль",
      );
      btn.title = shown ? "Показать пароль" : "Скрыть пароль";
      // Возвращаем фокус в поле, чтобы продолжить ввод.
      input.focus();
    });
  }
  document.querySelectorAll(".pwd-toggle").forEach(bind);
})();
