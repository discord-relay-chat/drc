'use strict';

const config = require('config');
const Redis = require('ioredis');
const { spawn } = require('child_process');
const { PREFIX, resolveNameForIRC, scopedRedisClient, resolveNameForDiscord, runningInContainer } = require('../util');
const LiveNicks = require('./liveNicks');

let categories = {};

async function floodProtect (ops, ...args) {
  for (const op of ops) {
    await new Promise((resolve, reject) => {
      setTimeout(async () => {
        try {
          resolve(await op(...args));
        } catch (e) {
          reject(e);
        }
      }, config.irc.floodProtectWaitMs);
    });
  }
}

async function updateUsersForNetworkChannelBase (
  connectedIRC, specServers, createNewChanSpec, network, channel
) {
  const client = connectedIRC.bots[network];

  if (!client) {
    console.error('updateUsersForNetworkChannel -- no client!!', network, channel);
    return;
  }

  const clientChan = client.channel(channel);
  return new Promise((resolve) => {
    clientChan.updateUsers(async (updatedChannel) => {
      const { users, name } = updatedChannel;
      const resChannel = await resolveNameForDiscord(network, channel);
      let [chanSpec] = specServers[network].channels.filter(c => c.name === resChannel);

      // will be undefined if !chanSpec below which is desired because a newly-created
      // spec should not be merged with anything
      const mergeCollection = chanSpec?.liveNicks;

      // can happen if the user has just created this channel recently and quickly
      // issues !users on it (not an uncommon thing to do...)
      if (!chanSpec) {
        chanSpec = createNewChanSpec(name, clientChan.id, clientChan.parentId);
        console.error(`No chanSpec for ${network}/${channel} in updateUsers path! Filling it in with:`, chanSpec);
        console.error('clientChan', clientChan);
        specServers[network].channels.push(chanSpec);
      }

      chanSpec.liveNicks = new LiveNicks(users.map(({ nick }) => nick), mergeCollection);
      users.forEach(({ nick }) => console.debug(`<LIVE NICKS> ADD      event=!UP! channel=${chanSpec.name} nick=${nick}`));
      console.log(`Updated live nicks for ${network}/${channel}`);

      resolve({
        channel: {
          name,
          users
        },
        network
      });
    });
  });
}

