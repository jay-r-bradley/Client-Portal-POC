"""Run the portal: python -m app"""

import logging

import uvicorn

from .config import load_settings
from .main import create_app

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    settings = load_settings()
    uvicorn.run(create_app(settings), host="0.0.0.0", port=settings.port, proxy_headers=True,
                timeout_keep_alive=5, limit_concurrency=200, server_header=False)
