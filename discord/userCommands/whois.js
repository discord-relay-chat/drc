'use strict';

const { shodanHostLookup, matchNetwork } = require('../../util');
const { PREFIX } = require('../../util');
const Redis = require('ioredis');
const config = require('config');

module.exports = async function (context, ...a) {
  if (a.length < 2) {
    throw new Error('not enough args');
  }

  if (context.argObj?.nmap && typeof context.argObj?.nmap === 'string') {
    context.argObj.nmap = context.argObj.nmap.split(/\s+/g);
  }

  const [netStub, nick] = a;
  const { network } = matchNetwork(netStub);

  const reqObj = {
    type: 'discord:requestWhois:irc',
    data: {
      network,
      nick,
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
    context.registerOneTimeHandler('irc:whois', `${network}_${nick}`, async (data) => {
      const r = new Redis(config.redis.url);
      await r.publish(PREFIX, JSON.stringify({
        type: 'discord:shodan:host',
        data: await shodanHostLookup(data.hostname)
      }));
      r.disconnect();
    });
  }

  console.log('whois PUB', reqObj);
  await context.publish(reqObj);
};
