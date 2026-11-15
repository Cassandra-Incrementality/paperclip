#!/usr/bin/env bash
# Regenerates server/src/generated/default-act-rules.json from the single
# source of truth (cassandra-brain/scripts/board_card_classifier.py). Never
# hand-edit the vendored file — PPC-7562's whole point is one definition.
set -euo pipefail

BRAIN_PATH="${CASSANDRA_BRAIN_PATH:-$HOME/cassandra-brain}"
CLASSIFIER="$BRAIN_PATH/scripts/board_card_classifier.py"
OUT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/src/generated/default-act-rules.json"

if [[ ! -f "$CLASSIFIER" ]]; then
  echo "error: $CLASSIFIER not found (set CASSANDRA_BRAIN_PATH)" >&2
  exit 1
fi

python3 "$CLASSIFIER" --export-rules > "$OUT"
echo "wrote $OUT"
