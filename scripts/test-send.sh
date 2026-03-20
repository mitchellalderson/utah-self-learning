#!/usr/bin/env bash
#
# Send test messages directly to the Inngest dev server, bypassing Slack.
#
# Usage:
#   ./scripts/test-send.sh "Your question here"
#   ./scripts/test-send.sh                          # runs all questions from test-questions.md
#   ./scripts/test-send.sh --batch 5                # run first 5 questions
#   ./scripts/test-send.sh --delay 10 --batch 3     # 10s between messages, first 3

set -euo pipefail

# Supports both local dev server and Inngest Cloud.
# For Cloud: set INNGEST_EVENT_KEY env var (or it reads from .env)
INNGEST_URL="${INNGEST_URL:-}"
INNGEST_EVENT_KEY="${INNGEST_EVENT_KEY:-}"

# Try to load INNGEST_EVENT_KEY from .env if not set
if [[ -z "$INNGEST_EVENT_KEY" ]]; then
  ENV_FILE="$(dirname "$0")/../.env"
  if [[ -f "$ENV_FILE" ]]; then
    INNGEST_EVENT_KEY=$(grep -E '^INNGEST_EVENT_KEY=' "$ENV_FILE" | cut -d= -f2- | tr -d '[:space:]')
  fi
fi

# Determine endpoint
if [[ -n "$INNGEST_URL" ]]; then
  # Local dev server
  EVENT_ENDPOINT="${INNGEST_URL}/e/test"
elif [[ -n "$INNGEST_EVENT_KEY" ]]; then
  # Inngest Cloud
  EVENT_ENDPOINT="https://inn.gs/e/${INNGEST_EVENT_KEY}"
else
  echo "Error: Set INNGEST_URL (local dev) or INNGEST_EVENT_KEY (cloud) to send events."
  echo "  Local:  INNGEST_URL=http://localhost:8288 $0 ..."
  echo "  Cloud:  INNGEST_EVENT_KEY=<your-key> $0 ..."
  echo "  Or add INNGEST_EVENT_KEY to your .env file."
  exit 1
fi
DELAY="${DELAY:-5}"
BATCH=""
QUESTIONS_FILE="$(dirname "$0")/../workspace/test-questions.md"

# Parse args
MESSAGE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --delay) DELAY="$2"; shift 2 ;;
    --batch) BATCH="$2"; shift 2 ;;
    --url)   INNGEST_URL="$2"; EVENT_ENDPOINT="${INNGEST_URL}/e/test"; shift 2 ;;
    --key)   INNGEST_EVENT_KEY="$2"; EVENT_ENDPOINT="https://inn.gs/e/${INNGEST_EVENT_KEY}"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 [options] [message]"
      echo ""
      echo "Options:"
      echo "  --delay N    Seconds between messages (default: 5)"
      echo "  --batch N    Only send first N questions from test file"
      echo "  --url URL    Inngest dev server URL (for local dev)"
      echo "  --key KEY    Inngest event key (for Cloud, or set INNGEST_EVENT_KEY)"
      echo ""
      echo "If no message is given, sends all questions from workspace/test-questions.md"
      exit 0
      ;;
    *) MESSAGE="$1"; shift ;;
  esac
done

send_message() {
  local msg="$1"
  local ts
  ts="$(date +%s)"
  local session_key="test-cli-${ts}"
  local event_id="test.${ts}.$(( RANDOM % 10000 ))"

  local payload
  payload=$(cat <<EOF
[
  {
    "id": "${event_id}",
    "name": "agent.message.received",
    "data": {
      "channel": "slack",
      "channelMeta": {
        "channelId": "C4T6Q5LRH",
        "eventId": "${event_id}",
        "eventTime": ${ts},
        "eventType": "app_mention",
        "teamId": "T-TEST",
        "threadTs": "${ts}.000000"
      },
      "destination": {
        "chatId": "C-TEST-${ts}",
        "messageId": "${ts}.000000",
        "threadId": "${ts}.000000"
      },
      "headers": {},
      "message": ${msg},
      "sender": {
        "id": "U-TEST",
        "name": "Test User"
      },
      "sessionKey": "${session_key}"
    },
    "ts": ${ts}000
  }
]
EOF
)

  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "${EVENT_ENDPOINT}" \
    -H "Content-Type: application/json" \
    -d "${payload}")

  if [[ "$status" == "200" || "$status" == "201" ]]; then
    echo "  -> sent (HTTP ${status})"
  else
    echo "  -> FAILED (HTTP ${status})"
  fi
}

# JSON-escape a string
json_escape() {
  printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()), end="")'
}

if [[ -n "$MESSAGE" ]]; then
  # Single message mode
  echo "Sending: ${MESSAGE:0:80}..."
  send_message "$(json_escape "$MESSAGE")"
  exit 0
fi

# Batch mode: extract numbered questions from test-questions.md
echo "Extracting questions from ${QUESTIONS_FILE}..."

questions=()
while IFS= read -r line; do
  # Match lines starting with a number and period (e.g. "1. ...")
  if [[ "$line" =~ ^[0-9]+\.\  ]]; then
    # Strip the leading number and period
    q="${line#*. }"
    questions+=("$q")
  fi
done < "$QUESTIONS_FILE"

total=${#questions[@]}
if [[ "$total" -eq 0 ]]; then
  echo "No questions found in ${QUESTIONS_FILE}"
  exit 1
fi

limit="${BATCH:-$total}"
if [[ "$limit" -gt "$total" ]]; then
  limit="$total"
fi

echo "Found ${total} questions, sending ${limit} with ${DELAY}s delay"
echo ""

for (( i=0; i<limit; i++ )); do
  q="${questions[$i]}"
  num=$(( i + 1 ))
  echo "[${num}/${limit}] ${q:0:80}..."
  send_message "$(json_escape "$q")"

  if [[ $i -lt $(( limit - 1 )) ]]; then
    sleep "$DELAY"
  fi
done

echo ""
echo "Done. Check scores with:"
echo "  cat workspace/scores/\$(date +%Y-%m-%d).jsonl"
