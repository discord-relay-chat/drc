'use strict';

const { shodanHostLookup, matchNetwork, scopedRedisClient } = require('../../util');
const { PREFIX } = require('../../util');

async function whois (context, ...a) {
  if (context.argObj._.length < 2) {
    throw new Error('not enough args');
  }

  if (context.argObj?.nmap && typeof context.argObj?.nmap === 'string') {
    context.argObj.nmap = context.argObj.nmap.split(/\s+/g);
  }

  // for when '!whois' is issued from a normal channel, rather than as a reaction
  // (which already adds channel ID to the `a` array in messageReactionAdd.js)
  if (context.toChanId && context.argObj._.length === 2) {
    context.argObj._.push(context.toChanId);
  }

  const [netStub, nick, channel] = context.argObj._;
  const { network } = matchNetwork(netStub);

  const reqObj = {
    type: 'discord:requestWhois:irc',
    data: {
      txTs: Number(new Date()),
      network,
      nick,
      channel,
      options: context.argObj
    }
  };

  if (reqObj.data.options?.nmap) {
    if (typeof reqObj.data.options.nmap === 'number') {
      reqObj.data.options.nmap = `${reqObj.data.options.nmap}`;
    }

    if (typeof reqObj.data.options.nmap === 'string') {
      reqObj.data.options.nmap = reqObj.data.options.nmap.split(/\s+/g);
    }
  }

  if (reqObj.data.options?.shodan) {
    console.log('REG SHODAN?', `${network}_${nick}`);
    context.registerOneTimeHandler('irc:responseWhois:full', `${network}_${nick}`, async (data) => {
      console.log('POP SHODAN!', `${network}_${nick}`, data);
      await scopedRedisClient(async (r) => r.publish(PREFIX, JSON.stringify({
        type: 'discord:shodan:host',
        data: await shodanHostLookup(data.hostname)
      })));
    });
  }

  console.debug('whois PUB', reqObj);
  await context.publish(reqObj);
}

whois.__drcHelp = () => {
  return {
    title: 'Run `/whois` on a given nickname.',
    usage: '<network> <nickname>',
    options: [
      ['--full', 'Run a deep alias check as well. **Warning**: may be very resource-heavy!'],
      ['--nmap', "If the user's hostname is a valid IP address, run `nmap` on it."]
    ]
  };
};

module.exports = whois;
