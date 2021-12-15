'use strict';

/* References:
 * [1] https://github.com/kiwiirc/irc-framework/blob/master/docs/clientapi.md#constructor
 */

const _ = require('lodash');
const os = require('os');

function replace (obj, keys, replacement) {
  const result = _.cloneDeep(obj);
  if (!Array.isArray(keys)) {
    keys = [keys];
  }
  keys.forEach((key) => {
    if (_.has(result, key)) {
      _.set(result, key, replacement);
    }
  });
  return result;
}

module.exports = {
  user: {
    autoCaptureOnMention: true,
    deleteDiscordWithEchoMessageOn: true,
    joinsToBotChannel: false,
    markHilites: false,
    notifyOnNotices: false,
    persistMentions: true,
    showJoins: false,
    showNickChanges: true,
    showParts: true,
    showQuits: false,
    squelchIgnored: true,
    supressBotEmbeds: true
  },

  app: {
    log: {
      level: 'info',
      path: './logs'
    },
    allowedSpeakers: [],
    timeout: 30,
    statsTopChannelCount: 10,
    statsMaxNumQuits: 50,
    statsSilentPersistFreqMins: 30,
    // the above three really need to move into the struct below
    // but i'm way too lazy to go through and do that right now
    stats: {
      embedColors: {
        main: '#4477ff',
        long: '#1155ee',
        irc: {
          ready: '#aaeeaa',
          ipcReconnect: '#99ff99'
        }
      }
    }
  },

  discord: {
    maxMsgLength: 1800,
    guildId: '',
    botId: '',
    token: ''
  },

  irc: {
    log: {
      channelsToFile: true,
      path: './logs/irc'
    },
    ctcpVersionPrefix: 'Discord Relay Chat',
    ctcpVersionUrl: 'https://discordrc.com',
    floodProtectWaitMs: 500,
    quitMsgChanId: '',
    registered: {
      /*
      "networkHostname": {
        "port": 6667,
        "user": {
          // any options valid for the irc-framework constructor[1] are valid here
          "nick": "",
          "account": { // will, generally, auto-authenticate with nickserv when present. if not, use !onConnect
            "account": "nickservRegisteredName",
            "password": "" // if falsy, will be prompted for on the console
          }
        }
      }
      */
    },
    channelXforms: {
      /*
      "networkHostname": {
        // NOTE: both are specified WITHOUT the leading hash (#)!
        "discordChannelName": "ircChannelName",

        // examples from irc.libera.chat where the irc channel name is not a valid discord channel name
        "nodejs": "node.js",
        "chat": "#chat", // libera channel name is ##chat
        "cpp": "c++",
        "infra-talk": "#infra-talk" // libera channel name is ##infra-talk
      }
      */
    }
  },

  redis: {
    url: ''
  },

  figletBanners: {
    enabled: false,
    cacheDir: '.banners.cache',
    font: 'small'
  },

  nmap: {
    defaultOptions: ['-v', '-Pn', '-O', '--traceroute']
  },

  shodan: {
    apiKey: ''
  },

  http: {
    port: 4242,
    fqdn: os.hostname(),
    ttlSecs: 30 * 60
  },

  capture: {
    enabled: true,
    autoCaptureWindowMins: 5,
    defaultCaptureWindowMins: 15,
    cleanupLoopFreqSeconds: 17
  },

  toJSON () {
    return replace(this, [
      'discord.botId',
      'discord.token',
      'irc.registered',
      'redis.url',
      'shodan.apiKey'
    ], '*');
  }
};
