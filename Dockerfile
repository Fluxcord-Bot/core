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

CMD ["./docker-entrypoint.sh"]

LABEL org.opencontainers.image.source https://github.com/Fluxcord-Bot/core