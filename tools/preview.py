"""Serve the editable UI and a freshly packaged companion on localhost."""
from argparse import ArgumentParser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
DOWNLOAD_PATH = '/downloads/orbit-network-mapper.zip'


class PreviewHandler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        # The editable UI lives at the repository root; packaging writes to dist/.
        if urlsplit(path).path == DOWNLOAD_PATH:
            return str(ROOT / 'dist' / 'orbit-network-mapper.zip')
        return super().translate_path(path)

    def end_headers(self):
        if urlsplit(self.path).path == DOWNLOAD_PATH:
            self.send_header('Content-Disposition', 'attachment; filename="orbit-network-mapper.zip"')
            self.send_header('Cache-Control', 'no-store')
        super().end_headers()


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8770)
    args = parser.parse_args()
    subprocess.run([sys.executable, str(ROOT / 'tools' / 'package.py')], check=True)
    handler = partial(PreviewHandler, directory=str(ROOT))
    with ThreadingHTTPServer(('127.0.0.1', args.port), handler) as server:
        print(f'Orbit preview: http://127.0.0.1:{server.server_port}', flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    main()
