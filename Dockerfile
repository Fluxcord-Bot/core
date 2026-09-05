FROM node:20-trixie

ENV PNPM_HOME="/pnpm"

ENV PATH="$PNPM_HOME:$PATH"

RUN npm install -g pnpm

WORKDIR /app

COPY package*.json ./

COPY pnpm-workspace.yaml ./

RUN pnpm install

COPY . .

RUN sed -i 's/\r//' docker-entrypoint.sh && chmod +x docker-entrypoint.sh

EXPOSE 8080

# 200 only when BOTH bots are online, 503 otherwise (see utils/Healthcheck.js).
# Uses node -e + fetch so no curl dependency is needed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["./docker-entrypoint.sh"]

LABEL org.opencontainers.image.source https://github.com/Fluxcord-Bot/core