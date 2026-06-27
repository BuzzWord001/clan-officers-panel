"""Локальный скрин santdevil.com/clan-valor.html (гость) → site_shot.png.
Снимаем на ПК (RAM хватает), потом кладём в образ — VM не рендерит."""
import base64, time, sys
from selenium import webdriver
from selenium.webdriver.chrome.options import Options

URL = "https://santdevil.com/clan-valor.html"
W = 1100
OUT = sys.argv[1] if len(sys.argv) > 1 else "site_shot.png"

opts = Options()
opts.add_argument("--headless=new")
opts.add_argument("--disable-gpu")
opts.add_argument("--hide-scrollbars")
opts.add_argument(f"--window-size={W},2000")
d = webdriver.Chrome(options=opts)
try:
    d.get(URL)
    deadline = time.time() + 14
    while time.time() < deadline:
        n = d.execute_script("var t=document.getElementById('valor-tbody');return t?t.children.length:0;")
        if n and int(n) > 0:
            break
        time.sleep(0.5)
    d.execute_script("document.documentElement.classList.remove('booting');")
    d.execute_script("return document.fonts && document.fonts.ready;")
    time.sleep(1.2)
    title = d.execute_script("return document.title||''")
    height = d.execute_script("""
        var t=document.getElementById('valor-tbody');
        if(t&&t.children.length>=1){var i=Math.min(4,t.children.length)-1;
        var r=t.children[i].getBoundingClientRect();return Math.ceil(r.bottom+16);}
        return 1460;""") or 1460
    height = max(700, min(int(height), 2200))
    res = d.execute_cdp_cmd("Page.captureScreenshot", {
        "format": "png", "captureBeyondViewport": True,
        "clip": {"x": 0, "y": 0, "width": W, "height": height, "scale": 1}})
    open(OUT, "wb").write(base64.b64decode(res["data"]))
    print(f"OK title={title!r} h={height} -> {OUT}")
finally:
    d.quit()
