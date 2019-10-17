/*
 PgQuery executes PostgreSQL queries to generate tiles.
 */
const { promisify, callbackify } = require('util');
const fs = require('fs');
const { Pool } = require('pg');
const toBuffer = require('typedarray-to-buffer');
const checkType = require('@kartotherian/input-validator');
const gzipAsync = promisify(require('zlib').gzip);
const dnsLookupAsync = promisify(require('dns').lookup);

const pckg = require('../package.json');

/**
 * Magical error message that must be spelled exactly to be understood.
 * @type {string}
 */
const tileDoesNotExist = 'Tile does not exist';

// If the parameter is given, treat empty, '0', and 'false' as a false, and everything else as true
function toBool(value) {
  if (!value) {
    return false;
  }
  const v = value.toString();
  return v !== '' && v !== '0' && v !== 'false';
}

module.exports = class PgQuery {
  constructor(uri, callback) {
    callbackify(() => this.init(uri))(callback);
  }

  async init(uri) {
    this.headers = {
      'Content-Type': 'application/x-protobuf',
      'Content-Encoding': 'gzip',
    };
    const params = checkType.normalizeUrl(uri).query;
    this._params = params;

    checkType(
      params, 'database', 'string', true,
      /^[a-zA-Z][_a-zA-Z0-9]*$/,
      'should be a letter followed by letters/digits/underscores'
    );
    this.checkMultiValue(params, 'host');
    this.checkMultiValue(params, 'port', 5432);
    this.checkMultiValue(params, 'maxpool', 10);
    checkType(params, 'minzoom', 'zoom', 0, 0, 22);
    checkType(params, 'maxzoom', 'zoom', 14, params.minzoom, 22);
    checkType(params, 'funcZXY', 'string');
    checkType(params, 'query', 'string');
    checkType(params, 'queryFile', 'string');
    checkType(params, 'resolveDns', 'boolean');
    // skip 'testOnStartup' string test
    // skip 'prepareStatement' string test

    if (params.resolveDns) {
      const hosts = [];
      const ports = [];
      const maxpools = [];
      for (let i = 0; i < params.host.length; i++) {
        const ips = await dnsLookupAsync(params.host[i], { all: true });
        for (let ip of ips) {
          hosts.push(ip.address);
          ports.push(params.port[i]);
          maxpools.push(params.maxpool[i]);
        }
      }
      params.host = hosts;
      params.port = ports;
      params.maxpool = maxpools;
    }

    function throw_on(val1, val2) {
      if (val1 || val2) {
        throw new Error("One of either 'query', 'queryFile', or 'funcZXY' params must be set, but no more than one");
      }
    }

    let prefer_prepared = false;
    if (params.funcZXY) {
      throw_on(params.query, params.queryFile);
      if (!/^[a-zA-Z_][a-zA-Z_0-9]{0,20}/.test(params.funcZXY)) {
        throw new Error("Parameter funcZXY is expected to be a valid SQL function name (letters/digits/underscores)");
      }
      params.query = `SELECT ${params.funcZXY}($1,$2,$3);`
    } else if (params.query) {
      throw_on(params.funcZXY, params.queryFile);
    } else if (params.queryFile) {
      throw_on(params.query, params.funcZXY);
      params.query = fs.readFileSync(params.queryFile, { encoding: 'utf8' });
      prefer_prepared = true;
    } else {
      throw_on(true)
    }

    params.prepareStatement = 'prepareStatement' in params ? toBool(params.prepareStatement) : prefer_prepared;

    // Pre-compute maximum allowed coordinate values
    this.maxCoords = [];
    for (let z = 0; z <= params.maxzoom; z++) {
      this.maxCoords.push(z >= params.minzoom ? Math.pow(2, z) : 0);
    }

    const clientOpts = params.host.map((_, ind) => ({
      database: params.database,
      host: params.host[ind],
      port: params.port[ind],
      user: params.username,
      password: params.password,

      // number of milliseconds to wait before timing out when connecting a new client
      // by default this is 0 which means no timeout
      connectionTimeoutMillis: 0,

      // number of milliseconds a client must sit idle in the pool and not be checked out
      // before it is disconnected from the backend and discarded
      // default is 10000 (10 seconds) - set to 0 to disable auto-disconnection of idle clients
      idleTimeoutMillis: 10000,

      // maximum number of clients the pool should contain
      // by default this is set to 10.
      max: params.maxpool[ind],
    }));

    const largestMaxpool = params.maxpool.reduce((a, b) => Math.max(a, b));
    this.pgpools = clientOpts.map(v => ({
      pg: new Pool(v),
      pending: 0,
      multiplier: largestMaxpool / v.max,
    }));

    this.getTileQueryObj = { text: params.query };
    if (params.prepareStatement) {
      this.getTileQueryObj.name = 'getTile';
    }

    await this.testOnStartupAsync(params.testOnStartup);

    return this;
  }

  shutdownAsync() {
    return Promise.all(this.pgpools.map(v => v.pg.end()));
  }

  getTile(z, x, y, callback) {
    try {
      this._getTileAsync(z, x, y).then(
        (v) => callback(null, v, this.headers),
        (err) => {
          callback(err);
          if (err.message !== tileDoesNotExist) {
            console.error(`Error getting ${z}/${x}/${y}: ${err}`);
          }
        },
      ).catch(
        (err) => {
          callback(err);
          console.error(`Nested crash ${z}/${x}/${y}: ${err}`);
        }
      ).catch(
        (err) => console.error(`Possible callback crash for ${z}/${x}/${y}: ${err}`)
      );
    } catch (err) {
      callback(err);
      if (err.message !== tileDoesNotExist) {
        console.error(`Top level catch for ${z}/${x}/${y}: ${err}`);
      }
    }
  }

  validateXY(z, x, y) {
    if (z < 0 || z >= this.maxCoords.length) {
      return false;
    }
    const maxCoord = this.maxCoords[z];
    return !(x < 0 || x >= maxCoord || y < 0 || y >= maxCoord);
  }

  async _getTileAsync(z, x, y, pool) {
    if (z < this._params.minzoom || z > this._params.maxzoom) {
      throw new Error(tileDoesNotExist);
    }
    if (!this.validateXY(z, x, y)) {
      throw new Error(`Invalid (x,y) coordinates (${x}, ${y}) for zoom=${z}`);
    }

    if (pool === undefined) {
      // Find Postgres with the lowest number of pending requests (adjust by the pool's multiplier)
      for (let i = 0; i < this.pgpools.length; i++) {
        const pl = this.pgpools[i];
        if (!pool || pl.multiplier * pl.pending < pool.multiplier * pool.pending) {
          pool = pl;
        }
      }
    }

    try {
      pool.pending++;
      const res = await pool.pg.query(this.getTileQueryObj, [z, x, y]);
      if (res.rows.length > 0) {
        if (res.rows.length > 1) {
          throw new Error(`Expected just one row, but got ${res.rows.length}`);
        }
        let row = res.rows[0];
        const columns = Object.keys(row);
        if (columns.length !== 1) {
          throw new Error(`Expected just one column, but got "${columns.join('", "')}"`);
        }
        let value = row[columns[0]];
        if (value && value.length !== 0) {
          // noinspection JSUnresolvedVariable
          if (!(value instanceof Buffer)) {
            // gzip does not handle typed buffers like Uint8Array
            value = toBuffer(value);
          }
          return gzipAsync(value);
        }
      }
    } finally {
      pool.pending--;
    }

    throw new Error(tileDoesNotExist);
  }

  getInfo(callback) {
    // Always use callbackify() just in case something throws an error
    callbackify(() => Promise.resolve({
      tilejson: '2.1.0',
      name: `PgQuery ${pckg.version}`,
      format: 'pbf',
      id: 'openmaptiles',
      attribution: '<a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap contributors</a>',
      bounds: [-180, -85.0511, 180, 85.0511],
      center: [-12.2168, 28.6135, 4],
      minzoom: this._params.minzoom,
      maxzoom: this._params.maxzoom,
      pixel_scale: '256',
      maskLevel: '8',
      planettime: '1555286400000',
      version: '3.9',
    }))(callback);
  }

  /**
   * Generate a single tile to see if the server is working.
   * @param testOnStartup if set, overrides which tile to test
   * @returns {Promise<void>}
   */
  async testOnStartupAsync(testOnStartup) {
    let testTile = [14, 9268, 3575];
    if (testOnStartup !== undefined) {
      if (!toBool(testOnStartup)) {
        testTile = false;
      } else {
        // must be either z/x/y or z,x,y format
        let parts = testOnStartup.split('/');
        if (parts.length === 1) {
          parts = testOnStartup.split(',');
        }
        if (parts.length !== 3) {
          throw new Error(`Unable to parse testOnStartup param. It can be "false", or the z/x/y index of a test tile`);
        }
        const [z, x, y] = parts.map(parseInt);
        if (!this.validateXY(z, x, y)) {
          throw new Error(`Invalid test tile [${z} / ${x} / ${y}]`);
        }
        testTile = [z, x, y];
      }
    }

    if (testTile) {
      const tester = async (pool) => {
        const start = new Date().getTime();
        const info = `a tile at [${testTile}] from ${pool.pg.options.host}:${pool.pg.options.port}`;
        console.error(`Verifying pgquery data source by retrieving ${info}...`);
        try {
          const result = await this._getTileAsync(...testTile, pool);
          console.error(`${info} was generated in ${(new Date().getTime()) - start}ms and contains ${result.length} bytes (gzipped)`);
          return result;
        } catch (err) {
          console.error(`Failed to get ${info} (in ${(new Date().getTime()) - start}ms), aborting tilelive-pgquery initialization:\n${err}`);
          throw err;
        }
      };
      const results = await Promise.all(this.pgpools.map(tester));
      for (let i = 1; i < results.length; i++) {
        const equal = results[0] && results[0].compare instanceof Function && results[i]
          ? results[0].compare(results[i]) === 0
          : results[0] === results[i];
        if (!equal) {
          const opt1 = this.pgpools[0].pg.options;
          const opt2 = this.pgpools[i].pg.options;
          throw new Error(`Result from ${opt1.host}:${opt1.port} do not match results from ${opt2.host}${opt2.port}`);
        }
      }
    }
  }

  /**
   * Validate multiple hosts, or multiple corresponding values (port, ...)
   * @param params all parameters
   * @param name name of the current param, e.g. host, port, ...
   * @param defaultValue integer default value for the non-host params
   */
  checkMultiValue(params, name, defaultValue) {
    let value = params[name];
    if (value === undefined) {
      if (!defaultValue) {
        throw new Error(`Required parameter ${name} is not set`);
      }
      value = defaultValue;
    }
    if (!Array.isArray(value)) {
      // Convert single value in an array, repeating it N times
      value = Array(defaultValue ? params.host.length : 1).fill(value);
    }
    if (defaultValue && value.length !== params.host.length) {
      if (value.length === 1) {
        value = Array(params.host.length).fill(value[0]);
      } else {
        throw new Error(`You must provide as many ${name} values as there are hosts (${params.host.length}), or just one`);
      }
    }
    value = value.map((v) => {
      if (!v) {
        throw new Error(`Parameter ${name} has invalid value`);
      }
      v = v.toString();
      if ((defaultValue && !/^\d{1,5}$/.test(v)) || (!defaultValue && !/^([a-zA-Z0-9_-]+\.)*[a-zA-Z0-9_-]+$/.test(v))) {
        throw new Error(`Parameter ${name} has invalid value '${v}'`);
      }
      return defaultValue ? parseInt(v) : v;
    });

    params[name] = value;
  }
};

module.exports.registerProtocols = (tilelive) => {
  tilelive.protocols['pgquery:'] = module.exports;
};
