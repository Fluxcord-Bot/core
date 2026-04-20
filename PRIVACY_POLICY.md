# Privacy Policy

**Last updated: April 20, 2026**

This Privacy Policy describes what data Fluxcord collects, why it collects it, and how it's used. Fluxcord is a Discord <-> Fluxer message bridge bot. If you're a server administrator setting up bridging, or a user in a bridged channel, this document explains what happens to your data.

---

## 1. What Data We Collect

### Stored Persistently (in our database)

When a bridge is configured, Fluxcord stores the following to make the bridge work:

| Data | Why it's stored |
|---|---|
| Discord channel ID | To identify which channel to bridge messages to/from |
| Discord guild (server) ID | To associate the bridge with the correct server |
| Discord webhook ID and token | To post bridged messages as the correct users |
| Fluxer channel ID | Same as above, for the Fluxer side |
| Fluxer guild (community) ID | Same as above, for the Fluxer side |
| Fluxer webhook ID and token | Same as above, for the Fluxer side |
| Bridge direction | Whether the bridge runs Discord→Fluxer, Fluxer→Discord, or both ways |
| Error logging channel ID and platform (optional) | If you've set one, to know where to post error notifications and on which platform |
| Error reaction emoji (optional) | The emoji the bot reacts with when a bridged message fails; configurable per guild |
| Custom bot prefix (optional) | Per-guild override for the bot's command prefix |
| Row timestamps | `createdAt` / `updatedAt` are automatically added by the database layer to every row |

This data is stored in a SQLite database on the server running Fluxcord.

### Also Stored Persistently (per bridged message)

To support edit and deletion bridging, Fluxcord stores the following for each message sent through a bridge:

| Data | Why it's stored |
|---|---|
| Message content (text) | Required to bridge edits to the other platform, and to render reply previews when a reply targets an older bridged message |
| Discord message ID | To identify which bridged message to edit or delete |
| Fluxer message ID | Same as above, for the Fluxer side |
| Originating platform | Whether the message was originally sent on Discord or Fluxer, so the bridge knows which side to mirror edits/deletes to |
| Author user ID | To associate the bridged message with the original sender — used for edits, deletions, and attributing replies back to the correct user |
| Row timestamps | `createdAt` / `updatedAt` are automatically added by the database layer to every row |

This data is stored for as long as the original message exists. It is **automatically deleted** when the original message is deleted on either platform. It is **not** automatically removed if the bridge is later disabled or the bot is removed from the server.

### Processed Transiently (not stored)

The following passes through Fluxcord but is **not saved to disk**:

- Attachments and embeds
- Usernames and display names
- User avatars (referenced by URL, not downloaded)
- Reply metadata
- Reactions and pins
- Voice audio (streamed in real time, never recorded)
- Voice channel join/leave events

---

## 2. What We Don't Collect

- We do not build profiles on individual users. Author IDs are stored only in relation to specific bridged messages — used for edit bridging, delete bridging, and attributing replies back to the original sender — not for any tracking purpose.
- We do not use analytics or tracking tools.

---

## 3. Who Has Access to This Data

If you're using the **hosted version** of Fluxcord, the owner of Fluxcord (JB) has access to the database, which contains the channel and webhook data described in Section 1.

If you're **self-hosting** Fluxcord, you control all the data entirely. The Fluxcord developers or the Fluxcord owner have no access to anything running on your instance.

---

## 4. Data Sharing

We do not sell, rent, or share your data with third parties.

The external services involved are:

- **Discord** and **Fluxer** — messages, media, and metadata are bridged to these platforms as part of core functionality, subject to their respective privacy policies.
- **[fluxer.host](https://fluxer.host/)** — voice bridge processes run on servers hosted here. Audio transits through their infrastructure.
- **Netcup** — the hosting provider for the main Fluxcord instance. The bot and its database run on their servers.

---

## 5. Data Retention

Bridge configuration data (channel IDs, webhook tokens, etc.) is retained until you manually remove the bridge using the `unbridge` command.

Stored message content is deleted when the original message is deleted on either platform. It is not automatically purged when a bridge is removed or the bot is kicked — to have message data removed in those cases, contact us through the support community (see Section 10).

If you want all data associated with your server removed, contact us through the support community (see Section 10).

---

## 6. Voice Bridging

When voice bridging is enabled, Fluxcord captures audio from participants in a Discord voice channel and streams it in real time to the corresponding Fluxer voice room via LiveKit. Audio from Fluxer participants is streamed back to Discord the same way.

**Audio is never recorded or written to disk.** It exists only as an in-memory stream for the duration of the bridge session. When the bridge stops, the audio is gone.

Voice bridge processes run on servers hosted at [fluxer.host](https://fluxer.host/). Audio transits through that infrastructure before reaching the other platform. By using voice bridging, you acknowledge this.

---

## 7. Security

Webhook tokens are stored in the database and are required for Fluxcord to function. If you're self-hosting, ensure your database file is not publicly accessible. On the hosted instance, access to the database is restricted to the server owner.

Webhooks are created automatically by Fluxcord during `setup` — users do not create or manage them directly. If you believe a webhook token associated with Fluxcord has been compromised, run `unbridge` to remove the bridge; this deletes the webhooks Fluxcord created and invalidates their tokens. If any webhook remains in the channel afterwards, you can delete it manually via the channel's settings in Discord and Fluxer.

---

## 8. Children's Privacy

Fluxcord is not intended for use by anyone below the minimum age required by Discord or Fluxer. We do not knowingly collect data from minors.

---

## 9. Changes to This Policy

We may update this policy as the Bot evolves. If we make significant changes, we'll post a notice in the support community. Continued use after changes are posted means you accept the updated policy.

---

## 10. Contact

Questions, data deletion requests, or concerns can be directed to the Fluxcord support community:

- Fluxer: [fluxer.gg/jbcrn](https://fluxer.gg/jbcrn)
- Discord: [discord.jbcrn.dev](https://discord.jbcrn.dev)
- E-Mail: [fluxcord@jbcrn.dev](mailto:fluxcord@jbcrn.dev)
