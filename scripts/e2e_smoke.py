"""Run the real browser suite against a running Compose stack, optionally including XLSX upload."""
import argparse
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
from app.importers.demo_files import create_demo_workbooks


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://127.0.0.1:18080')
    parser.add_argument('--with-import', action='store_true', help='Requires ADMIN_TOKEN matching the test API')
    args = parser.parse_args()
    load_dotenv(ROOT / '.env', override=False)
    env = dict(os.environ, QOR_E2E_URL=args.url)
    if args.with_import and not os.getenv('ADMIN_TOKEN'):
        parser.error('--with-import requires ADMIN_TOKEN in .env or environment')
    with TemporaryDirectory(prefix='qor-browser-xlsx-') as temp:
        if args.with_import:
            create_demo_workbooks(Path(temp))
            env.update(QOR_ADMIN_TOKEN=os.environ['ADMIN_TOKEN'], QOR_TEST_XLSX_DIR=temp)
        result = subprocess.run(['npm', 'run', 'test:e2e'], cwd=ROOT / 'frontend', env=env)
    raise SystemExit(result.returncode)


if __name__ == '__main__':
    main()
