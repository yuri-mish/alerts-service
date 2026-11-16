#!/usr/bin/env bash
# Деплой alerts-service на VPS: заливка коду, перевірка типів і тестів, збірка і запуск контейнера.
# Запуск з локальної папки проєкту (Git Bash): ./deploy.sh [--no-test] [--logs]
set -euo pipefail

cd "$(dirname "$0")"

# Куди деплоїти - з .env.deploy (не в git: репозиторій публічний), зразок - .env.deploy.example
if [ -f .env.deploy ]; then
  set -a; . ./.env.deploy; set +a
fi
if [ -z "${DEPLOY_HOST:-}" ]; then
  echo "Не задано DEPLOY_HOST: створіть .env.deploy за зразком .env.deploy.example"
  exit 1
fi
SSH_HOST="$DEPLOY_HOST"
SSH_PORT="${DEPLOY_PORT:-22}"
REMOTE_DIR="${DEPLOY_DIR:-~/projects/alerts}"

RUN_TESTS=1
FOLLOW_LOGS=0
for arg in "$@"; do
  case "$arg" in
    --no-test) RUN_TESTS=0 ;;
    --logs) FOLLOW_LOGS=1 ;;
    *) echo "Невідомий параметр: $arg (доступні: --no-test, --logs)"; exit 1 ;;
  esac
done

SSH="ssh -p $SSH_PORT $SSH_HOST"

echo "==> 1/3 Заливка коду на VPS"
tar --exclude=node_modules --exclude=.env --exclude=.env.db --exclude=.env.deploy --exclude=CLAUDE.local.md \
  --exclude=.claude --exclude=.git -cf - . \
  | $SSH "mkdir -p $REMOTE_DIR && cd $REMOTE_DIR && rm -rf migrations src test scripts && tar -xf -"

if [ "$RUN_TESTS" = 1 ]; then
  echo "==> 2/3 Перевірка типів і тести на VPS"
  $SSH "cd $REMOTE_DIR && npm install --no-audit --no-fund && npx tsc && (set -a; . ./.env.db; set +a; npm test)"
else
  echo "==> 2/3 Тести пропущено (--no-test)"
fi

echo "==> 3/3 Збірка і запуск контейнера"
$SSH "cd $REMOTE_DIR && docker compose up -d --build && docker compose ps"

if [ "$FOLLOW_LOGS" = 1 ]; then
  $SSH "cd $REMOTE_DIR && docker compose logs -f --tail=50"
else
  echo "==> Останні логи:"
  $SSH "cd $REMOTE_DIR && docker compose logs --tail=20"
fi

echo "Готово."
