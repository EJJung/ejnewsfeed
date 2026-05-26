#!/bin/bash
# run_audit_local.sh
# Runs the EJ Newsfeed pipeline audit directly on this Mac.
# Designed to be called by a launchd agent at 08:00 AM Mon–Fri.
# Markdown reports are written to /Users/ejjung/Dev/ejnewsfeed/

set -euo pipefail

LOG_DIR="/Users/ejjung/Dev/ejnewsfeed/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/audit-$(date +%Y-%m-%d).log"

exec >> "$LOG_FILE" 2>&1
echo "=== Audit started at $(date) ==="

# Source shell profile so brew/pyenv python3 is on PATH
for profile in "$HOME/.zprofile" "$HOME/.zshrc" "$HOME/.bash_profile" "$HOME/.profile"; do
    [ -f "$profile" ] && source "$profile" 2>/dev/null && break
done

SCRIPT_DIR="/Users/ejjung/Dev/ejnewsfeed/pipeline"
cd "$SCRIPT_DIR"

# Determine Python — prefer brew/pyenv, fall back to system
PYTHON=$(command -v python3 || echo /usr/bin/python3)

# Install dependencies if missing
"$PYTHON" -c "import supabase" 2>/dev/null || "$PYTHON" -m pip install supabase python-dotenv --quiet

# Day of week: 1=Monday … 7=Sunday
DOW=$(date +%u)

run() {
    local audit_date="$1"
    local days="$2"
    echo ""
    echo "--- Auditing $audit_date (--days $days) ---"
    "$PYTHON" audit_pipeline.py --date "$audit_date" --days "$days" --md
}

if [ "$DOW" -eq 1 ]; then
    # Monday — audit Saturday, Sunday, and today
    SAT=$(date -v-2d +%Y-%m-%d)
    SUN=$(date -v-1d +%Y-%m-%d)
    MON=$(date +%Y-%m-%d)
    run "$SAT" 1
    run "$SUN" 1
    run "$MON" 3
else
    # Tuesday–Friday — audit today only
    TODAY=$(date +%Y-%m-%d)
    run "$TODAY" 1
fi

echo ""
echo "=== Audit finished at $(date) ==="
