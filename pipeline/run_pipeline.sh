#!/bin/bash
# ============================================================
# EJ Newsfeed — Manual Pipeline Trigger
#
# Calls the Supabase Edge Functions directly via HTTP.
# The pipeline runs automatically via pg_cron — use this
# script only to trigger a manual run outside of schedule.
#
# Usage:
#   ./run_pipeline.sh            # fetch + process
#   ./run_pipeline.sh --fetch    # fetch only
#   ./run_pipeline.sh --process  # process only
#
# Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env
# ============================================================

PIPELINE_DIR="/Users/ejjung/Dev/ejnewsfeed/pipeline"
LOG_FILE="$HOME/Library/Logs/ejnewsfeed.log"
ENV_FILE="$PIPELINE_DIR/.env"

# Load env vars
if [ -f "$ENV_FILE" ]; then
  export $(grep -v '^#' "$ENV_FILE" | xargs)
fi

if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_SERVICE_ROLE_KEY" ]; then
  echo "ERROR: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set in $ENV_FILE" >&2
  exit 1
fi

log() { echo "$1" | tee -a "$LOG_FILE"; }

log ""
log "========================================"
log "Manual pipeline run started: $(date)"
log "========================================"

run_fetch() {
  log "→ Triggering fetch-emails..."
  RESP=$(curl -s -w "\nHTTP_STATUS:%{http_code}" -X POST \
    "$SUPABASE_URL/functions/v1/fetch-emails" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
    -H "Content-Type: application/json" \
    -d '{}')
  STATUS=$(echo "$RESP" | grep -o 'HTTP_STATUS:[0-9]*' | cut -d: -f2)
  BODY=$(echo "$RESP" | grep -v 'HTTP_STATUS:')
  log "  fetch-emails → HTTP $STATUS: $BODY"
  [ "$STATUS" = "200" ] && return 0 || return 1
}

run_process() {
  log "→ Triggering process-emails..."
  RESP=$(curl -s -w "\nHTTP_STATUS:%{http_code}" -X POST \
    "$SUPABASE_URL/functions/v1/process-emails" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
    -H "Content-Type: application/json" \
    -d '{}')
  STATUS=$(echo "$RESP" | grep -o 'HTTP_STATUS:[0-9]*' | cut -d: -f2)
  BODY=$(echo "$RESP" | grep -v 'HTTP_STATUS:')
  log "  process-emails → HTTP $STATUS: $BODY"
  [ "$STATUS" = "200" ] && return 0 || return 1
}

MODE="${1:-}"
EXIT_CODE=0

case "$MODE" in
  --fetch)
    run_fetch || EXIT_CODE=1
    ;;
  --process)
    run_process || EXIT_CODE=1
    ;;
  *)
    run_fetch   || EXIT_CODE=1
    sleep 10    # small gap to let fetch-emails finish writing rows
    run_process || EXIT_CODE=1
    ;;
esac

log "Manual pipeline run finished: $(date) — exit code $EXIT_CODE"
exit $EXIT_CODE
