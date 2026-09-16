"""
WSGI entrypoint for gunicorn + gevent.

Gevent worker patches sockets/SSL before loading this module. Keep this file
free of imports that pull urllib3/ssl until after the worker has patched
(i.e. only import app here — do not monkey-patch again).
"""

from app import app

__all__ = ["app"]
