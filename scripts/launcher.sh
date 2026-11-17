#!/bin/bash
# Desktop .app must contain a copy of this file.
# Do not exec a script outside the app bundle — Launch Services kills that process tree.
set -u
PROJECT_DIR="/Users/wangtangjie/Documents/B站投稿-grok-v2"
APP_URL="http://127.0.0.1:3459"
BUN_BIN="/Users/wangtangjie/.bun/bin/bun"
LOG_DIR="/Users/wangtangjie/Library/Logs/BiliPublisherGrokV2"
LOG_FILE="$LOG_DIR/service.log"

notify() {
  /usr/bin/osascript -e "display notification \"$1\" with title \"B站投稿助手-Grok-v2\""
}

log() {
  /bin/mkdir -p "$LOG_DIR"
  printf '%s %s\n' "$(/bin/date '+%Y-%m-%dT%H:%M:%S')" "$*" >>"$LOG_FILE"
}

is_up() {
  BODY=$(/usr/bin/curl -fsS --max-time 1 "$APP_URL/api/health" 2>/dev/null) || return 1
  printf '%s' "$BODY" | /usr/bin/grep -q '"service":"bili-publisher-grok-v2"' || return 1
  printf '%s' "$BODY" | /usr/bin/grep -q '"driver":"grok"'
}

if is_up; then
  /usr/bin/open "$APP_URL/"
  exit 0
fi

if /usr/bin/curl -sS --max-time 1 "$APP_URL/api/health" >/dev/null 2>&1; then
  notify "3459端口已被其他程序占用"
  exit 1
fi

if [ ! -x "$BUN_BIN" ]; then
  notify "未找到 Bun，请先安装 ~/.bun/bin/bun"
  exit 1
fi

if [ ! -d "$PROJECT_DIR" ] || [ ! -f "$PROJECT_DIR/server.ts" ]; then
  notify "找不到项目目录或 server.ts"
  exit 1
fi

HAS_ENV_KEY=0
if [ -f "$PROJECT_DIR/.env" ] && /usr/bin/grep -qE '^(BILI_GROK_API_KEY|XAI_API_KEY)=' "$PROJECT_DIR/.env"; then
  HAS_ENV_KEY=1
fi
if [ "$HAS_ENV_KEY" -eq 0 ] && [ ! -f "$HOME/.grok/auth.json" ]; then
  notify "未找到 Grok 凭证：请设置 .env 或先 grok login"
  exit 1
fi

log "starting bun $PROJECT_DIR/server.ts"
if ! cd "$PROJECT_DIR"; then
  notify "无法进入项目目录"
  log "cd failed: $PROJECT_DIR"
  exit 1
fi
set -a
if [ -f .env ]; then . ./.env; fi
set +a
/usr/bin/nohup /usr/bin/env PATH="/Users/wangtangjie/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" \
  "$BUN_BIN" "$PROJECT_DIR/server.ts" >>"$LOG_FILE" 2>&1 </dev/null &
disown || true

n=0
while [ "$n" -lt 40 ]; do
  if is_up; then
    /usr/bin/open "$APP_URL/"
    exit 0
  fi
  /bin/sleep 0.4
  n=$((n + 1))
done

notify "启动失败，请查看 $LOG_FILE"
log "health check timed out"
exit 1
