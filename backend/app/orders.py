import csv
import io
from decimal import Decimal


def validate_line(line):
    r = line["recommendation"]
    qty = line["approved_qty"]
    if r["data_status"] == "blocked" or r["approval_blockers"]:
        return "Есть блокирующие проблемы данных"
    required = ("available_stock", "eligible_incoming", "forecast_qty", "safety_stock", "raw_need", "recommended_qty", "stock_units_per_order_unit")
    if any(r[k] is None for k in required) or qty is None:
        return "Нет исходного числа расчёта, остатка, количества или коэффициента единиц"
    q, step, moq = map(lambda x: Decimal(str(x)), (qty, r["order_step"], r["moq"]))
    if q < 0 or (q > 0 and (q < moq or q % step != 0)):
        return "Количество нарушает MOQ или кратность"
    return None


def safe_cell(value):
    text = str(value)
    if text.lstrip().startswith(("=", "+", "-", "@")) or text.startswith(("\t", "\r", "\n")):
        return "'" + text
    return text


def export_csv(order, version):
    out = io.StringIO(newline="")
    writer = csv.writer(out, delimiter=";", lineterminator="\r\n")
    writer.writerow(["supplier_id", "sku_1c", "supplier_article", "name", "order_unit", "quantity", "stock_unit", "stock_equivalent", "warehouse_id", "reason", "risk", "as_of", "version", "editor_role", "editor_id", "data_mode"])
    for line in order["lines"]:
        r = line["recommendation"]
        equivalent = Decimal(str(line["approved_qty"])) * Decimal(str(r["stock_units_per_order_unit"]))
        row = [r["supplier_id"], r["sku"], r["supplier_article"], r["name"], r["unit"], line["approved_qty"], r["stock_unit"], equivalent, r["warehouse_id"], line["reason"] or r["explanation"], r["risk_status"], order["as_of"], version, "manager" if line["edited_by"] else "calculation", line["edited_by"] or ""]
        row.append(order.get('data_mode') or 'unknown')
        writer.writerow([safe_cell(x) for x in row])
    return out.getvalue().encode("utf-8-sig")
