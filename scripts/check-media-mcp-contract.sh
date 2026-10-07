#!/bin/sh
set -eu
client_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
api_root=${EASEL_API_SOURCE:-"$client_root/../easel"}
if [ ! -x "$api_root/.venv/bin/python" ]; then
    echo 'Set EASEL_API_SOURCE to an Easel checkout with its test environment installed.' >&2
    exit 1
fi
cd "$client_root"
npm run build:media-mcp
npm test
cd "$api_root"
PYTHONPATH="$api_root${PYTHONPATH:+:$PYTHONPATH}" EASEL_MEDIA_MCP_SOURCE="$client_root" \
    .venv/bin/python -m pytest -c "$api_root/pyproject.toml" \
    "$client_root/packages/media-mcp/test-api/test_easel_contract.py" -q
