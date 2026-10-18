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

if [ ! -f "configuration.yaml" ]; then
    echo "Creating default configuration.yaml for local development..."
    cat << 'EOF' > configuration.yaml
default_config:

homeassistant:
  name: Zuhause
  latitude: 52.5200
  longitude: 13.4050
  elevation: 34
  unit_system: metric
  time_zone: Europe/Berlin
  currency: EUR
  country: DE
EOF
fi

rm -f "$REPO_DIR"/custom_components/zeitachse/frontend/*.gz

if [ ! -f "$REPO_DIR/.storage/zeitachse_snapshots.enc" ]; then
    echo "Seeding initial sample timeline data..."
    "$REPO_DIR/.venv/bin/python" "$REPO_DIR/scripts/seed_sample_data.py"
fi

echo "Starting Home Assistant locally from $REPO_DIR ..."
echo "URL: http://localhost:8123/zeitachse"
echo "Press Ctrl+C to stop."

hass -c "$REPO_DIR"
