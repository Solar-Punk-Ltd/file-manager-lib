#!/bin/bash

# Define pid file names and ports.
BEE_PID_FILE_1733="bee_1733.pid"
BEE_PID_FILE_1633="bee_1633.pid"
LOG_FILE_1733="bee_1733.log"
LOG_FILE_1633="bee_1633.log"
BEE_PORT_1733=1733
BEE_PORT_1633=1633

# Function to stop a Bee node given a pid file and port.
stop_bee_node() {
  PID_FILE=$1
  PORT=$2

  if [ -f "$PID_FILE" ]; then
    BEE_PID=$(cat "$PID_FILE")
    echo "Stopping Bee node on port $PORT with PID $BEE_PID..."
    kill "$BEE_PID" 2>/dev/null || true

    sleep 1

    if ps -p $BEE_PID > /dev/null 2>&1; then
      echo "Force killing Bee node on port $PORT with PID $BEE_PID..."
      kill -9 "$BEE_PID" 2>/dev/null || true
    fi

    rm -f "$PID_FILE"

    echo "Bee node on port $PORT stopped."
  else
    echo "Bee node on port $PORT is not running or PID file not found."
  fi

  # Ensure no process is still bound to the port.
  BEE_PROCESS=$(lsof -t -i:$PORT 2>/dev/null || true)
  if [ -n "$BEE_PROCESS" ]; then
    # Only kill if it's actually a bee process, not something else
    for pid in $BEE_PROCESS; do
      PROC_NAME=$(ps -p $pid -o comm= 2>/dev/null || true)
      if [[ "$PROC_NAME" == *"bee"* ]] || [[ "$PROC_NAME" == *"Bee"* ]]; then
        echo "Killing bee process $pid using port $PORT..."
        kill -9 $pid 2>/dev/null || true
      else
        echo "Skipping non-bee process $pid ($PROC_NAME) on port $PORT"
      fi
    done
  fi
}

TMP_DIR="$(dirname "$0")"
# Stop both Bee nodes.
stop_bee_node "$TMP_DIR/$BEE_PID_FILE_1733" $BEE_PORT_1733
stop_bee_node "$TMP_DIR/$BEE_PID_FILE_1633" $BEE_PORT_1633

rm -f "$TMP_DIR/$LOG_FILE_1733" "$TMP_DIR/$LOG_FILE_1633"

# Remove Bee repository and any associated data (if desired).
BEE_DIR="$TMP_DIR/bee-dev"
BEE_DATA_DIR="$TMP_DIR/bee-data"

# Check if we should keep the directories (pass "keep" as first argument)
KEEP_DIRS="$1"

if [ "$KEEP_DIRS" != "keep" ]; then
  if [ -d "$BEE_DIR" ]; then
    echo "Deleting Bee repository folder..."
    rm -rf "$BEE_DIR"
  fi
  if [ -d "$BEE_DATA_DIR" ]; then
    echo "Deleting Bee data directory..."
    rm -rf "$BEE_DATA_DIR"
  fi
  echo "Cleanup completed."
else
  echo "Keeping Bee directories for reuse in next test run."
fi
