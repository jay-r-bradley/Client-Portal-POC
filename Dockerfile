# Client Portal: production container (Python 3.13, FastAPI).
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /srv

COPY pyproject.toml ./
COPY app ./app
COPY public ./public
COPY config ./config
RUN pip install ".[postgres]"

# Run as an unprivileged user.
RUN useradd --system --uid 10001 portal && mkdir -p /srv/data && chown portal /srv/data
USER portal

ENV APP_ENV=production PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:3000/api/config', timeout=4)"
CMD ["python", "-m", "app"]
