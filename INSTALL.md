# chatgpt-webui-mcp - install

this is a minimal standalone MCP server for ChatGPT WebUI.

it uses `camofox` (UI-driven) by default for robust long-running tasks (pro, deep research).

> important: this uses undocumented webui endpoints and a session cookie token. for personal/local tinkering only - not affiliated with openai.

---

## quick start (npm)

install from npm:

```bash
npm i -g chatgpt-webui-mcp
```

then run:

```bash
CHATGPT_SESSION_TOKEN="your_session_token_here" chatgpt-webui-mcp
```

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
node dist/index.js
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
      "timeout": 7200000,
      "command": [
        "node",
        "/absolute/path/to/chatgpt-webui-mcp/dist/index.js"
      ],
      "environment": {
        "CHATGPT_SESSION_TOKEN_FILE": "/path/to/session-token.txt",
        "CHATGPT_BROWSER_BASE_URL": "http://127.0.0.1:9377",
        "CHATGPT_WAIT_TIMEOUT_MS": "7200000"
      }
    }
  }
}
```

`camofox` is the default (and only supported) path.
if model/thinking are omitted, requests default to `gpt-5-2` (auto), not pro.

---

## remote SSE (optional)

if you want the server always-on (recommended for background runs), use the `deploy/systemd` templates in this repo.
