/* Персональный водяной знак: на чувствительных страницах вшивает еле видимую
   повторяющуюся метку с ником/ролью зрителя. Если сольют СКРИН САЙТА — по метке
   вычислим, кто это был (метку не видно глазом, но она проявляется при поднятии
   контраста). Индустриальный приём защиты от утечек. */
(function () {
  function identify(cb) {
    var BASE = (window.OFFICERS_CONFIG && window.OFFICERS_CONFIG.API_URL) || "";
    var opt = { credentials: "include", headers: { "Accept": "application/json" } };
    // 1) игрок очереди
    fetch(BASE + "/queue/me", opt).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && (d.main_nick || d.reg_nick)) { cb(d.main_nick || d.reg_nick); return; }
        // 2) офицер/админ
        fetch(BASE + "/auth/me", opt).then(function (r) { return r.ok ? r.json() : null; })
          .then(function (a) {
            if (a && a.name && a.role !== "guest") { cb(a.name); return; }
            cb("гость");
          }).catch(function () { cb("гость"); });
      }).catch(function () { cb("гость"); });
  }

  function draw(label) {
    try {
      var d = new Date();
      var stamp = ("0" + d.getDate()).slice(-2) + "." + ("0" + (d.getMonth() + 1)).slice(-2)
                + " " + ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
      var text = label + " · " + stamp;
      var canvas = document.createElement("canvas");
      var tile = 260, th = 150;
      canvas.width = tile; canvas.height = th;
      var ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, tile, th);
      ctx.font = "13px system-ui, sans-serif";
      ctx.fillStyle = "rgba(255,255,255,0.05)";       // еле видно (~5%)
      ctx.translate(tile / 2, th / 2);
      ctx.rotate(-28 * Math.PI / 180);
      ctx.textAlign = "center";
      ctx.fillText(text, 0, 0);
      var url = canvas.toDataURL("image/png");
      var ov = document.createElement("div");
      ov.id = "__wm";
      ov.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483000;" +
        "background-image:url(" + url + ");background-repeat:repeat;opacity:1";
      document.body.appendChild(ov);
      // страж: не дать удалить/спрятать через devtools
      setInterval(function () {
        if (!document.getElementById("__wm")) document.body.appendChild(ov);
      }, 4000);
    } catch (e) {}
  }

  function start() {
    if (document.getElementById("__wm")) return;
    identify(function (label) { draw(label); });
  }
  if (document.body) setTimeout(start, 1200);
  else window.addEventListener("DOMContentLoaded", function () { setTimeout(start, 1200); });
})();
