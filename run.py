"""Same launch command on Windows, Linux and macOS: python run.py."""
import argparse
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
os.chdir(ROOT)
sys.path.insert(0, str(ROOT / "backend"))

if __name__ == "__main__":
    if sys.version_info < (3, 12):
        raise SystemExit("Use Python 3.12 or newer; the verified baseline is 3.12.")
    from dotenv import load_dotenv
    import uvicorn
    load_dotenv(ROOT / ".env", override=False)
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--reload", action="store_true")
    args = parser.parse_args()
    uvicorn.run("app.main:app", host=args.host, port=args.port, reload=args.reload,
                reload_dirs=[str(ROOT / "backend")] if args.reload else None,
                workers=1, proxy_headers=False)
