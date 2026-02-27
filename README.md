# Fluxcord
A set-and-forget Discord <-> Fluxer bridge.

## Features
- Basic message bridging
- Edit/Delete bridging
- Reply bridging
- Emoji bridging
- Embed bridging
- Attachment bridging
- Pins bridging
- Bulk deletion bridging
- *others soon*

## Self hosted setup 
- Install Docker and Docker Compose
- Clone this repository: `git clone https://git.gay/jbcarreon123/Fluxcord`
- Copy `config.example.ts` to `config.ts`
- Edit `config.ts` to the things needed by it
- Run `docker compose up -d --build`

## Updating
- Run `git pull`
- Check for config changes on the example config file
- Run `docker compose up -d --build`