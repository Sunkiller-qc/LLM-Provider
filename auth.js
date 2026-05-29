{
  "name": "gpu-rental-provider-agent",
  "version": "0.1.0",
  "description": "Agent à installer sur la machine GPU pour la mettre en location",
  "type": "module",
  "bin": {
    "gpu-rental-agent": "./src/index.js"
  },
  "scripts": {
    "start": "node src/index.js",
    "dev": "node --watch src/index.js",
    "setup": "node src/setup.js",
    "setup-auto": "node src/auto-setup.js",
    "wizard": "node src/wizard.js",
    "mock": "node src/mock.js"
  },
  "dependencies": {
    "axios": "^1.7.0",
    "dotenv": "^16.4.5",
    "ws": "^8.17.0"
  }
}
