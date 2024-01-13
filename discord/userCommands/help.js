'use strict';

const config = require('../../config');
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

  const ascpc = config.app.allowedSpeakersCommandPrefixCharacter;
  if (!toSend) {
    const toSendEmbed = new MessageEmbed()
      .setTitle('DiscordRC User Command Help')
      .setDescription('Those `<command>`s bulleted below with "**»**" (instead of "•") have further help available via any of these equivalent alternatives:\n• ' +
        ['help <command>', '<command> -h', '<command> --help'].map(s => '`' + ascpc + s + '`').join('\n• ') + '\n\n' +
        'Only the shortest unique prefix of a command name is required. The exception to this rule is aliases: they will' +
        'be checked first (regex then normal strings), must match exactly to trigger.\n\n' +
        'Multiple commands may be run _serially_ in a single invocation with `|>` or _concurrently_ with `!>`. ' +
        'These may be combined, with concurrent sections processed together as one serial section. For example:\n' +
        `\`\`\`\n${ascpc}stats |> ${ascpc}whois libera outage-bot !> ${ascpc}sys |> ${ascpc}ps\n\`\`\`\n` +
        `Here, \`${ascpc}stats\` runs first serially; then, \`${ascpc}whois\` and \`${ascpc}sys\` are run concurrently together; ` +
        `finally, once they have both completed, \`${ascpc}ps\` is run.` +
        '\n\n')
      .setColor('#0011ff');

    context.sendToBotChan(toSendEmbed, true);

    let sortedChonkers = Object.entries(reReq.__functions)
      .filter(([fk]) => fk.indexOf('_') !== 0)
      .sort();

    const FIELD_AMT_LIMIT = 25;
    for (let page = 1; sortedChonkers.length; page++) {
      const chonkEmbed = new MessageEmbed()
        .setTitle(`Available commands, page ${page}`)
        .setColor('#0011ff');

      sortedChonkers.slice(0, FIELD_AMT_LIMIT).forEach(([fk, { __drcHelp }]) => {
        let titleStr = ' ';

        if (__drcHelp && typeof (__drcHelp) === 'function' && __drcHelp().title) {
          titleStr = `_${__drcHelp().title}_`;
        }

        chonkEmbed.addField((__drcHelp ? '**»**' : '•') + ' ' + fk, titleStr);
      });

      sortedChonkers = sortedChonkers.slice(FIELD_AMT_LIMIT);
      context.sendToBotChan(chonkEmbed, true);
    }
  } else {
    if (typeof toSend === 'string') {
      toSend = '```\n' + toSend + '\n```';
      context.sendToBotChan(toSend);
    } else {
      if (typeof toSend === 'object') {
        if (!toSend.title || !toSend.usage) {
          throw new Error('bad shape of help object');
        }

        const styledTitle = '_**' + toSend.title + '**_';
        const toSendEmbed = new MessageEmbed()
          .setTitle('`' + config.app.allowedSpeakersCommandPrefixCharacter + cmd + '`')
          .setDescription(styledTitle)
          .setColor(toSend.color || '#0011ff')
          .addField('Usage', '`' + config.app.allowedSpeakersCommandPrefixCharacter + cmd + ' ' + toSend.usage + '`')
          .setTimestamp();

        if (toSend.notes) {
          toSendEmbed.setDescription(styledTitle + '\n\n' + toSend.notes);
        }

        if (toSend.options && Array.isArray(toSend.options)) {
          toSendEmbed.addField('Options', 'When arguments are taken (**»**), the syntax is `--option=argument`');
          for (const [optName, optDesc, takeArg] of toSend.options) {
            toSendEmbed.addField((takeArg ? '» ' : '• ') + '`' + optName + '`', optDesc);
          }
        }

        if (toSend.subcommands) {
          for (const [name, { header, text }] of Object.entries(toSend.subcommands)) {
            toSendEmbed.addField('⁍ `' + name + '`' + (text && header ? ` _${header}_` : ''), text);
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
