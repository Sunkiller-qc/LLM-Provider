# Chia LLM Rental — Provider Agent

Agent Node.js à installer sur ta machine GPU pour la proposer à la location sur [llm.chia-offer.com](https://llm.chia-offer.com).

L'agent :
- se connecte à la plateforme via WebSocket
- charge les modèles GGUF à la demande avec llama.cpp
- mesure et rapporte tokens/s
- libère la VRAM automatiquement entre les sessions

---

## Déploiement rapide (Docker — recommandé)

> Prérequis : Docker + [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)



```bash
# 0. One time configure NVIDIA Container Toolkit (Linux)
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker

# 1. Copie et remplis la config
cp config.example.json config.json
nano config.json          # colle ton JWT + ajuste les chemins de modèles

# 2. Place tes fichiers .gguf dans ./models/
mkdir -p models

# 3. Lance

# pass a specific architecture to speed up the build
# "80;86;89,100" (A100, 3090, 4090, 5090) 
docker compose build --build-arg CUDA_ARCHITECTURES="86"
docker compose up -d

# 4. Suis les logs
docker compose logs -f
```

---

## Déploiement sans Docker (bare metal)

> Prérequis : Node.js 18+, llama.cpp compilé avec CUDA ([releases](https://github.com/ggerganov/llama.cpp/releases))

```bash
npm install

# Setup assisté (recommandé — détecte GPU, .gguf, obtient le JWT)
npm run setup-auto

# OU wizard complet (benchmark inclus)
npm run wizard

# Lance l'agent
npm start
```

---

## Configuration (`config.json`)

Voir `config.example.json` pour tous les champs. Les essentiels :

| Champ | Description |
|---|---|
| `platformUrl` | URL du backend (`https://backend.chia-offer.com`) |
| `authToken` | JWT obtenu sur [llm.chia-offer.com/provider/setup](https://llm.chia-offer.com/provider/setup) |
| `llamaCppPath` | Chemin vers le binaire `llama-server` (bare metal uniquement) |
| `models` | Liste des modèles à proposer (nom + chemin GGUF + ctx + tarif) |
| `chiaWalletAddress` | Adresse `xch1…` qui reçoit les paiements |
| `payoutPreference` | `XCH` ou `BYC` |
| `idleUnloadSeconds` | Secondes avant de décharger le modèle de la VRAM après inactivité (0 = jamais) |

---

## Scripts npm

| Commande | Action |
|---|---|
| `npm start` | Lance l'agent (production) |
| `npm run dev` | Lance avec rechargement auto |
| `npm run setup-auto` | Setup rapide Windows-friendly |
| `npm run wizard` | Setup interactif complet avec benchmark |
| `npm run setup` | Setup minimal (auth wallet seulement) |
| `npm run mock` | Agent factice pour tester sans GPU |

---

## Structure du projet

```
├── src/
│   ├── index.js          # Point d'entrée de l'agent
│   ├── auth.js           # JWT + client HTTP authentifié
│   ├── detect.js         # Détection cloudflared, ports, scripts .bat
│   ├── gpu-monitor.js    # Détection GPU via nvidia-smi
│   ├── llama-manager.js  # Gestion llama-server (lazy load, swap)
│   ├── session-tracker.js # Proxy WebSocket sessions LLM
│   ├── tunnel.js         # Tunnel Cloudflare optionnel
│   ├── pricing.js        # Calcul de tarifs
│   ├── setup.js          # Setup auth wallet
│   ├── auto-setup.js     # Setup automatique
│   ├── wizard.js         # Wizard interactif complet
│   └── mock.js           # Agent factice (tests)
├── config.example.json   # Exemple de configuration
├── Dockerfile
├── docker-compose.yml
└── models/               # Tes fichiers .gguf (non versionné)
```

---

## Obtenir le JWT

1. Va sur [llm.chia-offer.com/provider/setup](https://llm.chia-offer.com/provider/setup)
2. Connecte ton wallet Sage et signe
3. Copie le JWT affiché et colle-le dans `config.json` sous `authToken`

Le token est valide 7 jours — renouvelle-le avant expiration.
