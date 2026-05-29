# ── Étape 1 : build llama.cpp avec support CUDA ──────────────────────────────
FROM nvidia/cuda:12.4.1-devel-ubuntu22.04 AS llama-builder

ARG CUDA_ARCHITECTURES="75;80;86;89;90"

RUN apt-get update && apt-get install -y \
    cmake build-essential git \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 https://github.com/ggerganov/llama.cpp /llama.cpp

RUN cmake -S /llama.cpp -B /llama.cpp/build \
    -DGGML_CUDA=ON \
    -DCMAKE_CUDA_ARCHITECTURES="${CUDA_ARCHITECTURES}" \
    && cmake --build /llama.cpp/build --target llama-server -j$(nproc)

# ── Étape 2 : image finale ────────────────────────────────────────────────────
FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04

RUN apt-get update && apt-get install -y \
    nodejs npm \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dépendances Node
COPY package.json ./
RUN npm install --omit=dev

# Code source de l'agent
COPY src/ ./src/
COPY config.example.json ./

# Binaire llama-server compilé dans l'étape précédente
COPY --from=llama-builder /llama.cpp/build/bin/llama-server /usr/local/bin/llama-server

# config.json et models/ sont montés en volume au runtime (voir docker-compose.yml)

CMD ["node", "src/index.js"]
