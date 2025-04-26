'use strict';

/* References:
 * [1] https://github.com/kiwiirc/irc-framework/blob/master/docs/clientapi.md#constructor
 */

const _ = require('lodash');
const os = require('os');
const path = require('path');

const PROJECT_DIR = path.resolve(path.join(__dirname, '..'));
const MPM_PLOT_FILE_NAME = 'mpmplot.png';
const HTTP_STATIC_PATH_NAME = 'static';
const HTTP_PATH = process.env?.DRC_HTTP_PATH || path.join(PROJECT_DIR, 'http');
const HTTP_STATIC_DIR = path.join(HTTP_PATH, HTTP_STATIC_PATH_NAME);
const HTTP_ATTACHMENTS_DIR = path.join(HTTP_PATH, 'attachments');

const SECRET_KEYS = [
  'discord.botId',
  'discord.token',
  'irc.registered',
  'redis.url',
  'shodan.apiKey',
  'ipinfo.token',
  'openai.secretKey',
  'alpaca.apiKey',
  'anthropic.secretKey'
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

  // stop adding stuff here until #24 is addressed!
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
      path: process.env?.DRC_LOG_PATH || './logs',
      // options are: html, json, jsonl
      localQueryOutputFormat: 'html'
    },
    avatarGenerator: 'robohash',
    allowedSpeakers: [],
    allowedSpeakersRoleId: null,
    allowedSpeakersHighlight: true,
    // options are
    // 'replace' (replace IRC nick with Discord ASers)
    // 'bracket' (turns into: IRCNick[DiscordASers])
    allowedSpeakersHighlightType: 'replace',
    allowedSpeakersCommandPrefixCharacter: ';',
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
      plotEnabled: true,
      plotBackupsAndGifGenerationEnabled: false,
      mpmPlotOutputPath: path.join(HTTP_STATIC_DIR, MPM_PLOT_FILE_NAME),
      mpmPlotTimeLimitHours: 24
    },
    userScriptsEnabledAtStartup: false,
    includeDiscordAuthorNameInIRCMessages: false // enable when using DRC as a bridge
  },

  discord: {
    disableUrlEmbeds: true, // wraps any URLs detected in angle-brackets (<>) before sending to Discord
    userScriptOutputChannelId: '',
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
        'nick', 'nick in use', 'nick invalid', 'whois', 'whowas', 'motd', 'info',
        'quit', 'part', 'join'],
      path: process.env?.DRC_LOG_PATH ? path.join(process.env.DRC_LOG_PATH, 'irc') : './logs/irc'
    },
    ctcpVersionOverride: null,
    ctcpVersionPrefix: 'Discord Relay Chat',
    ctcpVersionUrl: 'https://discordrc.com',
    floodProtectWaitMs: 150,
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
          // highly recommended to set this to true to ensure that multi-line messages are always sent in-order
          "serialize_writes": true,
          // if you're connecting to a TLS port, you must still explicitly set this to true
          "tls": true,
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
    enabled: true,
    cacheDir: '/tmp/.discordrc.banners.cache',
    font: 'small'
  },

  nmap: {
    defaultOptions: ['-v', '-Pn']
  },

  shodan: {
    apiKey: ''
  },

  http: {
    enabled: false,
    port: 4242,
    proto: 'https',
    host: 'localhost',
    fqdn: os.hostname(),
    ttlSecs: 120 * 60,
    staticDir: HTTP_STATIC_DIR,
    attachmentsDir: HTTP_ATTACHMENTS_DIR,
    rootRedirectUrl: 'https://discordrc.com',
    editor: {
      defaultTheme: 'vs-dark', // valid options are those in the "Theme" drop down in the editor
      defaultFontSizePt: 14
    },
    // the root URL of a running instance of https://github.com/rpj/shrtn which will be used to shorten attachment links
    shrtnHost: null,
    // if the above is non-null and your shrtn is configured with authorization enabled, enter your user credentials here
    shrtnCreds: {
      user: null,
      pass: null
    }
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
    organization: '',
    model: 'gpt-4',
    chatModel: 'gpt-4',
    temperature: 0.9,
    maxTokens: 3700,
    viaHTML: 'the <a href="https://beta.openai.com/docs/guides/completion" target="_blank">OpenAI text completion API</a>'
  },

  alpaca: {
    /*
    hosts: {
      // will result in queries to:
      // https://alpaca.example.com/prompt and https://alpaca-ht.example.com/prompt
      "example.com": {
        models: ["alpaca", "alpaca-ht"],
        scheme: "https"
      }
    }
    */
    hosts: {},
    waitTimeSeconds: 17,
    camelidaeFrontendAvailable: false,
    defaultModel: '',
    apiKey: ''
  },

  anthropic: {
    secretKey: null,
    model: 'claude-3-7-sonnet-20250219',
    temperature: 0.7,
    maxTokens: 4000,
    system: 'You are Claude, an AI assistant created by Anthropic to be helpful, harmless, and honest.',
    viaHTML: 'the <a href="https://docs.anthropic.com/claude/docs/introduction-to-claude" target="_blank">Anthropic Claude API</a>'
  },

  genai: {
    emojiReactionSystemPrompt: 'You are a helpful, harmless, and honest assistant to a user of an IRC network. They want to help another user with a question but do not know the answer or need clairifying information, so are asking you. Provide as much detail & references as possible to enable them to help the user. Here is the question: '
  },

  prometheus: {
    listenPort: 9903,
    collectDefaultMetrics: true, /* includes a collection of nodejs process metrics plus drc_<processName>_uptime */
    exportFreqSeconds: 10 /* for promRedisExport: how often to export metrics over redis to the prometheus daemon */
  },

  _secretKeys: SECRET_KEYS,

  toJSON () {
    return replace(this, SECRET_KEYS, '*');
  }
};

_config.app.stats.getMpmPlotFqdn = (fnameOverride) =>
  `${require('config').http.proto ?? 'https'}://` +
  `${require('config').http.fqdn}/${HTTP_STATIC_PATH_NAME}/${fnameOverride ?? MPM_PLOT_FILE_NAME}`;

module.exports = _config;
