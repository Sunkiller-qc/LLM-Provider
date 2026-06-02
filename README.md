# Chia LLM Rental — Provider Agent

Node.js agent to run on your GPU machine and list it for rent on [llm.chia-offer.com](https://llm.chia-offer.com).

The agent:
- connects to the platform via WebSocket
- loads GGUF models on demand with llama.cpp
- measures and reports tokens/s
- frees VRAM automatically between sessions

---

## Quick deploy (Docker — recommended)

> Prerequisites: Docker + [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)

```bash
# 0. One-time NVIDIA Container Toolkit setup (Linux)
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker

# 1. Copy and fill in config
cp config.example.json config.json
nano config.json          # paste your JWT + adjust model paths

# 2. Put your .gguf files in ./models/
mkdir -p models

# 3. Run

# pass a specific architecture to speed up the build
# "80;86;89,100" (A100, 3090, 4090, 5090)
docker compose build --build-arg CUDA_ARCHITECTURES="86"
docker compose up -d

# 4. Follow logs
docker compose logs -f
```

---

## Deploy without Docker (bare metal)

> Prerequisites: Node.js 20+, llama.cpp built with CUDA ([releases](https://github.com/ggerganov/llama.cpp/releases))

```bash
npm install

# Assisted setup (recommended — detects GPU, .gguf, obtains JWT)
npm run setup-auto

# OR full wizard (benchmark included)
npm run wizard

# Start the agent
npm start
```

---

## Configuration (`config.json`)

See `config.example.json` for all fields. Essentials:

| Field | Description |
|---|---|
| `platformUrl` | Backend URL (`https://backend.chia-offer.com`) |
| `authToken` | JWT from [llm.chia-offer.com/provider/setup](https://llm.chia-offer.com/provider/setup) |
| `llamaCppPath` | Path to `llama-server` binary (bare metal only) |
| `models` | Models to offer (name + GGUF path + ctx + rate) |
| `chiaWalletAddress` | `xch1…` address that receives payouts |
| `payoutPreference` | `XCH` or `BYC` |
| `idleUnloadSeconds` | Seconds before unloading the model from VRAM after idle (0 = never) |
| `servingMode` | `solo` (direct rental) or pool via `poolMembership` |
| `poolMembership` | `null` or `{ "poolNumber", "modelSha256", … }` to join a pool |

---

## npm scripts

| Command | Action |
|---|---|
| `npm start` | Run the agent (production) |
| `npm run dev` | Run with auto-reload |
| `npm run setup-auto` | Quick Windows-friendly setup |
| `npm run wizard` | Full interactive setup with benchmark |
| `npm run setup` | Minimal setup (wallet auth only) |
| `npm run mock` | Fake agent for testing without a GPU |

---

## Models: lazy loading + swap

The agent **does not load any model at boot**. On the first `session-start`, it starts `llama-server` with the requested model. Switching models triggers a swap (~30 s): only one model in VRAM at a time. Add multiple entries in `config.models[]` for the catalog.

## Project structure

```
├── src/
│   ├── index.js           # Entry point
│   ├── pool-setup.js      # Pool membership (GGUF hash)
│   ├── gguf-hash.js       # SHA256 of model files
│   ├── llama-manager.js   # llama-server (lazy load, swap)
│   ├── session-tracker.js # WebSocket session proxy
│   └── …                  # auth, detect, wizard, mock, etc.
├── config.example.json    # Example (Docker: /app/… paths)
├── install.bat            # One-click Windows setup
├── Dockerfile
├── docker-compose.yml
└── models/                # .gguf files (not versioned)
```

Quick Windows guide: `QUICKSTART.md`.

---

## Get a JWT

1. Go to [llm.chia-offer.com/provider/setup](https://llm.chia-offer.com/provider/setup)
2. Connect your Sage wallet and sign
3. Copy the JWT shown and paste it into `config.json` as `authToken`

The token is valid for 7 days — renew it before it expires.
