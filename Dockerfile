FROM node:18 as base
WORKDIR /app/drc
RUN apt-get clean all
RUN apt update
RUN apt -y upgrade
RUN apt -y autoremove
RUN apt -y install nmap figlet
RUN useradd -u 1001 -U -p discordrc drc
COPY package*.json ./
RUN npm install
COPY *.js .
COPY lib ./lib/
COPY config/default.js ./config/
COPY config/local-prod.json ./config/
COPY config/channelXforms-prod.json ./config/
COPY http ./http/
COPY scripts ./scripts/
RUN chown -R drc /app/drc/scripts
ENV NODE_ENV=prod
ENV DRC_LOG_PATH=/logs
ENV DRC_IN_CONTAINER=1
ENV TZ="America/Los_Angeles"
STOPSIGNAL SIGINT

FROM base as http
COPY http.js .
ENV DRC_HTTP_PATH=/http
USER drc
CMD ["node", "http"]

FROM base as irc
COPY irc.js .
COPY irc ./irc/
COPY discord ./discord/
COPY .certs ./.certs/
RUN chown -R drc /app/drc/.certs/
USER drc
CMD ["node", "irc"]

FROM base as discord
COPY discord.js .
COPY discord ./discord/
COPY irc/numerics.js ./irc/
# zork is packaged in a snap, which does not run in containers :(
RUN apt -y install bc gnuplot colossal-cave-adventure imagemagick-6.q16
ENV PATH=/usr/games:$PATH
USER drc
CMD ["node", "discord"]

FROM base as prometheus
COPY prometheus.js .
USER drc
CMD ["node", "prometheus"]