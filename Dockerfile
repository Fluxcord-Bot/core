FROM node:20-trixie

ENV PNPM_HOME="/pnpm"

ENV PATH="$PNPM_HOME:$PATH"

RUN wget -qO- https://get.pnpm.io/install.sh | ENV="$HOME/.bashrc" SHELL="$(which bash)" bash -

WORKDIR /app

COPY package*.json ./

COPY pnpm-workspace.yaml ./

RUN pnpm install

COPY . .

RUN sed -i 's/\r//' docker-entrypoint.sh && chmod +x docker-entrypoint.sh

CMD ["./docker-entrypoint.sh"]