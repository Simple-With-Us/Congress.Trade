# Congress.Trade server CPU scan worker — Linux/ARM64 (Oracle Coolify) + amd64
FROM python:3.14-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    OCR_BACKEND=tesseract \
    WORKER_ID=server_cpu_1 \
    POLL_INTERVAL_SEC=30

# System OCR + PDF render (CPU only)
RUN apt-get update && apt-get install -y --no-install-recommends \
      tesseract-ocr \
      tesseract-ocr-eng \
      poppler-utils \
      libgl1 \
      libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY checkbox.py form_chrome.py grid_ptr.py infisical_config.py ocr_backends.py pipeline.py worker.py ./

# Optional health: process stays in poll loop
CMD ["python", "worker.py"]
