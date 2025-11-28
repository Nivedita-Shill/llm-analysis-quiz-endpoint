FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm install

# Install chromium + system deps
RUN npx playwright install --with-deps chromium

COPY . .

EXPOSE 8080
CMD ["node", "index.js"]
