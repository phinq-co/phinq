FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN (npm ci --omit=dev || npm install --omit=dev) && npm cache clean --force
COPY --from=build /app/dist ./dist
# Bind all interfaces inside the container; publish with -p 5100:5100.
ENV PHINQ_HOST=0.0.0.0
ENV PHINQ_PORT=5100
EXPOSE 5100
USER node
CMD ["node", "dist/index.js"]
