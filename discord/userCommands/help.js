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
    const cmdListStr = Object.keys(reReq.__functions)
      .filter((fk) => fk.indexOf('_') !== 0)
      .sort()
      .map((fk) =>
        '• ' + (reReq.__functions[fk].__drcHelp ? `**${fk}**` : fk)
      ).join('\n');
    const toSendEmbed = new MessageEmbed()
      .setTitle('Command Listing')
      .setDescription('**Bolded** have further help available via `!help [command]`.\n\n' +
        'Multiple commands may be run _serially_ in a single invocation with `|>` or _concurrently_ with `!>`. ' +
        'These may be combined, with concurrent sections processed together as one serial section. For example:\n' +
        '```\n!stats |> !whois libera outage-bot !> !sys |> !ps\n```\n' +
        '`!stats` runs first serially. Then, `!whois` and `!sys` are run concurrently together. ' +
        'When they have both completed, `!ps` is run.' +
        '\n\n')
      .setColor('#0011ff')
      .setTimestamp()
      .addField('Available Commands:', cmdListStr);
    context.sendToBotChan(toSendEmbed, true);
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
          toSendEmbed.setDescription(toSend.notes);
        }

        if (toSend.options && Array.isArray(toSend.options)) {
          toSendEmbed.addField('Options', 'When arguments are taken (**»**), the syntax is `--option=argument`');
          for (const [optName, optDesc, takeArg] of toSend.options) {
            toSendEmbed.addField((takeArg ? '» ' : '• ') + '`' + optName + '`', optDesc);
          }
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

f.__drcHelp = () => ({
  title: 'This help!',
  usage: '[command]',
  notes: 'Use "!help [command]" to get detailed help with "command".'
});

module.exports = f;
