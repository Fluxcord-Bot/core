const meow = [
  "mreow",
  "mrrp",
  "meow",
  "miao",
  "miaow",
  "prrt",
  "brrt",
  "meooow",
  "miaaaaow",
  "rawr",
  "purrr",
  "nyan",
  "miau",
  "miaou",
  "mjau",
  "myau",
  "niau",
  "MEOEW",
  "MEOW",
  "mrrm",
  "nya",
];

/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  name: "meow",
  description: ":3",
  requireElevated: false,
  hideFromHelp: true,
  async run(params, message, discordClient, fluxerClient) {
    message.reply(meow[Math.floor(Math.random() * meow.length)]);
  },
};

export default command;
