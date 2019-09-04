const { describe, it, afterEach } = require('mocha');
const assert = require('assert');
const { promisify, callbackify } = require('util');
const fs = require('fs');
const zlib = require('zlib');

const PgQuery = require('../lib/PgQuery');

/**
 * This test will attempt to connect to the PostgreSQL instance running on the localhost.
 */
describe('PostgreSQL Runner Tests', () => {
  const expectedHeaders = {
    'Content-Type': 'application/x-protobuf',
    'Content-Encoding': 'gzip',
  };

  const zxy = [8, 10, 23];
  const dummyTile = Buffer.from(zxy.join(''));
  const gzipedDummyTile = zlib.gzipSync(dummyTile);

  const POSTGRES_DB = process.env.POSTGRES_DB || 'openmaptiles';
  const POSTGRES_HOST = process.env.POSTGRES_HOST || 'localhost';
  const POSTGRES_PORT = process.env.POSTGRES_PORT || '5432';
  const POSTGRES_USER = process.env.POSTGRES_USER || 'openmaptiles';
  const POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD || 'openmaptiles';

  let QUERY;
  const isCustomQuery = !!process.env.POSTGRES_QUERY_FILE;
  if (isCustomQuery) {
    QUERY = fs.readFileSync(process.env.POSTGRES_QUERY_FILE, { encoding: 'utf8' });
  } else {
    QUERY = `SELECT '${dummyTile.toString()}'::bytea as v WHERE $1 >= 0 AND $2 >= 0 AND $3 >= 0`;
  }

  newRunner = null;

  afterEach(() => cleanup);

  it('registers null source', () => {
    const tilelive = { protocols: {} };
    PgQuery.registerProtocols(tilelive);
    assert.deepStrictEqual(tilelive, {
      protocols: {
        'pgquery:': tilelive.protocols['pgquery:'],
      },
    });
  });

  async function cleanup() {
    if (newRunner) {
      await newRunner.shutdownAsync();
      newRunner = null;
    }
  }

  async function newInstance() {
    cleanup();
    const creator = promisify((uri, callback) => new PgQuery(uri, callback));
    newRunner = await creator({
      query: {
        database: POSTGRES_DB,
        host: POSTGRES_HOST,
        port: POSTGRES_PORT,
        username: POSTGRES_USER,
        password: POSTGRES_PASSWORD,
        query: QUERY,
        testOnStartup: true,
      },
    });
    return newRunner;
  }

  it('getTile', async () => {
    const inst = await newInstance();

    return new Promise((acc, rej) => {
      inst.getTile(...zxy, (err, data, headers) => {
        if (err) {
          return rej(err);
        }
        assert.strictEqual(data instanceof Buffer, true, 'tile is a Buffer');
        assert.deepStrictEqual(data, isCustomQuery ? headers : gzipedDummyTile);
        assert.deepStrictEqual(headers, expectedHeaders);
        acc();
      });
    });
  });

  it('getTile should error out on invalid z/x/y', async () => {
    const inst = await newInstance();

    let test_invalid = (z, x, y) => new Promise((acc, rej) => {
      inst.getTile(z, x, y, (err, data, headers) => {
        if (err) {
          return acc();  // success
        }
        rej(new Error(`For (${z}, ${x}, ${y}) Should have errored out, but returned ${data} instead`));
      });
    });
    await test_invalid(0, 0, -1);
    await test_invalid(0, 0, 1);
    await test_invalid(2, 4, 0);
    await test_invalid(2, -1, 0);
  });

  it('returns something for getInfo()', async () => {
    const inst = await newInstance();
    const getInfo = promisify(inst.getInfo);

    const info = await getInfo.apply(inst);
    assert(info);
    assert.strictEqual(info.tilejson, '2.1.0');
    assert(info.name.startsWith('PgQuery '));
    assert.deepStrictEqual(info.bounds, [-180, -85.0511, 180, 85.0511]);
    assert.strictEqual(info.minzoom, 0);
    assert.strictEqual(info.maxzoom, 14);
  });

  it('multi-client', async () => {
    const inst = await newInstance();
    const getInfo = promisify(inst.getInfo);

    const info = await getInfo.apply(inst);
    assert(info);
    assert.strictEqual(info.tilejson, '2.1.0');
    assert(info.name.startsWith('PgQuery '));
    assert.deepStrictEqual(info.bounds, [-180, -85.0511, 180, 85.0511]);
    assert.strictEqual(info.minzoom, 0);
    assert.strictEqual(info.maxzoom, 14);
  });
});
