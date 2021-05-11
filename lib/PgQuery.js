// noinspection JSUnresolvedVariable
// noinspection JSUnresolvedFunction
/*
 PgQuery executes PostgreSQL queries to generate tiles.
 */
/* eslint-disable no-param-reassign,no-console */
const { promisify, callbackify } = require('util');
const fs = require('fs');
const { Pool } = require('pg');
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
    // Performance optimization - there will be a lot of these errors
    this.noTileError = new Error(tileDoesNotExist);
    const params = checkType.normalizeUrl(uri).query;
    this._params = params;

    const envVars = [];

    const useEnvParam = (name, env) => {
      if (params[name] === undefined && process.env[env] !== undefined) {
        params[name] = process.env[env];
        envVars.push(env);
      }
    };

    useEnvParam('database', 'PGDATABASE');
    useEnvParam('host', 'PGHOST');
    useEnvParam('port', 'PGPORT');
    useEnvParam('username', 'PGUSER');
    useEnvParam('password', 'PGPASSWORD');
    if (envVars.length > 0) {
      console.error(`PostgreSQL connection was configured from ${envVars.join(', ')}`);
    }

    checkType(
      params, 'database', 'string', true,
      /^[a-zA-Z][_a-zA-Z0-9]*$/,
      'should be a letter followed by letters/digits/underscores'
    );
    PgQuery.checkMultiValue(params, 'host');
    PgQuery.checkMultiValue(params, 'port', 5432);
    PgQuery.checkMultiValue(params, 'maxpool', 10);
    checkType(params, 'username', 'string');
    checkType(params, 'password', 'string');
    checkType(params, 'minzoom', 'zoom', 0, 0, 22);
    checkType(params, 'maxzoom', 'zoom', 14, params.minzoom, 22);
    checkType(params, 'funcZXY', 'string');
    checkType(params, 'query', 'string');
    checkType(params, 'queryFile', 'string');
    checkType(params, 'resolveDns', 'boolean');
    checkType(params, 'errorsAsEmpty', 'boolean');
    checkType(params, 'connectionInitQuery', 'string');
    checkType(params, 'name', 'string');
    checkType(params, 'key', 'boolean');
    checkType(params, 'nogzip', 'boolean');
    checkType(params, 'contentType', 'string', 'application/x-protobuf');
    checkType(params, 'contentEncoding', 'string', 'gzip');
    // skip testOnStartup, prepareStatement, and serverInfo tests - handled later

    this.useKeyColumn = params.key;
    this.gzip = !params.nogzip;
    this.headers = {
      'Content-Type': this._params.contentType,
      'Content-Encoding': this._params.contentEncoding,
    };

    // Pre-compute maximum allowed coordinate values
    this.maxCoords = [];
    for (let z = 0; z <= params.maxzoom; z++) {
      this.maxCoords.push(z >= params.minzoom ? 2 ** z : 0);
    }

    await PgQuery.resolveDns(params);
    this.prepareQuery(params);
    this.pgpools = PgQuery.createPgPool(params);

    await this.printServerInfo(params.serverInfo);
    await this.testOnStartupAsync(params.testOnStartup);

    // set value after testing to prevent errorAsEmpty
    this.errorsAsEmpty = this._params.errorsAsEmpty;

    return this;
  }

  static createPgPool(params) {
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

    // Find largest value for maxpool to compute a multiplier for the smaller pools
    const largestMaxpool = params.maxpool.reduce((a, b) => Math.max(a, b));

    return clientOpts.map((v) => {
      const pool = new Pool(v);
      if (params.connectionInitQuery) {
        pool.on('connect', client => client.query(params.connectionInitQuery));
      }
      return {
        pg: pool,
        pending: 0,
        multiplier: largestMaxpool / v.max,
      };
    });
  }

  static async resolveDns(params) {
    if (params.resolveDns) {
      const hosts = [];
      const ports = [];
      const maxPools = [];
      await Promise.all(params.host.map(async (host, index) => {
        const ips = await dnsLookupAsync(host, { all: true });
        for (const ip of ips) {
          hosts.push(ip.address);
          ports.push(params.port[index]);
          maxPools.push(params.maxpool[index]);
        }
      }));
      params.host = hosts;
      params.port = ports;
      params.maxpool = maxPools;
    }
  }

  shutdownAsync() {
    return Promise.all(this.pgpools.map(v => v.pg.end()));
  }

  getTile(z, x, y, callback) {
    try {
      this._getTileAsync(z, x, y).then(
        v => callback(null, v, this.headers),
        (err) => {
          callback(err);
          if (err.message !== tileDoesNotExist) {
            console.error(`Error getting ${z}/${x}/${y}: ${err}`);
          }
        }
      ).catch((err) => {
        callback(err);
        console.error(`Nested crash ${z}/${x}/${y}: ${err}`);
      }).catch((err) => {
        console.error(`Possible callback crash for ${z}/${x}/${y}: ${err}`);
      });
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

    let _pool = pool;
    if (_pool === undefined) {
      // Find Postgres with the lowest number of pending requests (adjust by the pool's multiplier)
      for (let i = 0; i < this.pgpools.length; i++) {
        const pl = this.pgpools[i];
        if (!_pool || pl.multiplier * pl.pending < _pool.multiplier * _pool.pending) {
          _pool = pl;
        }
      }
    }

    let res;
    try {
      _pool.pending++;
      const query = this.getTileQueryObj.name
        ? this.getTileQueryObj
        : { text: `/* ${+z}/${+x}/${+y} */ ${this.getTileQueryObj.text}`, rowMode: 'array' };
      res = await _pool.pg.query(query, [z, x, y]);
    } catch (err) {
      if (this.errorsAsEmpty) {
        console.error(`Ignoring error ${z}/${x}/${y}: ${err}`);
        throw this.noTileError;
      }
      throw err;
    } finally {
      _pool.pending--;
    }

    if (res.rows.length > 0) {
      if (res.rows.length > 1) {
        throw new Error(`Expected just one row, but got ${res.rows.length}`);
      }
      const row = res.rows[0];
      if (row.length !== (this.useKeyColumn ? 2 : 1)) {
        throw new Error(`Expected ${this.useKeyColumn ? '2 columns' : '1 column'}, but got ${row.length}.`);
      }
      let value = row[0];
      if (value && value.length !== 0) {
        if (this.gzip) {
          value = gzipAsync(value);
          if (this.useKeyColumn) {
            // need to await gzip so that the key property is attached to the right object
            value = await value;
          }
        }
        if (this.useKeyColumn) {
          // some tilelive plugins like mbtiles understand key property, avoids recalculation
          // eslint-disable-next-line prefer-destructuring
          value.key = row[1];
        }
        return value;
      }
    }

    throw this.noTileError;
  }

  getInfo(callback) {
    // Always use callbackify() just in case something throws an error
    callbackify(() => Promise.resolve({
      tilejson: '2.1.0',
      name: `${this._params.name ? `${this._params.name}, ` : ''}PgQuery ${pckg.version}`,
      format: 'pbf',
      id: 'openmaptiles',
      attribution: '<a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap contributors</a>',
      bounds: [-180, -85.0511, 180, 85.0511],
      center: [-12.2168, 28.6135, 4],
      minzoom: this._params.minzoom,
      maxzoom: this._params.maxzoom,
      pixel_scale: '256',
      maskLevel: '8',
      version: '3.9',
    }))(callback);
  }

  /**
   * Print this package, Postgres and Postgis version information
   * @returns {Promise<void>}
   */
  async printServerInfo(serverInfo) {
    if (serverInfo === undefined || toBool(serverInfo)) {
      // noinspection JSUnusedGlobalSymbols
      const pgSettings = {
        'version()': false,
        'postgis_full_version()': false,
        jit: v => (v !== 'off' ? ' WARNING: disable JIT in PG 11-12 for complex queries' : ''),
        shared_buffers: false,
        work_mem: false,
        maintenance_work_mem: false,
        effective_cache_size: false,
        effective_io_concurrency: false,
        max_connections: false,
        max_worker_processes: false,
        max_parallel_workers: false,
        max_parallel_workers_per_gather: false,
        wal_buffers: false,
        min_wal_size: false,
        max_wal_size: false,
        random_page_cost: false,
        default_statistics_target: false,
        checkpoint_completion_target: false,
      };

      const versionGetter = async (pool) => {
        let info = `Server information for ${pool.pg.options.host}:${pool.pg.options.port}:\n`;

        await Promise.all(Object.keys(pgSettings).map(async (setting) => {
          let value;
          try {
            const res = await pool.pg.query({
              text: `${setting.includes('(') ? 'SELECT' : 'SHOW'} ${setting};`,
              rowMode: 'array',
            });
            value = res.rows[0][0].toString();
            if (pgSettings[setting]) {
              value += pgSettings[setting](value);
            }
          } catch (err) {
            value = err.message;
          }
          info += `  ${setting.padStart(24)} = ${value}\n`;
        }));
        console.error(info);
      };
      console.error(`tilelive-pgquery v${pckg.version}`);
      await Promise.all(this.pgpools.map(versionGetter));
    }
  }

  parseTestOnStartup(testOnStartup) {
    let result = [14, 9268, 3575];
    if (testOnStartup !== undefined) {
      if (!toBool(testOnStartup)) {
        result = false;
      } else {
        // must be either z/x/y or z,x,y format
        let parts = testOnStartup.split('/');
        if (parts.length === 1) {
          parts = testOnStartup.split(',');
        }
        if (parts.length !== 3) {
          throw new Error('Unable to parse testOnStartup param. It can be "false", or the z/x/y index of a test tile');
        }
        const [z, x, y] = parts.map(v => parseInt(v, 10));
        if (!this.validateXY(z, x, y)) {
          throw new Error(`Invalid test tile [${z} / ${x} / ${y}]`);
        }
        result = [z, x, y];
      }
    }
    return result;
  }

  /**
   * Generate a single tile to see if the server is working.
   * @param testOnStartup if set, overrides which tile to test
   * @returns {Promise<void>}
   */
  async testOnStartupAsync(testOnStartup) {
    const testTile = this.parseTestOnStartup(testOnStartup);
    if (!testTile) {
      return;
    }
    const tester = async (pool) => {
      const start = new Date().getTime();
      const info = `a tile at [${testTile}] from ${pool.pg.options.host}:${pool.pg.options.port}`;
      console.error(`Verifying pgquery data source by retrieving ${info}...`);
      try {
        const result = await this._getTileAsync(...testTile, pool);
        console.error(`${info} was generated in ${(new Date().getTime()) - start}ms and ` +
          `contains ${result.length} bytes (${this.gzip ? 'raw' : 'gzipped'})`);
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

  /**
   * Validate multiple hosts, or multiple corresponding values (port, ...)
   * @param params all parameters. param[name] will be updated in-place
   * @param name name of the current param, e.g. host, port, ...
   * @param defaultValue integer default value for the non-host params
   */
  static checkMultiValue(params, name, defaultValue) {
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
      const result = v.toString();
      if ((defaultValue && !/^\d{1,5}$/.test(result)) || (!defaultValue && !/^([a-zA-Z0-9_-]+\.)*[a-zA-Z0-9_-]+$/.test(result))) {
        throw new Error(`Parameter ${name} has invalid value '${result}'`);
      }
      return defaultValue ? parseInt(result, 10) : result;
    });

    params[name] = value;
  }

  prepareQuery(params) {
    const throwOn = (val1, val2) => {
      if (val1 || val2) {
        throw new Error("One of either 'query', 'queryFile', or 'funcZXY' params must be set, but no more than one");
      }
    };

    let preferPrepared = false;
    if (params.funcZXY) {
      throwOn(params.query, params.queryFile);
      if (!/^[a-zA-Z_][a-zA-Z_0-9]{0,20}/.test(params.funcZXY)) {
        throw new Error('Parameter funcZXY is expected to be a valid SQL function name (letters/digits/underscores)');
      }
      params.query = `${this.useKeyColumn ? 'SELECT * FROM' : 'SELECT'} ${params.funcZXY}($1,$2,$3);`;
    } else if (params.query) {
      throwOn(params.funcZXY, params.queryFile);
    } else if (params.queryFile) {
      throwOn(params.query, params.funcZXY);
      params.query = fs.readFileSync(params.queryFile, { encoding: 'utf8' });
      preferPrepared = true;
    } else {
      throwOn(true);
    }

    params.prepareStatement = 'prepareStatement' in params ? toBool(params.prepareStatement) : preferPrepared;

    this.getTileQueryObj = { text: params.query, rowMode: 'array' };
    if (params.prepareStatement) {
      this.getTileQueryObj.name = 'getTile';
    }
  }
};

module.exports.registerProtocols = (tilelive) => {
  tilelive.protocols['pgquery:'] = module.exports;
};
