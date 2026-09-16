"""
Gunicorn config for Tech Cafe AI Helpdesk.

Uses gevent so flask-sock WebSockets work. One worker is intentional for this
POC (no sticky-session layer). timeout=0 avoids killing long-lived /ws/control.
"""

from __future__ import annotations

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent

bind = f"{os.getenv('FLASK_HOST', '0.0.0.0')}:{os.getenv('FLASK_PORT', '443')}"
worker_class = "gevent"
# Single worker: WebSocket control channel stays on one process (no sticky proxy).
workers = int(os.getenv("GUNICORN_WORKERS", "1"))
worker_connections = int(os.getenv("GUNICORN_WORKER_CONNECTIONS", "100"))
# Long-lived WSS — do not kill the worker for idle WS holds.
timeout = int(os.getenv("GUNICORN_TIMEOUT", "0"))
graceful_timeout = int(os.getenv("GUNICORN_GRACEFUL_TIMEOUT", "30"))
keepalive = int(os.getenv("GUNICORN_KEEPALIVE", "5"))
# Recycle occasionally to clear leaked sockets / CLOSE-WAIT buildup.
max_requests = int(os.getenv("GUNICORN_MAX_REQUESTS", "1000"))
max_requests_jitter = int(os.getenv("GUNICORN_MAX_REQUESTS_JITTER", "50"))

accesslog = os.getenv("GUNICORN_ACCESSLOG", "-")
errorlog = os.getenv("GUNICORN_ERRORLOG", "-")
loglevel = os.getenv("GUNICORN_LOGLEVEL", "info")
capture_output = True
preload_app = False

_use_ssl = os.getenv("FLASK_SSL", "true").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)
if _use_ssl:
    certfile = str(BASE_DIR / "certs" / "dev-cert.pem")
    keyfile = str(BASE_DIR / "certs" / "dev-key.pem")


def on_starting(server):
    """Ensure TLS material exists without importing Flask/requests (pre-gevent)."""
    if not _use_ssl:
        return
    cert = Path(certfile)
    key = Path(keyfile)
    if cert.exists() and key.exists():
        return
    # Lazy import only if certs are missing; prefer pre-created certs in prod/POC.
    import subprocess
    import sys

    subprocess.check_call(
        [
            sys.executable,
            "-c",
            "from app import ensure_dev_ssl_certs; ensure_dev_ssl_certs()",
        ],
        cwd=str(BASE_DIR),
    )


def post_worker_init(worker):
    """Warm gpt-6-astra prompt cache once per worker (same as former app.py main)."""
    from app import PROMPT_CACHE_WARMUP, warm_diagnose_prompt_cache
    import threading

    if PROMPT_CACHE_WARMUP:
        threading.Thread(
            target=warm_diagnose_prompt_cache,
            name="prompt-cache-warmup",
            daemon=True,
        ).start()
