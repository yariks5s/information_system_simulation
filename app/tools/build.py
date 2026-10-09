"""Bundles the app into one self-contained file, dist/index.html, that opens straight from disk.

Browsers do not load ES modules from file://, so every module becomes a function scope in one classic script:
its exports are returned from the scope, and its imports read them from the scopes built before it.

    python3 tools/build.py   (from app/)"""
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMPORT = re.compile(r'^import\s+\{([^}]*)\}\s+from\s+"(\.{1,2}/[^"]+)";\s*$', re.M)
EXPORT = re.compile(r"^export\s+((?:async\s+)?(?:function\*?|class|const|let))\s+(\w+)", re.M)


def module_order(entry):
    order, seen = [], set()

    def visit(path):
        if path in seen:
            return
        seen.add(path)
        with open(path) as f:
            source = f.read()
        for _, target in IMPORT.findall(source):
            visit(os.path.normpath(os.path.join(os.path.dirname(path), target)))
        order.append(path)

    visit(entry)
    return order


def bundle(entry):
    order = module_order(entry)
    names = {path: f"__module_{i}" for i, path in enumerate(order)}
    out = []
    for path in order:
        with open(path) as f:
            source = f.read()

        def replace_import(m, path=path):
            target = os.path.normpath(os.path.join(os.path.dirname(path), m.group(2)))
            bindings = ", ".join(b.strip().replace(" as ", ": ") for b in m.group(1).split(",") if b.strip())
            return f"const {{ {bindings} }} = {names[target]};"

        exports = [name for _, name in EXPORT.findall(source)]
        source = IMPORT.sub(replace_import, source)
        source = EXPORT.sub(lambda m: f"{m.group(1)} {m.group(2)}", source)
        rel = os.path.relpath(path, ROOT)
        out.append(f"// ---- {rel}\nconst {names[path]} = (() => {{\n{source}\nreturn {{ {', '.join(exports)} }};\n}})();\n")
    return "\n".join(out)


def main():
    with open(os.path.join(ROOT, "index.html")) as f:
        page = f.read()
    with open(os.path.join(ROOT, "styles.css")) as f:
        css = f.read()
    script = bundle(os.path.join(ROOT, "src", "main.js")).replace("</script", "<\\/script")
    page = page.replace('<link rel="stylesheet" href="styles.css">', f"<style>\n{css}\n</style>")
    page = page.replace('<script type="module" src="src/main.js"></script>', f'<script>\n"use strict";\n{script}\n</script>')
    os.makedirs(os.path.join(ROOT, "dist"), exist_ok=True)
    path = os.path.join(ROOT, "dist", "index.html")
    with open(path, "w") as f:
        f.write(page)
    print(f"{os.path.relpath(path, ROOT)}: {len(page) / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
