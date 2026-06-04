# syntax=docker/dockerfile:1

# ===========================================================================
# Build stage — installs all dependencies (including dev) and compiles TS
# ===========================================================================
FROM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ===========================================================================
# Production stage — minimal image with only production deps
# ===========================================================================
FROM node:20-alpine AS production

WORKDIR /app

# Create non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copy production deps from build stage
COPY --from=build /app/package.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled output
COPY --from=build /app/dist ./dist

# Expose proxy port
EXPOSE 3000

# Switch to non-root user
USER appuser

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/health || exit 1

ENTRYPOINT ["node", "dist/index.js"]
