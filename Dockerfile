FROM node:20-trixie

ENV PNPM_HOME="/pnpm"

ENV PATH="$PNPM_HOME:$PATH"

RUN apt update

RUN apt install build-essential python3-setuptools python3 ffmpeg -y

RUN wget -qO- https://get.pnpm.io/install.sh | ENV="$HOME/.bashrc" SHELL="$(which bash)" bash -

WORKDIR /app

COPY package*.json ./

COPY pnpm-workspace.yaml ./

RUN pnpm install

COPY . .

RUN chmod +x docker-entrypoint.sh

CMD ["./docker-entrypoint.sh"]