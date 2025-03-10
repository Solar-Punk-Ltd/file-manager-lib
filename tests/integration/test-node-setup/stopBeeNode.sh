#!/bin/bash

# Define pid file names and ports.
BEE_PID_FILE_1733="bee_1733.pid"
BEE_PID_FILE_1633="bee_1633.pid"
BEE_PORT_1733=1733
BEE_PORT_1633=1633

# Function to stop a Bee node given a pid file and port.
stop_bee_node() {
  PID_FILE=$1
  PORT=$2
  if [ -f "$PID_FILE" ]; then
    BEE_PID=$(cat "$PID_FILE")
    echo "Stopping Bee node on port $PORT with PID $BEE_PID..."
    kill "$BEE_PID" 2>/dev/null
    sleep 5
    if ps -p $BEE_PID > /dev/null; then
      echo "Force killing Bee node on port $PORT with PID $BEE_PID..."
      kill -9 "$BEE_PID"
    fi
    rm "$PID_FILE"
    echo "Bee node on port $PORT stopped."
  else
    echo "Bee node on port $PORT is not running or PID file not found."
  fi

  # Ensure no process is still bound to the port.
  BEE_PROCESS=$(lsof -t -i:$PORT)
  if [ -n "$BEE_PROCESS" ]; then
    echo "Killing process using port $PORT..."
    kill -9 $BEE_PROCESS
  fi
}

# Stop both Bee nodes.
stop_bee_node "bee_1733.pid" $BEE_PORT_1733
stop_bee_node "bee_1633.pid" $BEE_PORT_1633

# Remove Bee repository and any associated data (if desired).
BEE_DIR="$(dirname "$0")/bee-dev"
BEE_DATA_DIR="$(dirname "$0")/bee-data"
if [ -d "$BEE_DIR" ]; then
  echo "Deleting Bee repository folder..."
  rm -rf "$BEE_DIR"
fi
if [ -d "$BEE_DATA_DIR" ]; then
  echo "Deleting Bee data directory..."
  rm -rf "$BEE_DATA_DIR"
fi

echo "Cleanup completed."
