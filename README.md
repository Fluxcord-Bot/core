# Fluxcord

A set-and-forget Discord <-> Fluxer bridge.

## Features

- Basic message bridging
- Voice bridging
- Edit/Delete bridging
- Reply bridging
- Emoji bridging
- Embed bridging
- Attachment bridging
- Sticker bridging
- Pin bridging
- Bulk deletion bridging
- Thread and forum bridging
- Channel topic and forum tag synchronization
- Typing indicator bridging
- Announcement channel auto-publishing
- Per-server/community opt-in enforcement for users who opted out globally

## Self hosted setup

Check https://fluxcord.jbcrn.dev/self-hosting for self hosting docs

The Discord bot needs the **Message Content** privileged intent enabled.

## Development

Firstly, this requires both Node.js and PNPM installed.

**Do not pull this repo directly.** Instead, pull the Fluxcord Dev repository:

```
git pull https://git.gay/Fluxcord/dev Fluxcord
```

then initialize it:

```bash
cd Fluxcord
pnpm run init
```

If you use VSCode or a fork, you can find a code-workspace file here that can help you with stuff.
