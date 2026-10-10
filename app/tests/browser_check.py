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
    page.locator("#tree").scroll_into_view_if_needed()
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

    # the disk fills up: NOT_ENOUGH_SPACE, and the merge size limit follows the free space
    page.select_option("#preset", "disk")
    ev("lab.speed = 1000")
    # merge entries can push an early NOT_ENOUGH_SPACE line out of the 400 kept ones, so wait for one in the log
    page.wait_for_function("lab.table.rejectedDisk > 0 && lab.log.s.entries.some(e => e.kind === 'disk' && e.text.includes('NOT_ENOUGH_SPACE'))", timeout=60000)
    page.keyboard.press("Space")
    ev("lab.table.checkInvariants()")
    assert ev("lab.table.diskUsed() <= lab.table.cfg.disk_bytes * (1 + 1e-9)")
    page.screenshot(path=os.path.join(shots, f"lab_disk_{scheme}.png"), full_page=True)

    # comparison: B takes the panel's changes, A stays, both see the same inserts
    page.select_option("#preset", "normal")
    page.click("#compare")
    assert ev("lab.a !== null") and not page.locator("#compare-bar").is_hidden()
    assert "однакові" in page.inner_text("#compare-diff")
    ev("""(() => { const s = document.getElementById('f-threads'); s.value = 100; s.dispatchEvent(new Event('input')); })()""")
    assert ev("lab.table.cfg.threads") != ev("lab.a.table.cfg.threads") == 16
    assert "→" in page.inner_text("#compare-diff"), page.inner_text("#compare-diff")
    ev("lab.speed = 30")
    page.wait_for_timeout(4000)
    assert abs(ev("lab.a.table.engine.now - lab.b.table.engine.now")) < 1
    assert abs(ev("lab.a.table.arrivals - lab.b.table.arrivals")) <= 2, "common random numbers: the same arrivals"
    page.click('#compare-view [data-value="A"]')
    assert ev("lab.view") == "A" and "моделі A" in page.inner_text("#log-title")
    page.keyboard.press("Space")
    ev("lab.a.table.checkInvariants(); lab.b.table.checkInvariants()")
    page.screenshot(path=os.path.join(shots, f"lab_compare_{scheme}.png"), full_page=True)
    threads = ev("lab.table.cfg.threads")
    page.click("#reset")
    assert ev("lab.table.engine.now") < 5 and ev("lab.table.cfg.threads") == threads and ev("lab.a.table.cfg.threads") == 16
    page.click("#compare")
    assert ev("lab.a") is None and page.locator("#compare-bar").is_hidden()

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
