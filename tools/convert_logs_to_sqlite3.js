const fs = require('fs').promises;
const path = require('path');
const readline = require('readline');
const sqlite3 = require('sqlite3');
const config = require('config');

require('../logger')();

const initDb = async (path) => {
  return new Promise((resolve) => {
    const db = new sqlite3.Database(path);
    db.run('CREATE TABLE channel (type TEXT, from_server INTEGER, nick TEXT, ' +
    'ident TEXT, hostname TEXT, target TEXT, message TEXT, __drcNetwork TEXT, ' +
    '__drcIrcRxTs INTEGER, __drcLogTs INTEGER, tags TEXT, extra TEXT)',
    () => resolve(db));
  });
};

const insertOne = (db, parsed, resolve, reject) => {
  db.run('INSERT INTO channel VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    parsed.type, parsed.from_server ? 1 : 0, parsed.nick, parsed.ident, parsed.hostname,
    parsed.target, parsed.message, parsed.__drcNetwork, parsed?.__drcIrcRxTs ?? -1,
    parsed?.__drcLogTs ?? -1, JSON.stringify(parsed.tags), null, (err) => {
      if (err) {
        return reject(err);
      }
      resolve(parsed);
    });
};

const LogType = Object.freeze({
  channel: {
    matcher: (s) => s.startsWith('#'),
    initDb,
    insertOne
  },
  user: {
    matcher: (s, d) => s.match(/^\w/) && !d.endsWith('event'),
    initDb,
    insertOne
  },
  notice: {
    matcher: (s) => s.startsWith('$'),
    initDb,
    insertOne
  },
  server: {
    matcher: (s) => s.startsWith('*'),
    initDb,
    insertOne
  },
  event: {
    matcher: (s, d) => d.endsWith('event')
  }
});

async function findLogs (rootPath) {
  let retList = [];
  const files = await fs.readdir(rootPath, { withFileTypes: true });

  for (const dirent of files) {
    const resolved = path.resolve(rootPath, dirent.name);

    if (dirent.isDirectory()) {
      retList = [...retList, ...(await findLogs(resolved))];
    } else {
      const parsed = path.parse(resolved);

      if (parsed.ext.match(/.*(?:sqlite3|log).*/g)) {
        continue;
      }

      let type;

      for (const [t, { matcher }] of Object.entries(LogType)) {
        if (matcher(parsed.name, parsed.dir)) {
          type = t;
          break;
        }
      }

      retList.push({
        path: {
          resolved,
          parsed
        },
        type
      });
    }
  }

  return retList;
}

async function insertOneLine (db, type, parsed) {
  const inserter = LogType[type]?.insertOne;
  if (!inserter) {
    console.error('no inserter for', type);
    process.exit(-1);
  }

  return new Promise((resolve, reject) => {
    inserter(db, parsed, resolve, reject);
  });
}

async function processOne (db, type, parsed, resolved) {
  let lineCount = 0; let successCount = 0; let failCount = 0;
  const rl = readline.createInterface(await (await fs.open(resolved)).createReadStream());

  for await (let d of rl) {
    ++lineCount;
    try {
      if (d.startsWith('"') && d.endsWith('"')) {
        console.log('FOUND ONE', d, d.slice(1, -1));
        d = d.slice(1, -1);
      }

      await insertOneLine(db, type, JSON.parse(d));
      ++successCount;
    } catch (e) {
      ++failCount;
      console.error(`${resolved}:${lineCount}> failed to parse:\n${d}\n`, e);
    }
  }

  return new Promise((resolve, reject) => {
    db.close((err) => {
      if (err) {
        console.error(`Failed to close DB: ${err}`);
        return reject(err);
      }

      resolve({ resolved, lineCount, successCount, failCount, parsed });
    });
  });
}

async function main () {
  const logsPath = path.resolve(config.irc.log.path);
  console.log(`Looking for logs in ${logsPath}...`);
  const logs = await findLogs(logsPath);
  const typeCounts = Object.entries(LogType).reduce((a, [t]) => ({ [t]: 0, ...a }), {});
  for (const { type } of logs) {
    typeCounts[type]++;
  }
  console.log(typeCounts);

  for (const { path: { parsed, resolved }, type } of logs) {
    if (type === 'event') { // TODO: figure out events; they're all different shapes :(
      continue;
    }

    const dbPath = path.resolve(path.join(parsed.dir, parsed.name + '.sqlite3'));

    try {
      await fs.stat(dbPath);
      await fs.rm(dbPath);
    } catch {}

    const db = await LogType[type].initDb?.(dbPath);

    console.log(`Processing ${type} ${dbPath}...`);
    const { successCount, failCount } = await processOne(db, type, parsed, resolved);
    console.log(`Processed ${successCount} lines into ${dbPath}${failCount > 0 ? ` -- ${failCount} FAILURES` : ''}`);
  }
}

(async () => {
  await main();
})();
