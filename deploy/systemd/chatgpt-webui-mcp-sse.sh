#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${ENV_FILE:-$HOME/.config/chatgpt-webui-mcp.env}"

if [ ! -f "$ENV_FILE" ]; then
  echo "missing env file: $ENV_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

exec node "${CHATGPT_WEBUI_MCP_DIST:-$HOME/.local/share/chatgpt-webui-mcp/dist/index.js}"
