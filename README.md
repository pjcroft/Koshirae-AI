# PC AI

Desktop AI chat + agent harness for macOS and Linux (Electron, React, TypeScript).

- **Providers**: OpenRouter, OpenAI, Anthropic (OpenAI-compat), Ollama, LM Studio, or any OpenAI-compatible URL. Streaming chat, model picker, saved conversations.
- **Agent tools** (with per-category approval: read / write / exec / mcp): local files, shell, SSH (`ssh_*`, uses your keys/agent/`~/.ssh/config`, works with Tailscale hostnames), SMB (`smbclient`, or use mounted shares), Tailscale status, HTTP fetch.
- **MCP**: stdio or streamable-HTTP servers, configured in Settings as JSON.
- API keys / SMB passwords are encrypted with Electron `safeStorage` when available.

## Run

```bash
npm install
npm run dev
```

## Package

```bash
npm run dist   # dmg on macOS, AppImage + deb on Linux
```

## MCP example (Settings → MCP servers)

```json
[{"name":"fs","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/home/me"]}]
```
