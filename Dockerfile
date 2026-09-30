# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.13-slim-bookworm AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app/backend
RUN groupadd --gid 10001 wealth && useradd --uid 10001 --gid wealth --create-home wealth
COPY backend/requirements.lock /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
COPY --chown=wealth:wealth backend/ /app/backend/
COPY --from=frontend-build --chown=wealth:wealth /app/frontend/dist/ /app/frontend/dist/
RUN mkdir -p /app/private-media /app/scheduler /app/backend/staticfiles \
    && chown -R wealth:wealth /app/private-media /app/scheduler /app/backend/staticfiles
USER wealth
RUN DJANGO_SECRET_KEY=build-time-static-assets-only python manage.py collectstatic --noinput
EXPOSE 8000
CMD ["gunicorn", "config.wsgi:application", "--bind", "0.0.0.0:8000", "--workers", "2"]
