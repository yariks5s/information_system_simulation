"""Sets A4 pages with 2 cm margins in a docx made by pandoc, and makes Word fill the table of contents on opening:
    python3 a4.py file.docx"""
import re
import shutil
import sys
import zipfile

A4 = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1418" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr>'

for path in sys.argv[1:]:
    tmp = path + ".tmp"
    with zipfile.ZipFile(path) as src, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as dst:
        for item in src.infolist():
            data = src.read(item.filename)
            if item.filename == "word/settings.xml":
                # Word fills the table of contents on opening
                data = data.decode().replace("<w:zoom", '<w:updateFields w:val="true"/><w:zoom', 1).encode()
            if item.filename == "word/document.xml":
                xml = data.decode()
                xml = re.sub(r"<w:sectPr.*?</w:sectPr>", "", xml, flags=re.S)
                xml = xml.replace("</w:body>", A4 + "</w:body>")
                data = xml.encode()
            dst.writestr(item, data)
    shutil.move(tmp, path)
    print("A4:", path)
