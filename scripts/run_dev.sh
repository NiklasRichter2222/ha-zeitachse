#!/usr/bin/env bash
set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

if [ ! -d ".venv" ]; then
    echo "Virtual environment .venv not found. Creating..."
    python3 -m venv .venv
    source .venv/bin/activate
    pip install -r requirements.txt
    pip install pytest pytest-asyncio ruff
else
    source .venv/bin/activate
fi

echo "Starting Home Assistant locally from $REPO_DIR ..."
echo "URL: http://localhost:8123"
echo "Login: test / 1234 (or use your local user)"
echo "Press Ctrl+C to stop."

hass -c "$REPO_DIR"
