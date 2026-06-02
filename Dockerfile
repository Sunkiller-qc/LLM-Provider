# ── Step 1: build llama.cpp with CUDA ───────────────────────────────────────
FROM nvidia/cuda:12.4.1-devel-ubuntu22.04 AS llama-builder

ARG CUDA_ARCHITECTURES="75;80;86;89;90"

RUN apt-get update && apt-get install -y \
    cmake build-essential git \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 https://github.com/ggerganov/llama.cpp /llama.cpp

RUN echo "/usr/local/cuda/lib64/stubs" > /etc/ld.so.conf.d/cuda-stubs.conf && ldconfig

RUN cmake -S /llama.cpp -B /llama.cpp/build \
    -DGGML_CUDA=ON \
    -DCMAKE_CUDA_ARCHITECTURES="${CUDA_ARCHITECTURES}" \
    -DBUILD_SHARED_LIBS=OFF \
    -DGGML_CUDA_FA_ALL_QUANTS=ON \
    -DCUBLASLT=ON \
    && cmake --build /llama.cpp/build --target llama-server -j$(nproc)

# ── Step 2: final image ─────────────────────────────────────────────────────
FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04

RUN apt-get update && apt-get install -y curl libgomp1 && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Node dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Agent source
COPY src/ ./src/

# llama-server binary from the build stage
COPY --from=llama-builder /llama.cpp/build/bin/llama-server /usr/local/bin/llama-server

# config.json and models/ are mounted at runtime (see docker-compose.yml)

CMD ["node", "src/index.js"]
