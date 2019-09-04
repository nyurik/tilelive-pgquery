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
    checkType(params, 'host', 'string', true);
    checkType(params, 'port', 'integer');
    checkType(params, 'maxpool', 'integer', 10, 1, 1000);
    checkType(params, 'minzoom', 'zoom', 0, 0, 22);
    checkType(params, 'maxzoom', 'zoom', 14, params.minzoom, 22);
    checkType(params, 'maxBatchSize', 'integer');
    checkType(params, 'query', 'string');
    checkType(params, 'queryFile', 'string');
    checkType(params, 'testOnStartup', 'boolean');

    if (!params.query === !params.queryFile) {
      throw new Error('Must either set query or queryFile param, but not both');
    }
    if (params.queryFile) {
      params.query = fs.readFileSync(params.queryFile, { encoding: 'utf8' });
    }

    // Pre-compute maximum allowed coordinate values
    this.maxCoords = [];
    for(let z=0; z<=params.maxzoom; z++) {
      this.maxCoords.push(z >= params.minzoom ? Math.pow(2, z) : 0);
    }

    const clientOpts = {
      database: params.database,
      host: params.host,
      port: params.port,
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
    };

    this.client = new Pool(clientOpts);

    this.getTilePS = {
      name: 'getTile',
      text: params.query,
    };

    if (params.testOnStartup) {
      await this.client.query(this.getTilePS, [10, 513, 511]);
    }

    return this;
  }

  shutdownAsync() {
    return this.client.end();
  }

  getTile(z, x, y, callback) {
    try {
      this._getTileAsync(z, x, y).then(
        (v) => callback(null, v, this.headers),
        callback,
      );
    } catch (err) {
      callback(err);
    }
  }

  async _getTileAsync(z, x, y) {
    if (z < this._params.minzoom || z > this._params.maxzoom) {
      throw new Error('Tile does not exist');
    }
    const maxCoord = this.maxCoords[z];
    if (x < 0 || x >= maxCoord || y < 0 || y >= maxCoord) {
      throw new Error(`Invalid (x,y) coordinates (${x}, ${y}) for zoom=${z}`);
    }

    const res = await this.client.query(this.getTilePS, [z, x, y]);
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

};

module.exports.registerProtocols = (tilelive) => {
  tilelive.protocols['pgquery:'] = module.exports;
};
