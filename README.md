<p align="center">
  <img src="./logo.png" alt="chatgpt-webui-mcp" width="200">
</p>

# ChatGPT WebUI MCP Server

> An MCP server for querying ChatGPT via web UI session token (the image above was generated with this!)

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/language-typescript-blue" alt="language">
  <img src="https://img.shields.io/badge/npm-chatgpt--webui--mcp-orange" alt="npm">
  <img src="https://img.shields.io/badge/mcp-sdk-orange" alt="mcp">
  <a href="https://github.com/Microck/opencode-studio"><img src="https://img.shields.io/badge/opencode-studio-brown?logo=data%3Aimage%2Fpng%3Bbase64%2CiVBORw0KGgoAAAANSUhEUgAAAA4AAAAOCAYAAAAfSC3RAAABiElEQVR4nF2Sv0tWcRTGPyeVIpCWwmyJGqQagsqCsL2hhobsD3BvdWhoj/6CiIKaoqXBdMjKRWwQgqZ+okSvkIhg9BOT9xPn9Vx79cD3cu6953zP8zznCQB1V0S01d3AKeAKcBVYA94DjyJioru2k9SHE+qc+kd9rL7yf7TUm+pQ05yPUM+o626Pp+qE2q7GGfWrOpjNnWnAOPAGeAK8Bb4U5D3AJ+AQMAAMAHfVvl7gIrAf2Kjiz8BZYB3YC/wFpoGDwHfgEnA0oU7tgHiheEShyXxY/Vn/n6ljye8DcBiYAloRcV3tAdrV1xMRG+o94DywCAwmx33AJHASWK7iiAjzNFOBl7WapPYtYdyo8RlLqVpOVPvq9KoH1NUuOneycaRefqnP1ftdUyiOt5KS+qLWdDpVzTXMl5It4Jr6u+Q/nhyBc8C7jpowGxGvmxuPqR9qyYuFIKdP71B8WT3SOKexXLrntvqxq3BefaiuFMQ0wqZftxl3M78MjBasfiDN/SAi0kFbtf8ACtKBWZBDoJEAAAAASUVORK5CYII%3D" alt="Add with OpenCode Studio" /></a>
</p>

---

## ⚠️ Important Disclaimer

> **This tool uses ChatGPT's internal web UI API with a session cookie.** For personal/local tinkering only — not affiliated with OpenAI. Use at your own risk and comply with OpenAI's Terms of Service.

---

## Table of Contents

