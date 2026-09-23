"""Check 12 generated synthetic XLSX over HTTP. Requires ADMIN_TOKEN in the environment."""
import argparse
import json
import os
import sys
import time
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4

from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from app.engine.demo import AS_OF
from app.importers.demo_files import create_demo_workbooks
from app.importers.service import MAPPING_VERSION
from smoke import Client, verify_order


def multipart(files, fields):
    boundary = "qor-" + uuid4().hex
    parts = []
    for name, value in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    for path in files:
        parts.extend([
            f'--{boundary}\r\nContent-Disposition: form-data; name="files"; filename="{path.name}"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n'.encode(),
            path.read_bytes(), b"\r\n",
        ])
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8000")
    parser.add_argument("--state-file", type=Path, help="Optional local state for --resume; contains a session token")
    parser.add_argument("--resume", action="store_true", help="Check persisted data after API restart")
    args = parser.parse_args()
    load_dotenv(Path(__file__).resolve().parents[1] / ".env", override=False)
    client = Client(args.url)
    if args.resume:
        if not args.state_file:
            parser.error("--resume requires --state-file")
        state = json.loads(args.state_file.read_text(encoding="utf-8"))
        client.token = state["token"]
        for item in state["imports"]:
            run = client.call("GET", f'/api/runs/{item["run_id"]}')
            assert run["dataset_id"] == item["dataset_id"]
            assert run["algorithm_version"] == "qor-mvp-1.0"
        draft = client.call('GET', f'/api/orders/{state["draft_id"]}')
        assert draft['status'] == 'draft' and draft['version'] == state['draft_version']
        assert draft['lines'][0]['approved_qty'] == 180
        assert b";168.0;" in client.call("GET", f'/api/orders/{state["order_id"]}/export.csv')
        print("PASS: imported datasets, session, runs and approved CSV survived restart")
        return
    admin = os.getenv("ADMIN_TOKEN")
    if not admin:
        parser.error("Set ADMIN_TOKEN in the process environment to match the server")
    client.session()
    state = {"token": client.token, "imports": []}
    with TemporaryDirectory(prefix="qor-synthetic-") as temp:
        books = create_demo_workbooks(Path(temp))
        for supplier in ("systeme_electric", "iek"):
            fields = {"supplier": supplier, "mapping_version": MAPPING_VERSION,
                      "as_of": AS_OF.isoformat(), "warehouse_id": "synthetic-almaty"}
            body, content_type = multipart([p for s, p, _ in books if s == supplier], fields)
            headers = {"X-Admin-Token": admin, "Content-Type": content_type}
            job = client.call("POST", "/api/imports", body, headers=headers)
            deadline = time.monotonic() + 120
            while job["status"] in ("queued", "running") and time.monotonic() < deadline:
                time.sleep(0.2)
                job = client.call("GET", f'/api/imports/{job["import_id"]}')
            assert job["status"] == "completed", job["status"]
            did = job["dataset_id"]
            duplicate = client.call("POST", "/api/imports", body, headers=headers)
            assert duplicate["deduplicated"] and duplicate["dataset_id"] == did
            assert client.call("GET", f"/api/datasets/{did}/quality")["source_count"] == 6
            if supplier == "systeme_electric":
                rid, oid = verify_order(client, did, supplier, AS_OF.isoformat(), "00001")
                state["order_id"] = oid
                draft = client.call('POST', '/api/orders', {'run_id': rid, 'supplier_id': supplier, 'skus': ['00001']})
                draft = client.call('PATCH', f'/api/orders/{draft["draft_id"]}', {'version': draft['version'], 'changes': [{'sku': '00001', 'approved_qty': 180, 'reason': 'Persistence smoke'}]})
                state.update(draft_id=draft['draft_id'], draft_version=draft['version'])
            else:
                run = client.call("POST", "/api/runs", {"dataset_id": did, "supplier_id": supplier, "as_of": AS_OF.isoformat()})
                rid = run["run_id"]
                assert run["algorithm_version"] == "qor-mvp-1.0"
                cable = client.call("GET", f"/api/runs/{rid}/products/00007")
                assert cable["recommended_qty"] == 2 and cable["stock_units_per_order_unit"] == 305
            other = Client(args.url)
            other.session()
            other.expect_error(404, "GET", f"/api/datasets/{did}/quality")
            other.expect_error(404, "GET", f"/api/imports/{job["import_id"]}")
            other.expect_error(404, "GET", f"/api/runs/{rid}")
            state["imports"].append({"dataset_id": did, "run_id": rid})
            print(f"PASS: {supplier}: 6 synthetic XLSX -> import -> dedup -> engine -> isolation")
    if args.state_file:
        fd = os.open(args.state_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(state, output)
    print("PASS: 12 synthetic XLSX checked; real supplier layouts require their own mappings")


if __name__ == "__main__":
    main()
