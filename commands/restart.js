/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  groupNames: ["admin", "a"],
  name: "restart",
  aliases: ["r"],
  description: "Restart bot",
  requireElevated: false,
  requireOwner: true,
  async run(params, message, _, _2) {
    await message.reply("Restarting...");

    process.exit(67);
  },
};

export default command;