module.exports = async (context, chan, msg) => {
  const {
    connectedIRC,
    msgHandlers,
    specServers,
    chanPrefixes,
    stats,
    haveJoinedChannels,
    children,
    disconnectedBots,
    createNewChanSpec
  } = context;

  const pubClient = new Redis(config.redis.url);
  console.debug('Redis msg!', chan, msg);

  const updateUsersForNetworkChannel = updateUsersForNetworkChannelBase.bind(null, connectedIRC, specServers, createNewChanSpec);

  try {
    const parsed = JSON.parse(msg);

    // returns an async function if pushTarget is null, otherwish pushes that function
    // onto pushTarget and returns an object detailing the channel specification
    const getChannelJoinFunc = async (pushTarget = null, serverSpec, chan) => {
      const botClient = connectedIRC.bots[serverSpec.name];

      if (!botClient) {
        throw new Error(`!botClient ${serverSpec.name}`);
      }

      const resName = await resolveNameForIRC(serverSpec.name, chan.name);
      const ircName = `#${resName}`;
      const channel = [PREFIX, serverSpec.name, resName, chan.id].join(':');
      const chanSpec = { channel, name: chan.name, ircName, id: chan.id, __drcNetwork: serverSpec.name };

      serverSpec.uniqueNicks = new Set();

      if (!msgHandlers[serverSpec.name]) {
        msgHandlers[serverSpec.name] = {};
      }

      const serverMsgHandlers = msgHandlers[serverSpec.name];
      if (serverMsgHandlers[channel]) {
        throw new Error(`channel ${chan.name} on ${serverSpec.name} is already joined!`);
      }

      const retFunc = async () => {
        const ircName = `#${resName}`;
        const chanPubClient = new Redis(config.redis.url);
        const chanObj = botClient.channel(ircName);
        serverMsgHandlers[ircName] = { resName, channel, chanPubClient };
        console.debug(`${ircName} HANDLER REG`, resName, channel);

        console.log(`Joining ${ircName} (${chan.name}) (mapped to ${chan.id}) on ${serverSpec.name}: ${channel}`);
        const joinRes = chanObj.join(ircName);
        console.debug('joinRes', joinRes);

        return new Promise((resolve) => {
          chanObj.updateUsers(async (channel) => {
            console.debug('!! CHANNEL USERS !!', channel.users);
            chanSpec.userCount = channel.users.length;
            chanSpec.operators = channel.users.filter(x => x.modes.includes('o')).map(x => x.nick);

            await scopedRedisClient(async (newPubC) => newPubC.publish(PREFIX, JSON.stringify({
              type: 'irc:channelJoined',
              data: chanSpec
            })));

            chan.liveNicks = new LiveNicks(channel.users.map(u => u.nick));
            channel.users.forEach(({ nick }) => serverSpec.uniqueNicks.add(nick));
            channel.users.forEach(({ nick }) => console.debug(`<LIVE NICKS> ADD      event=!IN! channel=${chan.name} nick=${nick}`));
            console.log(`Joined ${ircName}, it has ${channel.users.length} users`);
            resolve(chanSpec);
          });
        });
      };

      if (!pushTarget) {
        return retFunc;
      } else {
        pushTarget.push(retFunc);
        return chanSpec;
      }
    };

    const discordChannelsHandler = async (isReconnect) => {
      if (Object.entries(specServers).length && !Object.keys(disconnectedBots).length) {
        console.error('Rx\'ed discord:channels but servers are already speced!');
        console.debug(specServers, disconnectedBots);
        return;
      }

      let servers = Object.assign({}, connectedIRC.bots);

      if (Object.keys(disconnectedBots).length > 0) {
        servers = {};
        Object.keys(disconnectedBots).forEach((db) => (servers[db] = true));
      }

      console.debug(`discordChannelsHandler with local servers keys: ${Object.keys(servers)} (${Object.keys(specServers)})`);

      const { categoriesByName } = parsed.data;
      categories = context.categories = parsed.data.categories;

      Object.entries(servers).forEach(([server, _client]) => {
        if (categoriesByName[server]) {
          specServers[server] = {
            ids: categoriesByName[server],
            name: server,
            channels: []
          };
        }
      });

      console.debug('SPEC SERVERS NOW', specServers);

      Object.entries(categories).forEach(([catId, category]) => {
        console.debug('HAVE CAT', catId, category.name, category);
        Object.entries(category.channels).forEach(([id, chanEnt]) => {
          const { name } = chanEnt;
          console.debug('HAVE CHAN', id, name, chanEnt);
          if (connectedIRC.bots[category.name]) {
            specServers[category.name].channels.push(createNewChanSpec(name, id, chanEnt.parentId));
          }
        });
      });

      console.debug('specServers', JSON.stringify(specServers, null, 2));

      for (const [_, serverSpec] of Object.entries(specServers)) { // eslint-disable-line no-unused-vars
        const botClient = connectedIRC.bots[serverSpec.name];

        if (!botClient) {
          throw new Error(`!botClient ${serverSpec.name}`);
        }

        console.log(`Joining channels on ${serverSpec.name}... (isReconnect: ${isReconnect})`);

        const joinFuncs = [];
        chanPrefixes[serverSpec.name] = await Promise.all(serverSpec.channels.map(getChannelJoinFunc.bind(null, joinFuncs, serverSpec), []));

        // isReconnect logic is not always correct, for example: start the IRC daemon first and let it fully connect to IRC, then
        // start the discord daemon. isReconnect will be 'true' even though it is the first connection for the lifetime of either process.
        // as a stop-gap until that logic is corrected, we must always use floodProtect() here lest we get into the aforementioned
        // situation and flood the server with joins, getting kicked accordingly
        await floodProtect(joinFuncs);

        console.log(`Joined ${joinFuncs.length} channels on ${serverSpec.name}.`);
        console.debug('chanPrefixes for', serverSpec.name, chanPrefixes[serverSpec.name]);

        await pubClient.publish(PREFIX, JSON.stringify({
          type: 'irc:joined',
          data: {
            network: serverSpec.name,
            uniqueNickCount: serverSpec.uniqueNicks.size,
            channels: chanPrefixes[serverSpec.name]
          }
        }));

        if (isReconnect) {
          if (!haveJoinedChannels()) {
            console.error('isReconnect but not !haveJoinedChannels!?');
          }

          console.debug('Emitting irc:ready from discordChannelsHandler with isReconnect: true', parsed);
          await pubClient.publish(PREFIX, JSON.stringify({ type: 'irc:ready', data: { isReconnect: true } }));
        }

        haveJoinedChannels(true);
      }
    };

    const e = parsed.data;
    const botClient = e && (connectedIRC.bots[e.network] || connectedIRC.bots[e.__drcNetwork]);

    if (parsed.type === 'discord:nickInChanReq') {
      const chanSpecs = specServers[e.network].channels.filter(c => c.name === e.channel);
      let nickInChan = false;
      let newNick = null;

      if (chanSpecs.length > 0) {
        if (chanSpecs.length > 1) {
          console.error('Too many chan specs!', e, chanSpecs);
        }

        // take advantage of the side-effect of this method that updates the LiveNicks struct
        const ircName = '#' + await resolveNameForIRC(e.network, e.channel);
        await updateUsersForNetworkChannel(e.network, ircName);

        const [{ liveNicks }] = chanSpecs;
        nickInChan = liveNicks.has(e.nick);

        if (!nickInChan) {
          const wasOnce = liveNicks.had(e.nick);
          if (wasOnce?.length) {
            if (wasOnce.length > 1) {
              console.error('Too many wasOnces!', e.nick, nickInChan, wasOnce, liveNicks);
            } else {
              [newNick] = wasOnce;
            }
          }
        }
      }

      console.log(`discord:nickInChanReq> ${e.nick} in ${e.channel}/${e.network}? -> ${nickInChan} (newNick? ${newNick})`);
      await pubClient.publish(PREFIX, JSON.stringify({
        type: 'irc:nickInChanResponse',
        data: {
          nickInChan,
          newNick,
          __drcNetwork: e.network,
          ...e
        }
      }));
    } else if (parsed.type === 'irc:mode:get') {
      const { network, nickOrChan } = parsed.data;
      let modes = [];
      if (nickOrChan.indexOf('#') === 0) {
        modes = botClient.channel(nickOrChan).mode();
      } else {
        modes = [...botClient.user.modes];
      }

      await pubClient.publish(PREFIX, JSON.stringify({
        type: 'irc:mode:getResponse',
        data: {
          network,
          nickOrChan,
          modes,
          __drcNetwork: e.__drcNetwork
        }
      }));
    } else if (parsed.type === 'irc:mode:set') {
      const { nickOrChan, mode, network } = parsed.data;
      if (nickOrChan.indexOf('#') === 0) {
        botClient.channel(nickOrChan).mode(mode);
      } else {
        botClient.mode(nickOrChan, mode);
      }

      // send a "get" to ourselves (because i'm lazy), on behalf of the user, after a short delay
      setTimeout(() => {
        scopedRedisClient((client) => client.publish(PREFIX, JSON.stringify({
          type: 'irc:mode:get',
          data: {
            network,
            nickOrChan,
            __drcNetwork: e.__drcNetwork
          }
        })));
      }, 1000);
    } else if (parsed.type === 'irc:userMode:set') {
      botClient.mode(config.irc.registered[e.network].user.nick, e.mode.replace('\\', ''));
      // pubClient.publish(PREFIX, JSON.stringify({ type: 'irc:userMode', data: botClient.mode(config.irc.registered[e.network].nick) }));
    } else if (parsed.type === 'irc:userMode:get') {
      await pubClient.publish(PREFIX, JSON.stringify({
        type: 'irc:userMode',
        data: {
          user: botClient.user,
          __drcNetwork: e.__drcNetwork
        }
      }));
    } else if (parsed.type === 'discord:requestPing:irc') {
      console.debug(`Pinging ${e.network}...`);
      botClient.ping(['drc', Number(new Date()).toString()].join('-'));
    } else if (parsed.type === 'discord:deleteChannel') {
      if (parsed.data?.isPrivMsgChannel) {
        return;
      }

      const ircName = '#' + await resolveNameForIRC(e.network, e.name);
      botClient?.part(ircName);
      delete msgHandlers[e.network][ircName];
      chanPrefixes[e.network] = chanPrefixes[e.network].filter(o => o.ircName !== ircName);
    } else if (parsed.type === 'discord:requestJoinChannel:irc') {
      // this comes first to signal the discord bot that we've ACKed the message and are acting on it
      // there's still a race here though on the discord side: if our "irc:topic" is RX'ed BEFORE this
      // message it'll throw an exception because the RX of this message induces the mapping required for
      // "irc:topic" to be handled correctly...
      await pubClient.publish(PREFIX, JSON.stringify({ type: 'irc:responseJoinChannel', data: parsed.data }));

      const { name, id, parentId, networkName } = parsed.data;

      let chanSpec;
      if (networkName) {
        const chanSpecs = specServers[networkName].channels.filter(c => c.name === name);
        chanSpec = chanSpecs.length > 0 ? chanSpecs[0] : null;

        if (!chanSpec) {
          console.warn('New channel spec!', networkName, name, id, parentId, parsed.data);
          chanSpec = createNewChanSpec(name, id, parentId);
          specServers[networkName].channels.push(chanSpec);
        } else {
          // new channel, the ID has changed!
          chanSpec.id = id;
        }
      } else {
        console.warn('requestJoinChannel> missing networkName!', networkName, chanSpec, parsed.data, categories);
      }

      const chanPrefix = await ((await getChannelJoinFunc(null, categories[parsed.data.parentId], chanSpec))());
      chanPrefixes[categories[parsed.data.parentId].name].push(chanPrefix);
    } else if (parsed.type === 'discord:requestSay:irc') { // similar to 'irc:say' below; refactor?
      if (!e.network || !e.target || !e.message) {
        throw new Error('discord:requestSay:irc bad args ' + JSON.stringify(e));
      }

      if (!botClient) {
        throw new Error('discord:requestSay:irc bad client ' + JSON.stringify(e));
      }

      botClient.say(e.target, e.message);
      await pubClient.publish(PREFIX, JSON.stringify({ type: 'irc:responseSay', success: true }));
    } else if (parsed.type === 'discord:requestPs:irc') {
      const data = Object.entries(children).reduce((a, [pid, { started, proc }]) => {
        return [{
          pid,
          started,
          args: proc.spawnargs,
          exec: proc.spawnfile
        }, ...a];
      }, []);

      await pubClient.publish(PREFIX, JSON.stringify({ type: 'irc:responsePs', data }));
    } else if (parsed.type === 'discord:requestWhois:irc') {
      const retObj = {};
      if (!parsed.data || !parsed.data.network || !parsed.data.nick) {
        retObj.error = 'Bad arguments';
      } else {
        const client = connectedIRC.bots[parsed.data.network];
        retObj.requestData = parsed.data;

        if (client) {
          // should probably use the callback to do all the delivery to the user but right now
          // the 'whois' event is wired up and that is taking care of the response to the user
          let whoisCallback = async (whoisData) => {
            return scopedRedisClient(async (endClient, pfx) => endClient.publish(pfx, JSON.stringify({
              type: 'irc:responseWhois:full',
              data: { whoisData, ...retObj }
            })));
          };

          if (parsed.data.options?.nmap) {
            const fullCb = whoisCallback;
            whoisCallback = (whoisData) => {
              fullCb(whoisData).then(() => {
                if (!whoisData.hostname) {
                  // should check more here maybe?
                  return;
                }

                const collectors = { stdout: [], stderr: [] };
                let opts = ['nmap', ...config.nmap.defaultOptions];

                if (Array.isArray(parsed.data.options.nmap)) {
                  opts = [...opts, ...parsed.data.options.nmap];
                }

                if (runningInContainer()) {
                  opts.shift();
                }

                opts.push(whoisData.hostname);
                console.log('Initiaing: ' + opts.join(' '));
                try {
                  const proc = spawn(runningInContainer() ? 'nmap' : 'sudo', opts);

                  proc.stdout.on('data', (d) => collectors.stdout.push(d.toString('utf8')));
                  proc.stderr.on('data', (d) => collectors.stderr.push(d.toString('utf8')));

                  proc.on('error', (err) => console.error('nmap spawn failed', err, opts));

                  proc.on('close', async () => {
                    const started = children[proc.pid].started;
                    delete children[proc.pid];

                    console.log(`nmap of ${whoisData.hostname} finished`);

                    const stdout = collectors.stdout.join('\n');
                    const stderr = collectors.stderr.join('\n');
                    await scopedRedisClient(async (endClient) => endClient.publish(PREFIX, JSON.stringify({
                      type: 'irc:responseWhois:nmap',
                      data: {
                        whoisData,
                        started,
                        stdout,
                        stderr
                      }
                    })));
                  });

                  children[proc.pid] = {
                    started: new Date(),
                    proc
                  };
                } catch (e) {
                  console.error('failed to launch nmap (expected if in docker)', e);
                }
              });
            };
          }

          client.whois(parsed.data.nick, whoisCallback);
          retObj.success = true;
        } else {
          retObj.error = 'Unknown network';
        }
      }

      if (retObj.error) {
        await pubClient.publish(PREFIX, JSON.stringify({ type: 'irc:responseWhois', data: retObj }));
      }
    } else if (parsed.type === 'discord:requestStats:irc') {
      await pubClient.publish(PREFIX, JSON.stringify({ type: 'irc:responseStats', stats }));
    } else if (parsed.type === 'discord:requestCtcp:irc') {
      const { network, nick, type, params } = parsed.data;
      const client = connectedIRC.bots[network];

      if (!client) {
        console.error('requestCtcp -- no client!!', parsed);
        return;
      }

      console.log(`CTCP '${type}' request on ${network} for ${nick} with params`, params);
      client.ctcpRequest(nick, type, params);
    } else if (parsed.type === 'discord:requestUserList:irc') {
      const { network, channel } = parsed.data;
      await scopedRedisClient(async (c) => c.publish(PREFIX, JSON.stringify({
        type: 'irc:responseUserList',
        data: await updateUsersForNetworkChannel(network, channel)
      })));
    } else if (parsed.type === 'irc:say' || parsed.type === 'irc:action') {
      const networkSpec = specServers[parsed.data.network.name];
      const [, subType] = parsed.type.split(':');

      if (!networkSpec) {
        return;
      }

      const botClient = connectedIRC.bots[networkSpec.name];

      if (botClient) {
        botClient[subType](`#${parsed.data.channel}`, parsed.data.message);
      } else {
        console.error('Bad SAY', parsed);
      }
    } else if (parsed.type === 'irc:raw') {
      const networkSpec = specServers[parsed.data.network.name];

      if (!networkSpec) {
        return;
      }

      const botClient = connectedIRC.bots[networkSpec.name];
      // redis-cli -n 1 publish drc-dev '{"type":"irc:raw","data":{"network":{"name":"irc.libera.chat"},"rawList":["PRIVMSG", "@##programming", ":testing, please disregard"]}}'
      botClient.raw(parsed.data.rawList);
    } else if (parsed.type === 'discord:channels') {
      await discordChannelsHandler(false);
    } else if (parsed.type === 'discord:startup') {
      if (!haveJoinedChannels()) {
        console.log('Got discord:startup but !haveJoinedChannels, running startup sequence...');
        await discordChannelsHandler(true);
        return;
      }

      if (!context.allowsBotReconnect()) {
        throw new Error('Bot attempted to reconnect but is disallowed!', parsed);
      }

      console.log('Bot reconnected!');
      console.debug('Emitting irc:ready from discord:startup handler with isReconnect: true', parsed);
      ++stats.discordReconnects;
      await pubClient.publish(PREFIX, JSON.stringify({ type: 'irc:ready', data: { isReconnect: true } }));

      for (const [network, prefixes] of Object.entries(chanPrefixes)) {
        // replay each irc:channelJoined then irc:joined
        for (const chanSpec of prefixes) {
          console.log('Replaying irc:channelJoined on', network);
          await pubClient.publish(PREFIX, JSON.stringify({
            type: 'irc:channelJoined',
            data: chanSpec
          }));
        }

        console.log('Replaying irc:joined for', network);
        console.debug('chanPrefixes', prefixes);
        await pubClient.publish(PREFIX, JSON.stringify({
          type: 'irc:joined',
          data: {
            network,
            channels: prefixes
          }
        }));
      }
    }
  } catch (e) {
    console.error('bad Redis msg', e, msg);
    ++stats.errors;
  } finally {
    pubClient.disconnect();
  }
};
