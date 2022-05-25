# Discord Relay Chat

I heard you liked IRC & Discord so I put some IRC in your Discord.

## Documentation

[DiscordRC.com](https://discordrc.com)

### Quick start with Docker (Linux only)

Run `redis` as a regular 'ol system service.

Put your specific configurations into `local-prod.json` (and other `*-prod.json` files as necessary).
  * `.app.log.path` and `.irc.log.path` must **not** be modified/overridden; leave them as their defaults.

You must set the environment variable `DRC_LOGS_PATH_HOST` to the a fully-qualified path _on the host_ where your logs are kept.

All of the following `docker compose` invocations must be run in this directory.

Start everything:

```
$ export DRC_LOGS_PATH_HOST=/home/myuser/.drc/logs
$ docker compose up -d
```

Watch the logs with `docker compose logs -f`. 

To stop everything: `docker compose down`.
