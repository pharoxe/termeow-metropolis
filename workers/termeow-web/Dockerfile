FROM node:22.22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .

# Vite inlines public client configuration at build time; the Privy app id is a public identifier.
ARG VITE_PRIVY_APP_ID=cmtt8120900n10cjl5np0w4t4
ENV VITE_PRIVY_APP_ID=$VITE_PRIVY_APP_ID
RUN npm run build

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=9300
EXPOSE 9300

CMD ["npm", "start"]
