'use strict';

const { MessageEmbed } = require('discord.js');

function f (context) {
  const [cmd] = context.options._;

  const reReq = require('../userCommands');

  let toSend;
  if (cmd && reReq.__functions[cmd]) {
    const helpFunc = reReq.__functions[cmd].__drcHelp;

    if (!helpFunc) {
      throw new Error(`no __drcHelp defined for "${cmd}"`);
    }

    toSend = helpFunc(context);
  }

  if (!toSend) {
    context.sendToBotChan('_Available commands, **bolded** have further help available via `!help [command]`_: ' +
      Object.keys(reReq.__functions).sort().map((fk) =>
        reReq.__functions[fk].__drcHelp ? `**${fk}**` : fk
      ).join(', ') + '\n');
  } else {
    if (typeof toSend === 'string') {
      toSend = '```\n' + toSend + '\n```';
      context.sendToBotChan(toSend);
    } else {
      if (typeof toSend === 'object') {
        if (!toSend.title || !toSend.usage) {
          throw new Error('bad shape of help object');
        }

        const toSendEmbed = new MessageEmbed()
          .setTitle(toSend.title)
          .setColor(toSend.color || '#0011ff')
          .addField('Usage', '`!' + cmd + ' ' + toSend.usage + '`')
          .setTimestamp();

        if (toSend.notes) {
          toSendEmbed.addField('Notes', toSend.notes);
        }

        if (toSend.subcommands) {
          for (const [name, { header, text }] of Object.entries(toSend.subcommands)) {
            toSendEmbed
              .addField('Subcommand', '`' + name + '`')
              .addField(text && header ? header : 'Usage', text);
          }
        }

        toSend = toSendEmbed;
      }

      context.sendToBotChan(toSend, true);
    }
  }
}

f.__drcHelp = (context) => {
  return 'This help! Use "!help [command]" to get detailed help with "command"';
};

module.exports = f;
