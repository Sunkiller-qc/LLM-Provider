# Chia LLM Rental — provider agent (Docker, all-in-one)
#
# Everything needed is in this folder. No git clone of anything else.
#
# 1. Edit ./config.json with your JWT and your models list.
# 2. Put your GGUF files in ./models
# 3. docker compose up -d --build
# 4. docker compose logs -f
#
# Requires : Docker with NVIDIA Container Toolkit installed on the host.
# https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html

services:
  provider:
    build:
      context: .
      dockerfile: Dockerfile
      args:
        # Build llama.cpp for these CUDA archs (RTX 20xx..50xx + data-center).
        # Override to e.g. "60;70" for older cards.
        CUDA_ARCHITECTURES: "75;80;86;89;90"
    image: chia-llm-provider:latest
    container_name: chia-llm-provider
    restart: unless-stopped
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
    environment:
      - NVIDIA_VISIBLE_DEVICES=all
      - NVIDIA_DRIVER_CAPABILITIES=compute,utility
    volumes:
      - ./config.json:/app/config.json:ro
      - ./models:/app/models:ro
    # No inbound ports — agent does outbound WS to platformUrl.
    # Uncomment to expose llama-server locally for debug :
    # ports:
    #   - "127.0.0.1:8080:8080"
