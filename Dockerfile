FROM node:24-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig*.json ./

# Install dependencies
RUN npm ci --ignore-scripts

# Copy source code
COPY src ./src

# Build the application
RUN npm run build

# Production stage
FROM node:24-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev --ignore-scripts

# Copy built application from builder stage
COPY --from=builder /app/build ./build

# Set NODE_ENV to production
ENV NODE_ENV=production

# Expose the default MCP port (can be overridden via environment variable)
EXPOSE 3000

# Run as non-root user for security
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "-e", "if(!['http','sse'].includes(process.env.MCP_TRANSPORT||'stdio'))process.exit(0);fetch('http://127.0.0.1:'+(process.env.MCP_PORT||'3000')+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# Start the application
CMD ["node", "build/index.js"]
