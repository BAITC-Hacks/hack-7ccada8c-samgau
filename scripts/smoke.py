"""External HTTP check; only standard library, works on every target OS."""
import argparse
import json
import urllib.error
import urllib.request


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8000")
    args = parser.parse_args()
    token = None

    def call(method, path, payload=None):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + token
        req = urllib.request.Request(args.url.rstrip("/") + path, data=json.dumps(payload).encode() if payload is not None else None, headers=headers, method=method)
        with urllib.request.urlopen(req, timeout=30) as response:
            data = response.read()
            return data if path.endswith(".csv") else json.loads(data)

    assert call("GET", "/api/health")["status"] == "ok"
    token = call("POST", "/api/sessions", {})["token"]
    run = call("POST", "/api/runs", {"dataset_id": "demo-platform-v1", "supplier_id": "IEK", "as_of": "2026-09-22"})["run_id"]
    row = call("GET", f"/api/runs/{run}/products/0001_")
    assert row["recommended_qty"] == 156, row
    scenario = call("POST", f"/api/runs/{run}/scenario", {"shipment_id": "demo-shipment-1", "delay_days": 20})["run_id"]
    assert call("GET", f"/api/runs/{scenario}/products/0001_")["recommended_qty"] == 204
    order = call("POST", "/api/orders", {"run_id": run, "supplier_id": "IEK", "skus": ["0001_"]})
    order = call("PATCH", f"/api/orders/{order['draft_id']}", {"version": order["version"], "changes": [{"sku": "0001_", "approved_qty": 168, "reason": "Smoke test correction"}]})
    order = call("POST", f"/api/orders/{order['draft_id']}/approve", {"version": order["version"], "acknowledge_warnings": True})
    csv_data = call("GET", f"/api/orders/{order['draft_id']}/export.csv")
    assert csv_data.startswith(b"\xef\xbb\xbf") and b";168.0;" in csv_data
    print("PASS: session -> 156 -> scenario 204 -> edit 168 -> approve -> CSV")


if __name__ == "__main__":
    main()
