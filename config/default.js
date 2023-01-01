'use strict';

/* References:
 * [1] https://github.com/kiwiirc/irc-framework/blob/master/docs/clientapi.md#constructor
 */

const _ = require('lodash');
const os = require('os');
const path = require('path');

const PROJECT_DIR = path.resolve(path.join(__dirname, '..'));
const HTTP_STATIC_PATH_NAME = 'static';
const MPM_PLOT_FILE_NAME = 'mpmplot.png';
const HTTP_STATIC_DIR = path.join(PROJECT_DIR, 'http', HTTP_STATIC_PATH_NAME);
const HTTP_ATTACHMENTS_DIR = path.join(PROJECT_DIR, 'http', 'attachments');

const SECRET_KEYS = [
  'discord.botId',
  'discord.token',
  'irc.registered',
  'redis.url',
  'shodan.apiKey',
  'ipinfo.token',
  'openai.secretKey'
];

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

const _config = {
  _replace: replace,

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
    squelchIgnored: false,
    squelchReconnectChannelJoins: true,
    supressBotEmbeds: true,
    monospacePrivmsgs: false,
    showAllModeChanges: false,
    destroyGameChannelsWhenDone: false
  },

  app: {
    log: {
      level: 'info',
      addNameVerPrefix: false, // set this to 'true' if not using docker to deploy
      path: process.env?.DRC_LOG_PATH || './logs'
    },
    allowedSpeakers: [],
    allowedSpeakersRoleId: null,
    // options are
    // 'replace' (replace IRC nick with Discord ASers)
    // 'bracket' (turns into: IRCNick[DiscordASers])
    allowedSpeakersHighlightType: 'replace',
    timeout: 30,
    statsTopChannelCount: 10,
    statsMaxNumQuits: 50,
    statsSilentPersistFreqMins: 15,
    maxNumKicks: 5,
    // the above three really need to move into the struct below
    // but i'm way too lazy to go through and do that right now
    stats: {
      embedColors: {
        main: '#4477ff',
        long: '#1155ee',
        irc: {
          ready: '#aaeeaa',
          ipcReconnect: '#99ff99',
          privMsg: '#bc04fb',
          networkJoined: '#22ff88',
          nickIsGone: '#ff0011'
        }
      },
      MPM_PLOT_FILE_NAME,
      plotEnabled: false,
      mpmPlotOutputPath: path.join(HTTP_STATIC_DIR, MPM_PLOT_FILE_NAME),
      mpmPlotTimeLimitHours: 120 // 5 days
    }
  },

  discord: {
    privMsgChannelStalenessTimeMinutes: 720,
    privMsgChannelStalenessRemovalAlert: 0.1, // remaining of privMsgChannelStalenessTimeMinutes
    privMsgCategoryId: null,
    reactionRemovalTimeMs: 2500,
    maxMsgLength: 1800,
    guildId: '',
    botId: '',
    token: ''
  },

  irc: {
    log: {
      channelsToFile: true,
      events: ['kick', 'ban', 'channel info', 'topic', 'invited', 'wallops',
        'nick', 'nick in use', 'nick invalid', 'whois', 'whowas', 'motd', 'info'],
      path: process.env?.DRC_LOG_PATH ? path.join(process.env.DRC_LOG_PATH, 'irc') : './logs/irc'
    },
    ctcpVersionOverride: null,
    ctcpVersionPrefix: 'Discord Relay Chat',
    ctcpVersionUrl: 'https://discordrc.com',
    floodProtectWaitMs: 500,
    quitMsgChanId: '',
    channelXformsPath: 'config/channelXforms.json',
    heartbeatFrequencyMs: 5000,
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
    enabled: false,
    port: 4242,
    proto: 'https',
    fqdn: os.hostname(),
    ttlSecs: 30 * 60,
    staticDir: HTTP_STATIC_DIR,
    attachmentsDir: HTTP_ATTACHMENTS_DIR,
    rootRedirectUrl: 'https://discordrc.com'
  },

  capture: {
    enabled: true,
    autoCaptureWindowMins: 5,
    defaultCaptureWindowMins: 15,
    cleanupLoopFreqSeconds: 17
  },

  ipinfo: {
    token: null
  },

  cli: {
    nickColors: ['cyan', 'magenta', 'red', 'blue', 'yellow'] /* no green! that's our color */
  },

  siteCheck: {
    sites: [],
    frequencyMinutes: {
      slow: 30,
      fast: 3
    }
  },

  openai: {
    secretKey: null,
    model: 'text-davinci-003',
    temperature: 0.7,
    maxTokens: 4000
  },

  hostDaemon: {
    enabled: false,
    whitelistedBinaries: ['nmap', 'df', 'uptime', 'who', 'gnuplot', 'sudo', 'zork', 'adventure']
  },

  _secretKeys: SECRET_KEYS,

  toJSON () {
    return replace(this, SECRET_KEYS, '*');
  }
};

_config.app.stats.getMpmPlotFqdn = () =>
  `${require('config').http.proto ?? 'https'}://` +
  `${require('config').http.fqdn}/${HTTP_STATIC_PATH_NAME}/${MPM_PLOT_FILE_NAME}`;

module.exports = _config;
