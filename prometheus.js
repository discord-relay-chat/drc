'use strict';

/* List all DRC metrics:
  curl http://localhost:9090/api/v1/metadata | jq '.data | keys | map(select(. | contains("drc_")))'
*/

const config = require('./config');
const { PREFIX } = require('./lib/constants');
const promClient = require('prom-client');
const Redis = require(process.env.NODE_ENV === 'test' ? 'ioredis-mock' : 'ioredis');
const processClient = new Redis(config.redis.url);
const listenClient = new Redis(config.redis.url);
const app = require('fastify')({
  logger: true
});

require('./logger')('prometheus');
promClient.collectDefaultMetrics();

const redisMessageCounter = new promClient.Counter({
  name: 'drc_redis_message_count',
  help: 'Counts of DRC Redis messages',
  labelNames: ['type', 'subType']
});

const HANDLERS = {
  prometheus: async () => ([await promClient.register.metrics(), promClient.register.contentType])
};

app.get('/:component/metrics', async (req, res) => {
  if (!HANDLERS[req.params.component]) {
    return res.send('');
  }

  const [body, contentType] = await HANDLERS[req.params.component]();
  return res.type(contentType).send(body);
});

app.listen(config.prometheus.listenPort, (err, addr) => {
  if (err) { throw err; }
  console.log(`Listening on ${addr}`);

  processClient.on('message', async (_chan, message) => {
    try {
      const { type, data } = JSON.parse(message);
      const { metrics, contentType } = data;
      const [p, e, processName] = type.split(':');

      if (p !== 'prometheus' || e !== 'export') {
        throw new Error(`bad type ${type}`);
      }

      if (!HANDLERS[processName]) {
        console.log(`Saw new exporter for process "${processName}"`);
      }

      HANDLERS[processName] = async () => ([metrics, contentType]);
    } catch (e) {
      console.error(':prometheus:export bad message', message, e);
    }
  });

  listenClient.on('pmessage', async (_pattern, channel, message) => {
    try {
      const { type } = JSON.parse(message);
      const [mainType, ...subTypePath] = type.split(':');
      redisMessageCounter.inc({ type: mainType, subType: subTypePath.join(':') });
    } catch (e) {
      console.error('Unknown redis message shape!', channel, message);
    }
  });

  processClient.subscribe(`${PREFIX}:prometheus:export`);
  listenClient.psubscribe(`${PREFIX}*`);

  process.on('SIGINT', () => {
    console.log('Exiting...');
    processClient.disconnect();
    listenClient.disconnect();
    app.close();
  });
});
