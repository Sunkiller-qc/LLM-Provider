# Provider Agent — Quick start (Windows)

## How it works in 4 lines

1. **The agent runs on your GPU machine**
2. On startup: detects your GPU → optional Cloudflare tunnel (public URL) → registers on the platform → waits
3. **When a client rents your GPU**, the backend sends “load this model” over WebSocket → the agent starts `llama-server` → forwards requests
4. When done: stops the model, frees VRAM, waits for the next session

You never touch the code. Configure models + rates once, then launch.

## One-click install

Double-click **`install.bat`**:

- Checks Node.js + NVIDIA drivers + cloudflared (warnings if missing)
- Automatic `npm install`
- **Auto-detects**: your GPU, llama-server, `.gguf` files on disk
- **Asks only for**:
  1. Your Chia address (xch1…)
  2. Which models to rent (suggested rate by size)
  3. JWT after signing once in Sage
- Saves to `config.json`

**JWT workflow**:
1. Open your frontend (`http://localhost:3000`) in parallel
2. Click “Connect Sage” → sign in Sage
3. F12 → console → run `localStorage.getItem('gpu-rental-jwt')`
4. Copy the token (no quotes) → paste into the install.bat terminal

To add or change models later:
- **Frontend**: `/dashboard` → “Edit” button (easiest)
- **CLI**: `npm run setup-auto` (re-run auto-setup)
- **Manual**: edit `config.json` with notepad

## One-click launch

Double-click **`start.bat`** → your GPU is listed for rent.

A PowerShell window shows logs. `Ctrl+C` for a clean shutdown (stops llama + tunnel).

## Test without a GPU (mock)

Double-click **`start-mock.bat`** → simulates a provider without llama.cpp or a real GPU. Useful to validate the platform pipeline.

## Manual prerequisites (before `install.bat`)

| Tool | Why | Link |
|---|---|---|
| **Node.js 20 LTS** | Run the agent | https://nodejs.org/ |
| **NVIDIA drivers** | GPU detection + CUDA | https://nvidia.com/drivers |
| **llama.cpp + CUDA** | LLM inference | https://github.com/ggerganov/llama.cpp |
| **cloudflared** *(optional)* | Public tunnel for debug — agent works WITHOUT it | https://github.com/cloudflare/cloudflared/releases |
| **Sage Wallet** | Receive XCH payouts | https://sagewallet.net/ |

## Change settings later

3 ways:
1. **`npm run wizard`** — full interactive setup again
2. **Frontend `/dashboard`** — “Edit” on your GPU (rate, models, online/offline)
3. **`notepad config.json`** — manual edit (advanced)

## If something breaks

See `README.md` or `../docs/TESTING.md` section “Level 3+ mock agent”.
