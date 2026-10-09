"""Drives dist/index.html in headless Chromium: plays, changes parameters live, steps, inspects, switches presets
and tabs; fails on any page error. Saves screenshots to tests/shots/.

    python3 tests/browser_check.py [light|dark]   (from app/, after tools/build.py)"""
import os
import sys

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = "/home/ubuntu/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome"
scheme = sys.argv[1] if len(sys.argv) > 1 else "light"
shots = os.path.join(ROOT, "tests", "shots")
os.makedirs(shots, exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROME)
    page = browser.new_page(viewport={"width": 1500, "height": 1000}, color_scheme=scheme)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.goto("file://" + os.path.join(ROOT, "dist", "index.html"))
    page.wait_for_function("window.lab && window.lab.table", timeout=10000)
    ev = page.evaluate

    assert ev("lab.playing"), "starts playing"
    page.wait_for_timeout(3000)
    t = ev("lab.table.engine.now")
    assert t > 15, f"model time after 3 s at x10: {t}"
    assert ev("lab.table.mergesDone") > 10

    # live parameter change through the slider
    ev("""(() => { const s = document.getElementById('f-insert_rate'); s.value = 800; s.dispatchEvent(new Event('input')); })()""")
    rate = ev("lab.table.cfg.insert_rate")
    assert 400 < rate < 480, rate  # 2000^0.8 on the log slider
    ev("""(() => { const s = document.getElementById('f-threads'); s.value = 0; s.dispatchEvent(new Event('input')); })()""")
    assert ev("lab.table.pool.threads") == 1
    page.wait_for_timeout(1500)
    page.keyboard.press("Space")
    assert not ev("lab.playing")

    # step, then inspect a part and a task
    before = ev("lab.table.engine.events")
    page.click("#step")
    assert ev("lab.table.engine.events") > before
    ev("lab.table.checkInvariants()")
    box = page.locator("#tree").bounding_box()
    rect = ev("(() => { const r = lab.tree.rects[lab.tree.rects.length - 1]; return [r.x0 + (r.x1 - r.x0) / 2, r.y + r.h / 2]; })()")
    page.mouse.click(box["x"] + rect[0], box["y"] + rect[1])
    assert "Кусок даних" in page.inner_text("#inspector"), page.inner_text("#inspector")
    if page.locator("#inspector button").count():
        page.click("#inspector button")
        assert "Злиття №" in page.inner_text("#inspector") and ev("lab.tree.highlightTask") is not None
    slot = page.locator("#pool button.slot:not(.free):visible").first
    if slot.count():
        slot.scroll_into_view_if_needed()
        slot.click()
        text = page.inner_text("#inspector")
        assert "Злиття №" in text or "завершилось" in text, text
    assert "Останній запуск" in page.inner_text("#explain") and "умова допуску" in page.inner_text("#explain"), page.inner_text("#explain")

    # actions and presets
    page.select_option("#preset", "partitions")
    assert ev("lab.playing")
    ev("lab.speed = 100")
    page.wait_for_timeout(2500)
    page.click('[data-action="rotate"]')
    page.click('[data-action="drop"]')
    page.click('[data-action="burst"]')
    page.click('[data-action="pause"]')
    page.wait_for_timeout(500)
    page.click('[data-action="pause"]')
    ev("lab.table.checkInvariants()")
    assert ev("lab.table.droppedPartitions.length") >= 1
    page.keyboard.press("Space")
    page.screenshot(path=os.path.join(shots, f"lab_partitions_{scheme}.png"), full_page=True)

    page.select_option("#preset", "feedback")
    ev("lab.speed = 30")
    page.wait_for_timeout(5000)
    page.keyboard.press("Space")
    assert ev("lab.table.delayed") > 0
    page.screenshot(path=os.path.join(shots, f"lab_feedback_{scheme}.png"), full_page=True)

    for tab in ("model", "results", "validation"):
        page.click(f"#t-{tab}")
        page.wait_for_timeout(700)
        page.screenshot(path=os.path.join(shots, f"tab_{tab}_{scheme}.png"), full_page=True)
    page.click("#theme")
    page.click("#t-lab")
    page.wait_for_timeout(300)
    assert not errors, errors
    print("ok")
    browser.close()
