FROM node:22.22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .

# Vite inlines public client configuration at build time; the Privy app id is a public identifier.
ARG VITE_PRIVY_APP_ID=cmtt8120900n10cjl5np0w4t4
ENV VITE_PRIVY_APP_ID=$VITE_PRIVY_APP_ID
RUN npm run build

# Runtime: production dependencies plus the built client and the server sources tsx runs directly.
FROM node:22.22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=9300
# npm start passes --use-system-ca, which needs the system CA bundle the slim image leaves out.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY server ./server
COPY shared ./shared
COPY db ./db
COPY scripts ./scripts
COPY tsconfig.json ./
EXPOSE 9300

CMD ["npm", "start"]
