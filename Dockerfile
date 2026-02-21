FROM oven/bun:1

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

CMD ["bun", "index.ts"]