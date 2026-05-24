// Matrix-style rain. Самодостаточный модуль — повесил на window и забыл.
(function () {
  const canvas = document.getElementById("matrix-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  // Микс из японской каны, кириллицы и латиницы/цифр — оригинальный матричный шум.
  const GLYPHS = "アイウエオカキクケコサシスセソタチツテトナニヌネノABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789СТАЛКЕРZONESDEVIL".split("");

  let cols = 0;
  let drops = [];
  const FONT_SIZE = 16;

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    cols = Math.floor(canvas.width / FONT_SIZE);
    drops = Array(cols).fill(0).map(() => Math.random() * -canvas.height / FONT_SIZE);
  }

  function draw() {
    ctx.fillStyle = "rgba(0, 0, 0, 0.08)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.font = FONT_SIZE + "px 'Cascadia Code', 'Consolas', monospace";

    for (let i = 0; i < cols; i++) {
      const ch = GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
      const x = i * FONT_SIZE;
      const y = drops[i] * FONT_SIZE;

      // Голова дождя — ярко-зелёная, остальное темнее.
      ctx.fillStyle = "rgba(180, 255, 200, 0.95)";
      ctx.fillText(ch, x, y);
      ctx.fillStyle = "rgba(0, 255, 65, 0.55)";
      ctx.fillText(ch, x, y - FONT_SIZE);

      if (y > canvas.height && Math.random() > 0.975) {
        drops[i] = 0;
      }
      drops[i]++;
    }
  }

  resize();
  window.addEventListener("resize", resize);
  setInterval(draw, 55);
})();
