"""dev server: es modules need http://, not file://"""
import functools
import http.server
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript", ".mjs": "text/javascript"}


handler = functools.partial(Handler, directory=ROOT)
with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as server:
    print(f"http://localhost:{port}/")
    server.serve_forever()
