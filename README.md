# LLM Analysis Quiz Endpoint

This is an automated quiz solver for the TDS LLM Analysis Quiz.

## Features
- Loads and renders JavaScript pages (Playwright)
- Extracts CSV, JSON, PDF, base64, and HTML table data
- Submits answers automatically
- Docker + CI supported

## Run Locally

```bash
npm install
npx playwright install --with-deps chromium
node index.js
