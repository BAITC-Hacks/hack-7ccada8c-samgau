"""Explicit XLSX mappings. No heuristic claims about unavailable supplier workbooks."""
from __future__ import annotations

from datetime import date, datetime
from hashlib import sha256
from itertools import zip_longest
from pathlib import Path
from typing import Any, Literal

from openpyxl import load_workbook
from pydantic import Field

from ..engine.models import Model

SourceKind = Literal['sales', 'monthly_sales', 'monthly_stock', 'incoming', 'seasonality', 'moq']


class WideColumn(Model):
    column: str | int
    date: date
    # Required explicit ID for incoming columns; otherwise the column name is used.
    shipment_id: str | None = None


class WorkbookMapping(Model):
    kind: SourceKind
    version: str
    sheet: str
    header_row: int = Field(default=1, ge=1)
    columns: dict[str, str | int]
    wide: tuple[WideColumn, ...] = ()
    defaults: dict[str, Any] = Field(default_factory=dict)
    skip_rows: tuple[int, ...] = ()
    short_date_year: int | None = None
    snapshot_semantics: Literal['month_start', 'month_end', 'unknown'] = 'unknown'


class CellTrace(Model):
    file: str
    sha256: str
    sheet: str
    row: int
    field: str
    raw: Any
    value: Any
    status: Literal['observed', 'assumed', 'missing']


class ImportIssue(Model):
    code: str
    row: int | None = None
    field: str | None = None
    message: str


class Record(Model):
    supplier_id: str
    kind: str
    values: dict[str, Any]
    source_ref: tuple[CellTrace, ...]


class ImportResult(Model):
    supplier_id: str
    kind: SourceKind
    mapping_version: str
    file_hash: str
    rows_seen: int
    rows_imported: int
    rows_skipped: int
    records: tuple[Record, ...]
    issues: tuple[ImportIssue, ...]
    duplicate_file: bool = False


def parse_date(value, year=None):
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value).strip()
    for fmt in ('%Y-%m-%d', '%d.%m.%Y', '%Y-%m'):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            pass
    if year is not None:
        try:
            return datetime.strptime(f'{text}.{year}', '%d.%m.%Y').date()
        except ValueError:
            pass
    raise ValueError(f'unrecognized date {text!r}; short dates require explicit year')


def number(value):
    from math import isfinite
    if value is None or value == '':
        return None
    if isinstance(value, bool):
        raise ValueError('boolean is not a quantity')
    result = float(str(value).replace('\u00a0', '').replace(' ', '').replace(',', '.'))
    if not isfinite(result):
        raise ValueError('non-finite numeric value')
    return result


NUMERIC = {'quantity', 'moq', 'order_multiple', 'stock_units_per_order_unit',
           'available', 'on_hand', 'reserved', 'coefficient', 'growth_value'}
IDENTIFIERS = {'sku', 'document_id', 'customer_id_hash', 'warehouse_id', 'supplier_article', 'shipment_id', 'category_code'}


