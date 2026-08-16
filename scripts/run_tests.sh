#!/usr/bin/env bash
set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

if [ -d ".venv" ]; then
    source .venv/bin/activate
fi

echo "1. Checking Python compilation..."
python3 -m compileall custom_components/zeitachse

echo "2. Running Ruff linter..."
ruff check .

echo "3. Running Pytest test suite..."
pytest "$@"

echo "All checks and tests passed successfully!"
