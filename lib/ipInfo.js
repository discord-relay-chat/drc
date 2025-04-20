'use strict';

const config = require('config');
const { fetch } = require('undici');
const dns = require('dns').promises;
const fs = require('fs').promises;
const path = require('path');
const { Reader } = require('@maxmind/geoip2-node');

const GEOLITE_DB_URL = 'https://git.io/GeoLite2-City.mmdb';
const DB_PATH = path.join(__dirname, '..', 'data', 'GeoLite2-City.mmdb');
let geoipReader = null;

function isIpAddress (ip) {
  return ip?.match(/^(?:\d{1,3}\.){3}\d{1,3}$/) !== null;
}

async function getGeoipReader () {
  if (geoipReader) return geoipReader;

  try {
    // Check if DB directory exists, create if not
    try {
      await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }

    // Check if DB file exists
    try {
      await fs.access(DB_PATH);
    } catch (err) {
      // Download the DB if it doesn't exist
      console.log('Downloading GeoLite2 City database...');
      const response = await fetch(GEOLITE_DB_URL);

      if (!response.ok) {
        throw new Error(`Failed to download GeoIP database: ${response.status}`);
      }

      const buffer = await response.arrayBuffer();
      await fs.writeFile(DB_PATH, Buffer.from(buffer));
      console.log('GeoLite2 City database downloaded successfully');
    }

    // Load the database
    const dbBuffer = await fs.readFile(DB_PATH);
    geoipReader = Reader.openBuffer(dbBuffer);
    return geoipReader;
  } catch (err) {
    console.error('Error loading GeoIP database:', err.message);
    return null;
  }
}

async function getGeoipData (ip) {
  try {
    const reader = await getGeoipReader();
    if (!reader) return null;

    const result = reader.city(ip);
    const returnObj = {
      geoId: result.city?.geonameId
    };

    // Check if traits property exists and has boolean values
    if (result.traits) {
      const trueTraits = Object.keys(result.traits).filter(key =>
        result.traits[key] === true
      );

      if (trueTraits.length > 0) {
        returnObj.trueTraits = trueTraits;
      }
    }

    return returnObj;
  } catch (err) {
    console.warn(`GeoIP lookup for "${ip}" failed: ${err.message}`);
    return null;
  }
}

async function ipInfo (ipOrHost) {
  if (!config.ipinfo.token) {
    return null;
  }

  let ip = ipOrHost;
  if (!isIpAddress(ip)) {
    try {
      ip = (await dns.lookup(ipOrHost)).address;
    } catch (err) {
      console.warn(`Lookup for "${ip} failed: ${err.message}`);
      return null;
    }
  }

  // Get data from ipinfo.io
  const res = await fetch(`https://ipinfo.io/${ip}`, {
    headers: {
      Authorization: `Bearer ${config.ipinfo.token}`
    }
  });

  if (!res.ok) {
    console.warn(`ipinfo.io lookup for "${ip}" failed (${res.status})`, res);
    return null;
  }

  const ipinfoData = await res.json();

  // Get GeoIP data and merge it
  const geoipData = await getGeoipData(ip);

  return {
    ...ipinfoData,
    ...(geoipData || {})
  };
}

module.exports = { ipInfo };
