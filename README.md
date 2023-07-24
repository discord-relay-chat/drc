![DRC logo](https://github.com/discord-relay-chat/discordrc.com/blob/main/static/images/drc-logo-1.png "DRC logo")

# Discord Relay Chat

I heard you liked IRC & Discord so I put some IRC in your Discord.

## Social

[![Discord](https://shields.io/badge/chat-discord-7289da?style=for-the-badge)](https://discord.gg/dHmqx5vAw2)
[![Libera Chat](https://shields.io/badge/chat-libera%20chat-ec62d7?style=for-the-badge)](https://web.libera.chat/?channel=#discordrc)

## About DRC

Discord Relay Chat is an IRC client that uses Discord for an easy-to-use, comfortable UI accessible from any machine. It allows multiple server connections while ensuring stability and moderate resource consumption.
With DRC, you’ll not miss out on any mentions or highlights. It also gives you the possibility of alias and kick/ban tracking. You can send attachments, take notes about channels and nicks, or even play [Zork](https://en.wikipedia.org/wiki/Zork)! Thanks to [ChatGPT](https://chat.openai.com/auth/login) integration, you’ll always have someone to talk to.

Visit [the project’s website](https://discordrc.com/) to discover the features and potential of this tool.
There is still some work to do. Fortunately, it’s open source, and contributions are accepted, so hack away!

![DRC UI](https://github.com/edfletcher/discordrc.com/blob/main/static/images/ubuntu-disc.png "DRC UI")

## Documentation

Below you will find instructions on how to install and run the project. Additional documentation is available on [DiscordRC.com](https://discordrc.com)  
Note: documentation is not comprehensive. The source code is the ultimate reference.

## Installation

### Pre-requisites

- [Node](https://nodejs.org/en) v18 or greater
- [Redis](https://redis.io/) v5 or greater
  - Used primarily for inter-process communication, so is highly suggested this be running locally.
- [Discord](https://discord.com/) server & [bot](https://discordjs.guide/preparations/setting-up-a-bot-application.html#creating-your-bot)
  - DRC is designed to be mainly single-tenant (one user), so you should set up a separate Discord server and associated bot for this application.

### Optional pre-requisites

- [nmap](https://nmap.org/)
- [figlet](https://linux.die.net/man/6/figlet)
- [Shodan](https://www.shodan.io/) API key
- [IPInfo](https://ipinfo.io/) API key
- Reverse proxying webserver
  - [Caddy](https://caddyserver.com/) is highly recommended
- [Docker](https://www.docker.com/) if deploying on Linux

### Install

1. Clone/download [the repository](https://github.com/edfletcher/drc)
2. Run `npm install` in the project directory
3. Create `config/local.json` and set the appropriate configuration
   - See [`config/default.js`](https://github.com/edfletcher/drc/blob/main/config/default.js) for examples and commentary

## Setup

In the configuration, `botId` is the “Application ID” in the Discord Developer portal.

The Discord bot must have “Message Content Intent” & “Privileged Gateway Intents” enabled to function correctly.

### Bot channel

1. Create a special channel in no category (or at least not in any of the special categories you’ll create in the next step) for the bot’s status, notice et. al messages.
2. Add this channel’s ID to the configuration in the (truly terribly-named) `irc.quitMsgChanId` [field](https://github.com/edfletcher/drc/blob/8034fd6e9727953f85ce3fd5754df796f4b6bf7b/config/default.js#L73).

### Server categories

1. Add a category for each IRC server, named for that server e.g. `irc.libera.chat`.
1. Add a channel in that category for each IRC channel you wish to join on connect.
1. Add to `config/channelXForms-NODE_ENV.json` with required name transforms! You can also adjust these from the client at any time with the `!channelXforms` command.

### Allowed speakers

To control which Discord users can speak as your IRC user, create a Role in your guild and add users to it you wish to allow to speak and use DRC in your server. Set the ID of this role as `config.app.allowedSpeakersRoleId`.

### Configuration

DRC uses the `config` module and as such follows [these rules](https://github.com/node-config/node-config/wiki/Configuration-Files#file-load-order) as to which configuration file will be used.

`default.js` both specifies all default values as well as illustrates the expected structure. As a hobby project, some of the names have been very poorly chosen. You have my apologies.

#### Critical configuration values

The following configuration parameters must be set by you, the user for the system to function correctly:

- `app.allowedSpeakersRoleId` or `app.allowedSpeakers`
- `discord.botId`
- `discord.guildId`
- `discord.token`
- `irc.quitMsgChanId`

### Using private message channels

If you create a category with a name that matches [this logic](https://github.com/edfletcher/drc/blob/d4d7e8811eeb70c0fd37edf94d006744db1e61a4/discord.js#L629)\* - such as “Private Messages”, “privmsgs”, or “PMs”) - DRC will automatically create a channel in this category for each private message received (a la traditional IRC client’s “query window” feature).

In order for this feature to properly expire these channels after `config.discord.privMsgChannelStalenessTimeMinutes` have elapsed, your Redis server must have `“Kx”` [keyspace notifications](https://redis.io/docs/manual/keyspace-notifications/) enabled!

`* x.match(/priv(?:ate)?\s*me?s(?:sa)?ge?s?/ig) || x === 'PMs'` at the time of this writing

## Run with Docker

(Note: These instructions will work only on Linux due to the networking mode used. Proceed to the next page to learn how to run it manually if you won’t be deploying on Linux.)

Run `redis` as a regular ‘ol system service.

Put your specific configurations into `local-prod.json` (and other `*-prod.json` files as necessary).

- `.app.log.path` and `.irc.log.path` must not be modified/overridden; leave them as their defaults.
  You must set the environment variable `DRC_LOGS_PATH_HOST` to a fully-qualified path _on the host_ where your logs are kept.

All of the following `docker compose` invocations must be run in this directory.

Start everything:

```
$ export DRC_LOGS_PATH_HOST=/home/myuser/.drc/logs
$ docker compose up -d
```

Watch the logs with `docker compose logs -f`

To stop everything: `docker compose down`

## Run manually

In the project directory:

1. Run `node http.js` to start the (optional) web server
1. Run `node discord.js` to start the Discord bot
1. Run `node irc.js` to start the IRC bridge

If any of the required secrets (Discord bot API key or IRC account passwords) are not provided in the configuration file, they will be interactively prompted for. Accordingly, the most secure way to run this application is from within a terminal multiplexer like _screen_ or _tmux_ and not configure any secrets, entering them on each run so they never live on the filesystem nor in a process environment.

You may set `DEBUG=1` in the environment to enable more-verbose logging from any of the daemons.

## Contributors

- [EdFletcher](https://github.com/edfletcher)
- [antishok](https://github.com/antishok)
- [CovertDuck](https://github.com/CovertDuck)
- [OlaPom](https://github.com/OlaPom)
