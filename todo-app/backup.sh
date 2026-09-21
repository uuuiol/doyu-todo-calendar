#!/bin/sh
# DB backup: keeps the last 14 days. Env: BACKUP_DIR (default /var/lib/todo-app/backups), DB_PATH
set -e
DIR="${BACKUP_DIR:-/var/lib/todo-app/backups}"
mkdir -p "$DIR"
node "$(dirname "$0")/backup.js" "$DIR/todo-$(date +%F).db"
find "$DIR" -name 'todo-*.db' -mtime +14 -delete
