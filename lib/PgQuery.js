/*
 PgQuery executes PostgreSQL queries to generate tiles.
 */
const { promisify, callbackify } = require('util');
const fs = require('fs');
const { Pool } = require('pg');
const toBuffer = require('typedarray-to-buffer');
const checkType = require('@kartotherian/input-validator');
const gzipAsync = promisify(require('zlib').gzip);

const pckg = require('../package.json');

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
    this.checkHostPort(params, 'host');
    this.checkHostPort(params, 'port', '5432');
    checkType(params, 'maxpool', 'integer', 10, 1, 1000);
    checkType(params, 'minzoom', 'zoom', 0, 0, 22);
    checkType(params, 'maxzoom', 'zoom', 14, params.minzoom, 22);
    checkType(params, 'funcZXY', 'string');
    checkType(params, 'query', 'string');
    checkType(params, 'queryFile', 'string');
    // skip 'testOnStartup' string test
    // skip 'prepareStatement' string test

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
      max: params.maxpool,
    }));

    this.pgpools = clientOpts.map(v => ({
      pg: new Pool(v),
      pending: 0,
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
        (err) => callback(err),
      );
    } catch (err) {
      callback(err);
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
      throw new Error('Tile does not exist');
    }
    if (!this.validateXY(z, x, y)) {
      throw new Error(`Invalid (x,y) coordinates (${x}, ${y}) for zoom=${z}`);
    }

    if (pool === undefined) {
      // Find Postgres with the lowest number of pending requests
      for (let i=0; i<this.pgpools.length; i++) {
        if (!pool || pool.pending > this.pgpools[i].pending) {
          pool = this.pgpools[i];
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

    throw new Error('Tile does not exist');
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
          let parts = testOnStartup.split(',');
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
        console.log(`Verifying pgquery data source by retrieving ${info}...`);
        try {
          const result = await this._getTileAsync(...testTile, pool);
          console.log(`Test ${info} was generated in ${(new Date().getTime()) - start}ms and contains ${result.length} bytes (gzipped)`);
          return result;
        } catch (err) {
          console.log(`Failed to get ${info} (in ${(new Date().getTime()) - start}ms), aborting tilelive-pgquery initialization:\n${err}`);
          throw err;
        }
      };
      const results = await Promise.all(this.pgpools.map(tester));
      for (let i = 1; i < results.length; i++) {
        // if (results[0] instanceof Buffer && results[i] instanceof Buffer)
        // if (results[0] instanceof Buffer && results[i] instanceof Buffer)
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

  checkHostPort(params, name, defaultPort) {
    let value = params[name];
    if (value === undefined) {
      if (!defaultPort) {
        throw new Error(`Required parameter ${name} is not set`);
      }
      value = defaultPort;
    }
    if (!Array.isArray(value)) {
      // Convert single value in an array, repeating it N times
      value = Array(defaultPort ? params.host.length : 1).fill(value);
    }
    if (defaultPort && value.length !== params.host.length) {
      if (value.length === 1) {
        value = Array(params.host.length).fill(value[0]);
      } else if (params.host.length === 1) {
        params.host = Array(value.length).fill(params.host[0]);
      } else {
        throw new Error(`Count of 'host' and 'port' params must match, or given only once`);
      }
    }
    value = value.map((v) => {
      if (!v) {
        throw new Error(`Parameter ${name} has invalid value`);
      }
      v = v.toString();
      if ((defaultPort && !/^\d{1,5}$/.test(v)) || (!defaultPort && !/^([a-zA-Z0-9_-]+\.)*[a-zA-Z0-9_-]+$/.test(v))) {
        throw new Error(`Parameter ${name} has invalid value '${v}'`);
      }
      return v;
    });

    params[name] = value;
  }
};

module.exports.registerProtocols = (tilelive) => {
  tilelive.protocols['pgquery:'] = module.exports;
};
