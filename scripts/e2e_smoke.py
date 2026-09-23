"""Run the real browser suite against a running Compose stack.

XLSX upload uses default IMPORT_ACCESS=session (6 attempts/minute per session,
20 per server). Optional IMPORT_ACCESS=admin disables upload through the UI.
"""
import argparse
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
from app.importers.demo_files import create_demo_workbooks


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://127.0.0.1:18080')
    parser.add_argument('--with-import', action='store_true', help='Include generated XLSX upload; requires IMPORT_ACCESS=session (default)')
    args = parser.parse_args()
    env = dict(os.environ, QOR_E2E_URL=args.url)
    with TemporaryDirectory(prefix='qor-browser-xlsx-') as temp:
        if args.with_import:
            create_demo_workbooks(Path(temp))
            env.update(QOR_TEST_XLSX_DIR=temp)
        result = subprocess.run(['npm', 'run', 'test:e2e'], cwd=ROOT / 'frontend', env=env)
    raise SystemExit(result.returncode)


if __name__ == '__main__':
    main()
