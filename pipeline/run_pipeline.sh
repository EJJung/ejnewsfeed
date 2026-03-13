#!/bin/bash
# ============================================================
# EJ Newsfeed — Morning Pipeline Runner
# Called by macOS cron every weekday at 7am.
# Logs output to ~/Library/Logs/ejnewsfeed.log
# ============================================================

PIPELINE_DIR="/Users/ejjung/Documents/dev/ejnewsfeed/pipeline"
LOG_FILE="$HOME/Library/Logs/ejnewsfeed.log"
PYTHON=$(which python3)

echo "" >> "$LOG_FILE"
echo "========================================" >> "$LOG_FILE"
echo "Run started: $(date)" >> "$LOG_FILE"
echo "========================================" >> "$LOG_FILE"

cd "$PIPELINE_DIR" || {
  echo "ERROR: Could not cd to $PIPELINE_DIR" >> "$LOG_FILE"
  exit 1
}

"$PYTHON" process_emails.py --fetch-first >> "$LOG_FILE" 2>&1

EXIT_CODE=$?
echo "Run finished: $(date) — exit code $EXIT_CODE" >> "$LOG_FILE"
exit $EXIT_CODE
