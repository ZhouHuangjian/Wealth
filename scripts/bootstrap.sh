#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ ! -f .env ]]; then
  printf '%s\n' '请先复制 .env.example 为 .env，并设置独立随机密码。' >&2
  exit 1
fi
if grep -q '^[A-Z_]*=.*CHANGE_ME' .env; then
  printf '%s\n' '.env 仍有占位密码；拒绝初始化。' >&2
  exit 1
fi
chmod 600 .env
docker compose config --quiet
docker compose build
docker compose up -d --wait db rabbitmq
docker compose --profile tools run --rm migrate
docker compose up -d --wait web worker beat
printf '%s\n' '服务已启动。创建初始用户：docker compose run --rm web python manage.py createsuperuser'
