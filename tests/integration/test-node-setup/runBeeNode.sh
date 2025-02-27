#!/bin/bash

# Compute the absolute directory of this script.
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
BEE_DIR="$SCRIPT_DIR/bee-dev"
BEE_REPO="git@github.com:Solar-Punk-Ltd/bee.git"
BEE_BRANCH="tmp/dev-feed"
BEE_BINARY_PATH="$BEE_DIR/dist/bee"

# Define separate log and pid files for each node.
LOG_FILE_1733="bee_1733.log"
LOG_FILE_1633="bee_1633.log"
BEE_PID_FILE_1733="bee_1733.pid"
BEE_PID_FILE_1633="bee_1633.pid"

# Navigate to the directory where this script resides.
cd "$SCRIPT_DIR" || exit

# Clone the Bee repository if not already present.
if [ ! -d "$BEE_DIR" ]; then
  echo "Cloning Bee repository into $BEE_DIR..."
  git clone "$BEE_REPO" "$BEE_DIR"
fi

cd "$BEE_DIR" || exit

# Checkout the desired branch and update.
echo "Fetching latest code..."
git fetch origin "$BEE_BRANCH"
git checkout "$BEE_BRANCH"

LATEST_COMMIT=$(git rev-parse --short HEAD)
echo "Latest Bee commit: $LATEST_COMMIT"
git checkout "$LATEST_COMMIT"

# Build the Bee binary.
if ! make binary; then
  echo "Build failed. Exiting."
  exit 1
fi

# Ensure the Bee binary exists and is executable.
if [ ! -f "$BEE_BINARY_PATH" ]; then
  echo "Bee binary not found at $BEE_BINARY_PATH. Exiting."
  exit 1
fi

chmod +x "$BEE_BINARY_PATH"
echo "Bee binary built successfully."

cd "$SCRIPT_DIR" || exit

# --- Start Bee Node on port 1733 ---
echo "Starting Bee node on port 1733..."
nohup "$BEE_BINARY_PATH" dev \
  --api-addr="127.0.0.1:1733" \
  --verbosity=5 \
  --cors-allowed-origins="*" > "$LOG_FILE_1733" 2>&1 &
BEE_PID_1733=$!
echo $BEE_PID_1733 > "$BEE_PID_FILE_1733"

# --- Start Bee Node on port 1633 ---
echo "Starting Bee node on port 1633..."
nohup "$BEE_BINARY_PATH" dev \
  --api-addr="127.0.0.1:1633" \
  --verbosity=5 \
  --cors-allowed-origins="*" > "$LOG_FILE_1633" 2>&1 &
BEE_PID_1633=$!
echo $BEE_PID_1633 > "$BEE_PID_FILE_1633"

# Wait a few seconds to let both nodes initialize.
sleep 10

# Health check for port 1733.
if ! curl --silent --fail http://127.0.0.1:1733/health; then
  echo "Bee node on port 1733 health check failed. Exiting."
  exit 1
fi

# Health check for port 1633.
if ! curl --silent --fail http://127.0.0.1:1633/health; then
  echo "Bee node on port 1633 health check failed. Exiting."
  exit 1
fi

echo "Both Bee nodes are healthy and ready to process requests."
