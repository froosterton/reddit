FROM node:18-slim

# Install Chrome dependencies and system packages
RUN apt-get update && apt-get install -y \
    chromium \
    chromium-driver \
    wget \
    gnupg \
    unzip \
    curl \
    xvfb \
    && rm -rf /var/lib/apt/lists/*

# Set Chrome binary path
ENV CHROME_BIN=/usr/bin/chromium
ENV CHROMEDRIVER_PATH=/usr/bin/chromedriver

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy application files
COPY . .

# Create non-root user (use different UID if 1000 exists)
RUN useradd -m appuser && chown -R appuser:appuser /app
USER appuser

# Expose port (Railway will set PORT env var)
EXPOSE 3000

# Start the application
CMD ["node", "reddit_monitor_bot.js"]
