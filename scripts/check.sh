#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DATABASE_URL_ADMIN:?Set DATABASE_URL_ADMIN to a dedicated test database owner}"
python3 -m unittest discover -s scripts -p 'test_*.py'
ruff format --check backend scripts
ruff check --select E9,F63,F7,F82 backend scripts
(
  cd backend
  python manage.py check
  python manage.py makemigrations --check --dry-run
  pytest
)
(
  cd frontend
  npm ci
  npm run typecheck
  npm test
  npm run format:check
  npm run build
)