- [Features](#features)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
  - [Installation](#installation)
  - [Getting Your Session Token](#getting-your-session-token)
  - [Running the Server](#running-the-server)
- [Overview](#overview)
- [Configuration](#configuration)
  - [MCP Client Config](#mcp-client-config-claude-desktop-opencode-etc)
  - [Environment Variables Reference](#environment-variables-reference)
- [Tools](#tools)
- [Usage Examples](#usage-examples)
  - [OpenCode Workflow (Natural Language Style)](#opencode-workflow-the-natural-language-style)
  - [Long-Running Tasks](#long-running-tasks-recommended)
  - [Image Generation](#image-generation)
- [Self-Test](#self-test)
- [Remote Deployment over Tailscale](#remote-deployment-over-tailscale-optional)
- [Troubleshooting](#troubleshooting)
- [Project Structure](#project-structure)
- [Contributing](#contributing)
- [License](#license)
- [Author](#author)

---

## Features

- **MCP Server Integration** — Drives ChatGPT.com via `camofox` (UI automation) using the Model Context Protocol
- **Long-Running Task Support** — Built for tasks that take 1+ hours (GPT-5.2 Pro, Deep Research)
- **Image Generation Mode** — Switches ChatGPT into image generation mode with automatic image retrieval
- **Multiple Interface Options** — Supports `stdio` and `SSE` transport modes
- **Natural Language Commands** — Parse commands like "with chatgpt webui on gpt 5.2 pro extended thinking: write a memo"
- **Background Execution** — Returns `run_id` for long jobs that exceed client timeouts
- **Remote Deployment** — Deploy as an always-on SSE service over Tailscale
- **TypeScript Implementation** — Fully typed for maintainability

---

## Prerequisites

| Requirement | Details |
|-------------|---------|
| **Node.js** | v18 or higher (required for the MCP server) |
| **Session Token** | A valid ChatGPT session token (see [Getting Your Session Token](#getting-your-session-token)) |
| **MCP Client** | Claude Desktop, OpenCode Studio, or any MCP-compatible client |
| **Browser** | Camofox handles browser automation automatically |

---

## Quick Start

### Installation

Install from npm:

```bash
npm i -g chatgpt-webui-mcp
```

Or build from source:

```bash
git clone https://github.com/Microck/chatgpt-webui-mcp.git
cd chatgpt-webui-mcp
npm install
npm run build
```

### Getting Your Session Token

1. Open https://chatgpt.com and log in
2. Open Developer Tools (F12 or right-click → Inspect)
3. Go to **Application** → **Cookies** → `https://chatgpt.com`
4. Copy the value of `__Secure-next-auth.session-token`

> **Note:** This token expires periodically. You may need to refresh it if authentication fails.

### Running the Server

**Manual run:**

```bash
CHATGPT_SESSION_TOKEN="your_session_token_here" chatgpt-webui-mcp
```

**From source:**

```bash
CHATGPT_SESSION_TOKEN="your_session_token_here" node dist/index.js
```

**Using a token file:**

```bash
echo "your_session_token_here" > ~/.config/chatgpt-webui-mcp/session-token.txt
CHATGPT_SESSION_TOKEN_FILE=~/.config/chatgpt-webui-mcp/session-token.txt chatgpt-webui-mcp
```

---

## Overview

`chatgpt-webui-mcp` is a standalone MCP server that drives ChatGPT.com via `camofox` (UI automation). It enables AI assistants like Claude, OpenCode, and others to interact with ChatGPT's web interface programmatically.

### Use Cases

- **Long-Running Research** — Deep research tasks and GPT-5.2 Pro runs that take 1+ hours
- **Image Generation** — Generate images through ChatGPT's image creation mode
- **Extended Thinking** — Leverage GPT's enhanced reasoning capabilities
- **API Alternative** — Use ChatGPT's web features when the official API is unavailable or too costly
- **Automation** — Integrate ChatGPT interactions into automated workflows

---

## Configuration

### MCP Client Config (Claude Desktop, OpenCode, etc)

Configure the MCP server in your client's configuration file:

```json
{
  "mcpServers": {
    "chatgpt-webui": {
      "command": "node",
      "args": ["/absolute/path/to/chatgpt-webui-mcp/dist/index.js"],
      "timeout": 7200000,
      "env": {
        "CHATGPT_SESSION_TOKEN_FILE": "/path/to/session-token.txt",
        "CHATGPT_BROWSER_BASE_URL": "http://127.0.0.1:9377",
        "CHATGPT_WAIT_TIMEOUT_MS": "7200000"
      }
    }
  }
}
```

### Environment Variables Reference

| Variable | Description | Default |
|----------|-------------|---------|
| `CHATGPT_SESSION_TOKEN` | ChatGPT session token (mutually exclusive with `*_FILE`) | Required |
| `CHATGPT_SESSION_TOKEN_FILE` | Path to file containing session token | Optional |
| `CHATGPT_BROWSER_BASE_URL` | Camofox browser automation server URL | `http://127.0.0.1:9377` |
| `CHATGPT_WAIT_TIMEOUT_MS` | Timeout for waiting for responses (ms) | `300000` (5 min) |
| `CHATGPT_TRANSPORT` | Transport mode (`stdio` or `sse`) | `stdio` |
| `CHATGPT_MODEL` | Default model to use (e.g., `gpt-5-2`, `gpt-5.2-pro`) | `gpt-5-2` (auto) |
| `CHATGPT_THINKING` | Enable extended thinking | `false` |
| `CHATGPT_CREATE_IMAGE` | Enable image generation mode | `false` |
| `CHATGPT_IMAGE_SCREENSHOT_FALLBACK` | Enable screenshot fallback for images | `false` |
| `CHATGPT_IMAGE_SCREENSHOT_MAX_BYTES` | Max size for screenshot fallback | `2097152` (2 MiB) |

> **Legacy Support:** The legacy `CHATGPT_CAMOFOX_*` environment variables are still supported for backward compatibility.
>
> **Note:** `CHATGPT_TRANSPORT=httpcloak` is intentionally unsupported — use `camofox` instead.

---

## Tools

| Tool | Description |
|------|-------------|
| `chatgpt_webui_session` | Validate token and return session payload |
| `chatgpt_webui_models` | List available models |
| `chatgpt_webui_command` | Natural-language command wrapper (see [OpenCode Workflow](#opencode-workflow-the-natural-language-style)) |
| `chatgpt_webui_prompt` | Unified prompt tool with `mode=auto` (chooses wait vs background) |
| `chatgpt_webui_run` | Check/wait for background runs using `run_id` |
| `chatgpt_webui_ask` | Direct wait-style prompt tool (legacy/simple) |

---

## Usage Examples

### OpenCode Workflow (Natural Language Style)

If you want to type commands like:

- `with chatgpt webui on gpt 5.2 pro extended thinking: write a 1-page memo about X`
- `do deepresearch with chatgpt webui on <topic>`

Use the `chatgpt_webui_command` tool:

```json
{
  "name": "chatgpt_webui_command",
  "arguments": {
    "command": "with chatgpt webui on gpt 5.2 pro extended thinking: write a 1-page memo about quantum computing applications",
    "mode": "auto"
  }
}
```

### Long-Running Tasks (Recommended)

For deep research and GPT-5.2 Pro tasks that may take extended time:

```json
{
  "name": "chatgpt_webui_prompt",
  "arguments": {
    "prompt": "Conduct deep research on the impact of AI on software development practices over the next decade",
    "mode": "auto"
  }
}
```

The `mode=auto` parameter returns a `run_id` for long jobs. To check or wait for results:

```json
{
  "name": "chatgpt_webui_run",
  "arguments": {
    "run_id": "your_run_id_here",
    "wait": true,
    "timeout_ms": 7200000
  }
}
```

### Image Generation

Set `create_image=true` to switch ChatGPT into image generation mode:

```json
{
  "name": "chatgpt_webui_prompt",
  "arguments": {
    "prompt": "Generate an image of a futuristic cityscape at sunset",
    "create_image": true,
    "image_screenshot_fallback": true
  }
}
```

**Notes:**
- `image_urls` is best-effort (derived from page links + visited URLs) and may be empty depending on how ChatGPT renders images
- Fallback screenshot output is returned in `image_data_url` when enabled
- For reliable retrieval, you can use the `conversation_id` returned and open the ChatGPT UI manually

---

## Self-Test

Run the built-in self-test to verify your setup:

```bash
# Using environment variable
CHATGPT_SESSION_TOKEN="your_token_here" npm run self-test

# Using CLI flag
npm run self-test -- --token "your_token_here"

# Using token file
echo "your_token_here" > ~/.config/chatgpt-webui-mcp/session-token.txt
npm run self-test -- --token-file ~/.config/chatgpt-webui-mcp/session-token.txt
```

---

## Remote Deployment over Tailscale (Optional)

If you want background runs to survive for a long time, run this server as an always-on SSE service.

1) Copy templates from this repo:
   - `deploy/systemd/chatgpt-webui-mcp.env.example`
   - `deploy/systemd/chatgpt-webui-mcp-sse.sh`
   - `deploy/systemd/chatgpt-webui-mcp.service`

2) Install and enable service (user service):

```bash
mkdir -p ~/.config ~/.config/systemd/user ~/.local/bin ~/.local/share/chatgpt-webui-mcp
cp deploy/systemd/chatgpt-webui-mcp.env.example ~/.config/chatgpt-webui-mcp.env
cp deploy/systemd/chatgpt-webui-mcp-sse.sh ~/.local/bin/chatgpt-webui-mcp-sse.sh
cp deploy/systemd/chatgpt-webui-mcp.service ~/.config/systemd/user/chatgpt-webui-mcp.service
chmod 600 ~/.config/chatgpt-webui-mcp.env
chmod 755 ~/.local/bin/chatgpt-webui-mcp-sse.sh
systemctl --user daemon-reload
systemctl --user enable --now chatgpt-webui-mcp.service
```

3) Point OpenCode (cloud host) to the endpoint:

```json
{
  "mcp": {
    "chatgpt-webui": {
      "type": "remote",
      "url": "http://<tailscale-ip>:8791/sse",
      "enabled": true,
      "timeout": 7200000,
      "oauth": false
    }
  }
}
```

---

## Troubleshooting

### Common Issues

| Issue | Solution |
|-------|----------|
| **Authentication Failed** | Your session token may have expired. Get a fresh token from ChatGPT web UI (see [Getting Your Session Token](#getting-your-session-token)) |
| **Browser Connection Error** | Ensure camofox is running at `http://127.0.0.1:9377` or set `CHATGPT_BROWSER_BASE_URL` correctly |
| **Timeout Errors** | Increase `CHATGPT_WAIT_TIMEOUT_MS` or use background mode (`mode=auto`) for long-running tasks |
| **No Image URLs Returned** | Enable screenshot fallback with `CHATGPT_IMAGE_SCREENSHOT_FALLBACK=1` |
| **Model Not Found** | Check available models with `chatgpt_webui_models`. When model/thinking are omitted, requests default to `gpt-5-2` (auto), not pro |
| **SSE Connection Issues** | If using remote deployment, ensure Tailscale is connected and firewall rules allow traffic on port 8791 |

### Debug Mode

Enable verbose logging by setting `DEBUG=chatgpt-webui-mcp:*` before running:

```bash
DEBUG=chatgpt-webui-mcp:* CHATGPT_SESSION_TOKEN="your_token" chatgpt-webui-mcp
```

---

## Project Structure

```
chatgpt-webui-mcp/
├── deploy/
│   └── systemd/
│       ├── chatgpt-webui-mcp.env.example
│       ├── chatgpt-webui-mcp-sse.sh
│       └── chatgpt-webui-mcp.service
├── src/
│   ├── index.ts               # MCP server
│   └── chatgpt-webui-client.ts # WebUI automation client
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
├── LICENSE
├── INSTALL.md
└── README.md
```

---

## Contributing

Contributions are welcome! Please follow these steps:

1. **Fork** the repository
2. **Create** a feature branch (`git checkout -b feature/amazing-feature`)
3. **Commit** your changes (`git commit -m 'Add some amazing feature'`)
4. **Push** to the branch (`git push origin feature/amazing-feature`)
5. **Open** a Pull Request

### Development Setup

```bash
# Clone the repository
git clone https://github.com/Microck/chatgpt-webui-mcp.git
cd chatgpt-webui-mcp

# Install dependencies
npm install

# Run in development mode
npm run dev

# Build
npm run build

# Run tests
npm test
```

---

## License

MIT License — see [LICENSE](LICENSE) for details.

---

## Author

[Microck](https://github.com/Microck)
