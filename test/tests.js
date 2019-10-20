const { describe, it, afterEach } = require('mocha');
const assert = require('assert');
const { promisify } = require('util');
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
  const POSTGRES_PORT2 = process.env.POSTGRES_PORT2 || '5433';
  const POSTGRES_USER = process.env.POSTGRES_USER || 'openmaptiles';
  const POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD || 'openmaptiles';

  let QUERY;
  const isCustomQuery = !!process.env.POSTGRES_QUERY_FILE;
  if (isCustomQuery) {
    QUERY = fs.readFileSync(process.env.POSTGRES_QUERY_FILE, { encoding: 'utf8' });
  } else {
    QUERY = `SELECT '${dummyTile.toString()}'::bytea as v WHERE $1 >= 0 AND $2 >= 0 AND $3 >= 0`;
  }

  const QUERY_ERR = `SELECT 0::bytea as v WHERE $1 >= 0 AND $2 >= 0 AND $3 >= 0`;

  let newRunner = null;

  afterEach(() => cleanup);

  async function cleanup() {
    if (newRunner) {
      await newRunner.shutdownAsync();
      newRunner = null;
    }
  }

  function newInstance(query, ...extraParams) {
    cleanup();
    const creator = promisify((uri, callback) => new PgQuery(uri, callback));
    const queryObj = new URLSearchParams({
      database: POSTGRES_DB,
      host: POSTGRES_HOST,
      port: POSTGRES_PORT,
      username: POSTGRES_USER,
      password: POSTGRES_PASSWORD,
      query: query || QUERY,
    });
    if (extraParams) {
      for (const v of extraParams) {
        queryObj.append(v[0], v[1])
      }
    }
    return creator(`pgquery://?${queryObj}`);
  }

  it('registers null source', () => {
    const tilelive = { protocols: {} };
    PgQuery.registerProtocols(tilelive);
    assert.deepStrictEqual(tilelive, {
      protocols: {
        'pgquery:': tilelive.protocols['pgquery:'],
      },
    });
  });

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
      inst.getTile(z, x, y, (err, data) => {
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

  it('getTile should properly handle query errors', async () => {
    const inst = await newInstance(QUERY_ERR, ['testOnStartup', '']);

    let test_invalid = (z, x, y) => new Promise((acc, rej) => {
      inst.getTile(z, x, y, (err, data) => {
        if (err) {
          return acc();  // success
        }
        rej(new Error(`Query should have failed, but returned ${data} instead`));
      });
    });
    await test_invalid(0, 0, 0);
  });

  it('properly handle query error on init', async () => {
    function test_init_fail(uri) {
      return new Promise((acc, rej) => {
        new PgQuery(uri, (err) => {
          if (err) {
            acc();
          } else {
            rej(new Error(`Initialization should have failed`));
          }
        });
      });
    }

    await test_init_fail();
    await test_init_fail({});
    await test_init_fail({ query: {} });
    await test_init_fail({ query: {} });
    await test_init_fail({
      query: {
        database: POSTGRES_DB,
        host: POSTGRES_HOST,
        port: POSTGRES_PORT,
        username: POSTGRES_USER,
        password: POSTGRES_PASSWORD,
        query: QUERY_ERR,
      }
    });
  });

  // noinspection DuplicatedCode
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

  // noinspection DuplicatedCode
  it('multi-client', async () => {
    const inst = await newInstance(false,
      ['host', POSTGRES_HOST], ['port', POSTGRES_PORT2]);

    // FIXME: TODO proper testing for multiple connections
  });

  it('resolveDns', async () => {
    await newInstance(false, ['resolveDns', true]);
  });

  it('initQuery', async () => {
    await newInstance(false, ['initQuery', "SELECT 'CURRENT DB = ' || current_database();"]);
  });

});
