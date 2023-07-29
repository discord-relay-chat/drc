'use strict';

const config = require('../config');
const { PREFIX } = require('./constants');
const promClient = require('prom-client');
const Redis = require(process.env.NODE_ENV === 'test' ? 'ioredis-mock' : 'ioredis');
const processClient = new Redis(config.redis.url);
let exporterHandle;

module.exports = function (processName, collectDefaultMetrics = config.prometheus.collectDefaultMetrics) {
  if (!exporterHandle) {
    let uptimeCounter;
    if (collectDefaultMetrics) {
      promClient.collectDefaultMetrics();

      uptimeCounter = new promClient.Counter({
        name: `drc_${processName}_uptime`,
        help: 'Process uptime',
        unit: 'seconds'
      });
    }

    exporterHandle = setInterval(async () => {
      uptimeCounter?.inc(config.prometheus.exportFreqSeconds);
      promClient.register.metrics()
        .then((metrics) => {
          processClient.publish(`${PREFIX}:prometheus:export`, JSON.stringify({
            type: `prometheus:export:${processName}`,
            data: {
              metrics,
              contentType: promClient.register.contentType
            }
          }));
        })
        .catch((err) => console.error('register.metrics() failed', err));
    }, config.prometheus.exportFreqSeconds * 1000);

    console.info(`Exporting Prometheus metrics every ${config.prometheus.exportFreqSeconds} seconds`);
  }

  const { Counter, Gauge, Histogram, Summary } = promClient;
  return { Counter, Gauge, Histogram, Summary };
};
