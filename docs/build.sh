#!/bin/bash
# report.docx/pdf, short_report.docx/pdf and plan.docx from the Markdown sources
set -e
cd "$(dirname "$0")"
pandoc report.md -o report.docx --resource-path=.:.. --toc
pandoc short_report.md -o short_report.docx --resource-path=.:..
pandoc plan.md -o plan.docx
python3 a4.py report.docx short_report.docx plan.docx
pandoc report.md -s --toc --toc-depth=2 --embed-resources --resource-path=.:.. --css=print.css -o report.html
pandoc short_report.md -s --embed-resources --resource-path=.:.. --css=print.css --css=short.css -o short_report.html
python3 - <<'PY'
import os
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get("CHROMIUM"))
    page = browser.new_page()
    for name in ("report", "short_report"):
        page.goto("file://" + os.path.abspath(name + ".html"))
        page.pdf(path=name + ".pdf", format="A4", print_background=True, display_header_footer=True, header_template="<span></span>",
                 footer_template='<div style="font-size:8pt;width:100%;text-align:center;color:#666"><span class="pageNumber"></span></div>',
                 margin={"top": "20mm", "bottom": "20mm", "left": "25mm", "right": "18mm"})
    browser.close()
PY
rm -f report.html short_report.html
