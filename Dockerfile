{
  "platformUrl": "https://backend.chia-offer.com",
  "authToken": "PASTE_JWT_FROM_https://llm.chia-offer.com/provider/setup",
  "llamaCppPath": "/usr/local/bin/llama-server",
  "localLlamaPort": 8080,
  "models": [
    {
      "name": "Qwen3-9B-Q4",
      "path": "/app/models/qwen3-9b-q4.gguf",
      "ctx": 32768,
      "nGpuLayers": 99
    }
  ],
  "rateUsdPerHour": 0.50,
  "payoutPreference": "BYC",
  "chiaWalletAddress": "xch1...",
  "idleUnloadSeconds": 300
}
