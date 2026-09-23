FROM python:3.12.14-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 QOR_DATA_DIR=/data
WORKDIR /srv/backend
COPY backend/requirements.lock backend/requirements-engine.txt /tmp/
RUN python -m pip install --no-cache-dir -r /tmp/requirements.lock -r /tmp/requirements-engine.txt \
    && useradd --uid 10001 --create-home qor \
    && mkdir /data && chown qor:qor /data
COPY backend/app ./app
USER qor
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=2)"
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--no-proxy-headers"]
