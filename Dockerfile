FROM node:22.22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .

# Vite inlines public client configuration during the image build. Railway only
# exposes service variables to Docker build steps when the argument is declared.
ARG VITE_PRIVY_APP_ID
RUN npm run build

ENV NODE_ENV=production
ENV HOST=0.0.0.0
EXPOSE 9300

CMD ["npm", "start"]
