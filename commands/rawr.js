const rawr = ["rawr"];

/**
 * @type {import('../utils/CommandSchema.js').CommandSchema}
 */
const command = {
  name: "rawr",
  description: ":3",
  requireElevated: false,
  hideFromHelp: true,
  async run(params, message, discordClient, fluxerClient) {
    message.reply(rawr[Math.floor(Math.random() * rawr.length)]);
  },
};

export default command;
