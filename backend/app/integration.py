"""Lazy configurable imports keep the captain independent of engine files."""
from importlib import import_module
from . import demo
from .contracts import DatasetPayload, EngineResult


class EngineUnavailable(Exception):
    pass


def calculate(settings, dataset, params, backend):
    if backend == "fixture":
        result = demo.calculate(dataset, params)
    else:
        if not settings.engine_module:
            raise EngineUnavailable("ENGINE_MODULE не настроен")
        result = import_module(settings.engine_module).calculate(dataset, params)
    result = EngineResult.model_validate(result)
    if any(r.supplier_id != params.supplier_id or r.warehouse_id != dataset.warehouse_id for r in result.recommendations):
        raise ValueError("Engine returned data outside requested scope")
    return result


def import_dataset(settings, request):
    if not settings.importer_module:
        raise EngineUnavailable("IMPORTER_MODULE не настроен")
    result = DatasetPayload.model_validate(import_module(settings.importer_module).import_dataset(request))
    if result.mode != "real" or result.as_of != request.as_of or result.warehouse_id != request.warehouse_id or result.supplier_ids != [request.supplier_id]:
        raise ValueError("Importer scope does not match request")
    return result
