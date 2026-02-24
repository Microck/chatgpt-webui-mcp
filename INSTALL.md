# chatgpt-webui-mcp - install

this is a minimal standalone MCP server for ChatGPT WebUI.

it supports:
- `camofox` transport (default, UI-driven) for robust long-running tasks (pro, deep research)
- `httpcloak` transport (fallback) for direct WebUI backend calls

> important: this uses undocumented webui endpoints and a session cookie token. for personal/local tinkering only - not affiliated with openai.

---

## quick start (from source)

```bash
git clone https://github.com/Microck/chatgpt-webui-mcp.git
cd chatgpt-webui-mcp
npm install
npm run build
```

set your session token:

```bash
export CHATGPT_SESSION_TOKEN="your_session_token_here"
```

run (stdio):

```bash
CHATGPT_TRANSPORT=camofox node dist/index.js
```

---

## opencode config (recommended)

add this to your OpenCode config (`~/.config/opencode/opencode.json`) under `mcp`:

```json
{
  "mcp": {
    "chatgpt-webui": {
      "type": "local",
      "enabled": true,
      "timeout": 5400000,
      "command": [
        "node",
        "/absolute/path/to/chatgpt-webui-mcp/dist/index.js"
      ],
      "environment": {
        "CHATGPT_SESSION_TOKEN": "your_session_token_here",
        "CHATGPT_TRANSPORT": "camofox",
        "CHATGPT_CAMOFOX_BASE_URL": "http://127.0.0.1:9377",
        "CHATGPT_CAMOFOX_WAIT_TIMEOUT_MS": "5400000"
      }
    }
  }
}
```

---

## remote SSE (optional)

if you want the server always-on (recommended for background runs), use the `deploy/systemd` templates in this repo.
