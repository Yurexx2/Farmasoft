# Farmasoft RH — production image for Render (or any Docker host).
# Debian-based Node so Playwright can install Chromium + its system libraries.
FROM node:22-bookworm-slim

WORKDIR /app

# Install dependencies first for better layer caching.
# devDependencies are kept on purpose: tsx runs the server, vite builds the frontend.
COPY package.json package-lock.json ./
RUN npm ci

# Playwright Chromium + OS libraries (used for the work.ua scraper).
RUN npx playwright install --with-deps chromium

# Copy the rest of the source and build the Vite frontend into dist/.
# VITE_API_SECRET must be present as a build env var for the frontend to
# authenticate against the API — set it in the Render dashboard.
COPY . .
RUN npm run build

ENV NODE_ENV=production
# Render injects PORT; the server falls back to 3001 locally.
EXPOSE 3001

CMD ["npm", "start"]