class SupplierAdapter:
    supplier_id: str

    def read(self, path: str | Path, mapping: WorkbookMapping) -> ImportResult:
        path = Path(path)
        with path.open('rb') as stream:
            digest = sha256()
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(chunk)
            file_hash = digest.hexdigest()
        cached = load_workbook(path, data_only=True, read_only=True)
        formulas = load_workbook(path, data_only=False, read_only=True)
        records, issues = [], []
        seen = imported = skipped = 0
        try:
            if mapping.sheet not in cached.sheetnames:
                raise ValueError(f'mapping sheet not found: {mapping.sheet}')
            sheet, raw_sheet = cached[mapping.sheet], formulas[mapping.sheet]
            header = next(sheet.iter_rows(min_row=mapping.header_row, max_row=mapping.header_row))
            labels = [str(c.value).strip() if c.value is not None else '' for c in header]

            def index(column):
                if isinstance(column, int):
                    if column < 1:
                        raise ValueError('column indices are 1-based')
                    return column - 1
                matches = [i for i, label in enumerate(labels) if label == column]
                if len(matches) != 1:
                    raise ValueError(f'column {column!r} has {len(matches)} matches; use explicit column index')
                return matches[0]

            columns = {field: index(column) for field, column in mapping.columns.items()}
            wide = [(entry, index(entry.column)) for entry in mapping.wide]
            if mapping.kind in ('monthly_sales', 'monthly_stock') and not wide:
                raise ValueError('monthly mapping requires explicit wide month columns')
            for row_number, pair in enumerate(zip_longest(
                    sheet.iter_rows(min_row=mapping.header_row + 1),
                    raw_sheet.iter_rows(min_row=mapping.header_row + 1)), mapping.header_row + 1):
                row, raw_row = pair
                if row_number in mapping.skip_rows:
                    continue
                if row is None or raw_row is None:
                    raise ValueError('cached and formula worksheet shapes differ')
                if all(c.value is None for c in raw_row):
                    continue
                seen += 1
                traces = []
                values = {}

                def read_cell(field, idx):
                    cell = row[idx] if idx < len(row) else None
                    raw_cell = raw_row[idx] if idx < len(raw_row) else None
                    value = cell.value if cell else None
                    raw = raw_cell.value if raw_cell else None
                    if raw_cell and raw_cell.data_type == 'f' and value is None:
                        issues.append(ImportIssue(code='formula_without_cached_value', row=row_number,
                                                  field=field, message='Formula not evaluated; value remains unknown'))
                    return value, raw, raw_cell

                try:
                    for field in sorted(set(columns) | set(mapping.defaults)):
                        if field in columns:
                            value, raw, cell = read_cell(field, columns[field])
                            status = 'observed' if value is not None else 'missing'
                        else:
                            value = raw = mapping.defaults[field]
                            cell = None
                            status = 'assumed' if value is not None else 'missing'
                        if field in NUMERIC:
                            value = number(value)
                        elif field in ('date', 'eta', 'as_of') and value is not None:
                            value = parse_date(value, mapping.short_date_year).isoformat()
                        elif field in IDENTIFIERS and value is not None:
                            if isinstance(value, (int, float)):
                                if int(value) != value:
                                    raise ValueError(f'{field}: non-integer numeric identifier')
                                fmt = cell.number_format if cell else ''
                                value = str(int(value)).zfill(len(fmt)) if fmt and set(fmt) == {'0'} else str(int(value))
                                issues.append(ImportIssue(code='numeric_identifier', row=row_number,
                                                          field=field, message='Identifier converted using explicit cell number format'))
                            else:
                                value = str(value)  # Preserve original SKU characters, including leading zeros.
                        elif field == 'month' and value is not None:
                            value = int(value)
                        values[field] = value
                        traces.append(CellTrace(file=path.name, sha256=file_hash, sheet=mapping.sheet,
                            row=row_number, field=field, raw=str(raw) if isinstance(raw, (date, datetime)) else raw,
                            value=value, status=status))
                    if mapping.kind != 'seasonality' and not values.get('sku'):
                        raise ValueError('missing SKU; row cannot be matched by product name')
                    if str(values.get('sku', '')).strip().casefold() in ('итого', 'всего', 'total'):
                        raise ValueError('total row is not a SKU')
                    if mapping.kind == 'sales':
                        for field in ('date', 'document_id', 'quantity', 'warehouse_id', 'unit'):
                            if values.get(field) is None or values.get(field) == '':
                                raise ValueError(f'missing required sales field {field}')
                        if values['quantity'] < 0:
                            issues.append(ImportIssue(code='negative_movement', row=row_number,
                                                      field='quantity', message='Preserved signed quantity; return policy unresolved'))
                    if mapping.kind == 'seasonality':
                        if not isinstance(values.get('month'), int) or not 1 <= values['month'] <= 12:
                            raise ValueError('seasonality month must be in 1..12')
                        if values.get('coefficient') is None or values['coefficient'] <= 0:
                            raise ValueError('seasonality coefficient must be positive')
                    if mapping.kind == 'moq':
                        for field in ('moq', 'order_multiple', 'stock_units_per_order_unit'):
                            v = values.get(field)
                            if v is not None and (v < 0 or (field != 'moq' and v == 0)):
                                issues.append(ImportIssue(code='invalid_order_rule', row=row_number,
                                    field=field, message='Invalid rule kept as unknown for review'))
                                values[field] = None
                                traces = [t.model_copy(update={'value': None, 'status': 'missing'}) if t.field == field else t for t in traces]
                    row_records = []
                    if mapping.kind == 'incoming' and any(k in values for k in ('available', 'on_hand', 'reserved')):
                        if not values.get('as_of'):
                            raise ValueError('inventory snapshot requires explicit as_of')
                        row_records.append(Record(supplier_id=self.supplier_id, kind='inventory', values=values.copy(), source_ref=tuple(traces)))
                    for entry, idx in wide:
                        value, raw, _ = read_cell('quantity', idx)
                        quantity = number(value)
                        if quantity is not None and quantity < 0:
                            raise ValueError('negative monthly metric or incoming quantity requires review')
                        converted = values.copy()
                        converted['quantity'] = quantity
                        if mapping.kind == 'incoming':
                            converted.update(eta=entry.date.isoformat(), shipment_id=entry.shipment_id or str(entry.column))
                        else:
                            if entry.date.day != 1:
                                raise ValueError('monthly column date must be the first day')
                            converted.update(month=entry.date.isoformat(), snapshot_semantics=mapping.snapshot_semantics)
                        trace = CellTrace(file=path.name, sha256=file_hash, sheet=mapping.sheet, row=row_number,
                                          field=f'quantity:{entry.column}', raw=raw, value=quantity,
                                          status='observed' if quantity is not None else 'missing')
                        if quantity is None:
                            issues.append(ImportIssue(code='missing_quantity', row=row_number, field=str(entry.column), message='Empty cell remains unknown'))
                        row_records.append(Record(supplier_id=self.supplier_id, kind=mapping.kind,
                                                   values=converted, source_ref=tuple(traces + [trace])))
                    if not wide:
                        if mapping.kind == 'incoming':
                            if values.get('quantity') is None or not values.get('eta') or not values.get('shipment_id'):
                                raise ValueError('incoming requires quantity, ETA and shipment ID')
                            if values['quantity'] < 0:
                                raise ValueError('negative incoming quantity')
                        row_records.append(Record(supplier_id=self.supplier_id, kind=mapping.kind,
                                                  values=values, source_ref=tuple(traces)))
                    records.extend(row_records)
                    imported += 1
                except (ValueError, TypeError, OverflowError) as error:
                    skipped += 1
                    issues.append(ImportIssue(code='row_rejected', row=row_number, message=str(error)))
        finally:
            cached.close()
            formulas.close()
        return ImportResult(supplier_id=self.supplier_id, kind=mapping.kind, mapping_version=mapping.version,
                            file_hash=file_hash, rows_seen=seen, rows_imported=imported, rows_skipped=skipped,
                            records=tuple(records), issues=tuple(issues))


class IEKAdapter(SupplierAdapter):
    supplier_id = 'iek'


class SystemeElectricAdapter(SupplierAdapter):
    supplier_id = 'systeme_electric'


class ImportBatch:
    """Dataset-local import state. API owner persists successful hashes alongside the dataset."""
    def __init__(self):
        self.results: list[ImportResult] = []
        self._seen: set[tuple[str, str, str]] = set()

    def add(self, result: ImportResult) -> ImportResult:
        key = (result.supplier_id, result.kind, result.file_hash)
        if key in self._seen:
            return result.model_copy(update={'records': (), 'duplicate_file': True, 'rows_imported': 0})
        self._seen.add(key)
        self.results.append(result)
        return result

    @property
    def records(self):
        return tuple(record for result in self.results for record in result.records)

    def missing_sources(self, supplier_id):
        expected = {'sales', 'monthly_sales', 'monthly_stock', 'incoming', 'seasonality', 'moq'}
        loaded = {r.kind for r in self.results if r.supplier_id == supplier_id and r.rows_imported > 0}
        return sorted(expected - loaded)
