"""Run after configuring a real provider. Fallback is deliberately a failure."""
import argparse
import json
import urllib.request


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8000")
    args = parser.parse_args()
    token = None

    def post(path, body):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + token
        req = urllib.request.Request(args.url.rstrip("/") + path, data=json.dumps(body).encode(), headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=25) as r:
            return json.load(r)

    token = post("/api/sessions", {})["token"]
    rid = post("/api/runs", {"dataset_id": "demo-platform-v1", "supplier_id": "IEK", "as_of": "2026-09-22"})["run_id"]
    parsed = post("/api/scenarios/parse", {"run_id": rid, "selected_shipment_id": "demo-shipment-1", "text": "Задержи выбранную поставку на 7 дней, спрос увеличится на 20 процентов"})
    if parsed["status"] != "generated" or parsed["needs_clarification"]:
        raise SystemExit("FAIL: real AI did not return a valid scenario; check key/model/provider configuration")
    assert parsed["scenario"] == {"shipment_id": "demo-shipment-1", "delay_days": 7, "demand_change_pct": 20.0}, parsed
    explained = post(f"/api/runs/{rid}/explain", {"sku": "0001_", "language": "ru"})
    assert explained["status"] == "generated", explained
    print("PASS: provider parsed a real request and selected verified factors:", parsed["provider"])


if __name__ == "__main__":
    main()
