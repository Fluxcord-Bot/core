FROM oven/bun:debian

RUN apt update

RUN apt install python3 -y

WORKDIR /app

COPY package*.json ./

RUN bun install

COPY . .

CMD ["bun", "index.ts"]