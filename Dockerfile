FROM node:18 as base
WORKDIR /usr/src/drc
COPY package*.json ./
RUN npm install
COPY *.js .
COPY config/default.js ./config/
COPY config/local-prod.json ./config/
COPY config/channelXforms-prod.json ./config/
COPY http ./http/
STOPSIGNAL SIGINT

FROM base as http
WORKDIR /usr/src/drc
COPY http.js .
ENV NODE_ENV=prod
ENV DRC_LOG_PATH=/logs
ENV TZ="America/Los_Angeles"
CMD ["node", "http"]

FROM base as irc
WORKDIR /usr/src/drc
COPY irc.js .
COPY irc ./irc/
COPY .certs ./.certs/
ENV NODE_ENV=prod
ENV DRC_LOG_PATH=/logs
ENV TZ="America/Los_Angeles"
CMD ["node", "irc"]

FROM base as discord
WORKDIR /usr/src/drc
COPY discord.js .
COPY discord ./discord/
COPY irc/numerics.js ./irc/
ENV NODE_ENV=prod
ENV DRC_LOG_PATH=/logs
ENV TZ="America/Los_Angeles"
CMD ["node", "discord"]
