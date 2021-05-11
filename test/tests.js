const { describe, it, afterEach } = require('mocha');
const assert = require('assert');
const { promisify } = require('util');
const zlib = require('zlib');

const PgQuery = require('../lib/PgQuery');

/**
 * This test will attempt to connect to the PostgreSQL instance running on the localhost.
 */
describe('PostgreSQL Runner Tests', () => {
  const zxy = [8, 10, 23];
  const dummyTile = Buffer.from(zxy.join(''));
  const PGDATABASE = process.env.PGDATABASE || 'openmaptiles';
  const PGHOST = process.env.PGHOST || 'localhost';
  const PGPORT = process.env.PGPORT || '5432';
  const PGPORT2 = process.env.PGPORT2 || '5433';
  const PGUSER = process.env.PGUSER || 'openmaptiles';
  const PGPASSWORD = process.env.PGPASSWORD || 'openmaptiles';

  const MD5 = 'a8372432b76f55afb7c8b2e820137b30';
  const QUERY = `SELECT '${dummyTile.toString()}'::bytea as v WHERE $1 >= 0 AND $2 >= 0 AND $3 >= 0`;
  // eslint-disable-next-line max-len
  // const QUERY_TEXT = `SELECT '${dummyTile.toString()}'::text as v WHERE $1 >= 0 AND $2 >= 0 AND $3 >= 0`;
  const QUERY_KEY = `SELECT '${dummyTile.toString()}'::bytea as v, '${MD5}' as k WHERE $1 >= 0 AND $2 >= 0 AND $3 >= 0`;
  const QUERY_ERR = 'SELECT 0::bytea as v WHERE $1 >= 0 AND $2 >= 0 AND $3 >= 0';

  let newRunner = null;

  async function cleanup() {
    if (newRunner) {
      await newRunner.shutdownAsync();
      newRunner = null;
    }
  }

  afterEach(() => cleanup);

  async function newInstance(query, ...extraParams) {
    await cleanup();
    const creator = promisify((uri, callback) => new PgQuery(uri, callback));
    const queryObj = new URLSearchParams({
      database: PGDATABASE,
      host: PGHOST,
      port: PGPORT,
      username: PGUSER,
      password: PGPASSWORD,
      query: query || QUERY,
      serverInfo: false,
    });
    if (extraParams) {
      for (const v of extraParams) {
        queryObj.append(v[0], v[1]);
      }
    }
    newRunner = await creator(`pgquery://?${queryObj}`);
    return newRunner;
  }

  it('registers source', () => {
    const tilelive = { protocols: {} };
    PgQuery.registerProtocols(tilelive);
    assert.deepStrictEqual(tilelive, {
      protocols: {
        'pgquery:': tilelive.protocols['pgquery:'],
      },
    });
  });

  it('server info', async () => {
    await newInstance(QUERY, {serverInfo: true});
  });

  it('getTile', async () => {
    const inst = await newInstance();

    return new Promise((acc, rej) => {
      inst.getTile(...zxy, (err, data, headers) => {
        if (err) {
          rej(err);
        } else {
          assert.strictEqual(data.constructor.name, 'Buffer');
          assert.deepStrictEqual(data, zlib.gzipSync(dummyTile));
          assert.deepStrictEqual(headers, {
            'Content-Type': 'application/x-protobuf',
            'Content-Encoding': 'gzip',
          });
          acc();
        }
      });
    });
  });

  it('getTile nogzip', async () => {
    const inst = await newInstance(QUERY, ['nogzip', '1']);

    return new Promise((acc, rej) => {
      inst.getTile(...zxy, (err, data, headers) => {
        if (err) {
          rej(err);
        } else {
          assert.strictEqual(data.constructor.name, 'Buffer');
          assert.deepStrictEqual(data, dummyTile);
          assert.deepStrictEqual(headers, {
            'Content-Type': 'application/x-protobuf',
            'Content-Encoding': 'gzip',
          });
          acc();
        }
      });
    });
  });

  it('custom headers', async () => {
    const inst = await newInstance(QUERY, ['contentType', 'mycontent'], ['contentEncoding', 'myencoding']);

    return new Promise((acc, rej) => {
      inst.getTile(...zxy, (err, data, headers) => {
        if (err) {
          rej(err);
        } else {
          assert.strictEqual(data.constructor.name, 'Buffer');
          assert.deepStrictEqual(data, zlib.gzipSync(dummyTile));
          assert.deepStrictEqual(headers, {
            'Content-Type': 'mycontent',
            'Content-Encoding': 'myencoding',
          });
          acc();
        }
      });
    });
  });

  it('getTile with key', async () => {
    const inst = await newInstance(QUERY_KEY, ['key', '1']);

    return new Promise((acc, rej) => {
      inst.getTile(...zxy, (err, data, headers) => {
        if (err) {
          rej(err);
        } else {
          assert.strictEqual(data.constructor.name, 'Buffer');
          const expected = zlib.gzipSync(dummyTile);
          expected.key = MD5;
          assert.deepStrictEqual(data, expected);
          assert.deepStrictEqual(headers, {
            'Content-Type': 'application/x-protobuf',
            'Content-Encoding': 'gzip',
          });
          acc();
        }
      });
    });
  });

  it('getTile should error out on invalid z/x/y', async () => {
    const inst = await newInstance();

    const testInvalid = (z, x, y) => new Promise((acc, rej) => {
      inst.getTile(z, x, y, (err, data) => {
        if (err) {
          acc(); // success
        } else {
          rej(new Error(`For (${z}, ${x}, ${y}) Should have errored out, but returned ${data} instead`));
        }
      });
    });
    await testInvalid(0, 0, -1);
    await testInvalid(0, 0, 1);
    await testInvalid(2, 4, 0);
    await testInvalid(2, -1, 0);
  });

  it('getTile should properly handle query errors', async () => {
    const inst = await newInstance(QUERY_ERR, ['testOnStartup', '']);

    const testInvalid = (z, x, y) => new Promise((acc, rej) => {
      inst.getTile(z, x, y, (err, data) => {
        if (err) {
          acc(); // success
        } else {
          rej(new Error(`Query should have failed, but returned ${data} instead`));
        }
      });
    });
    await testInvalid(0, 0, 0);
  });

  it('properly handle query error on init', async () => {
    function testInitFail(uri) {
      return new Promise((acc, rej) => {
        // eslint-disable-next-line no-new
        new PgQuery(uri, (err) => {
          if (err) {
            acc();
          } else {
            rej(new Error('Initialization should have failed'));
          }
        });
      });
    }

    await testInitFail();
    await testInitFail({});
    await testInitFail({ query: {} });
    await testInitFail({ query: {} });
    await testInitFail({
      query: {
        database: PGDATABASE,
        host: PGHOST,
        port: PGPORT,
        username: PGUSER,
        password: PGPASSWORD,
        query: QUERY_ERR,
      },
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
    await newInstance(
      false,
      ['host', PGHOST], ['port', PGPORT2]
    );

    // FIXME: TODO proper testing for multiple connections
  });

  it('resolveDns', async () => {
    await newInstance(false, ['resolveDns', true]);
  });

  it('initQuery', async () => {
    await newInstance(false, ['initQuery', "SELECT 'CURRENT DB = ' || current_database();"]);
  });

  it('parseTestOnStartup', async () => {
    const inst = await newInstance(false, ['testOnStartup', '']);
    assert.deepStrictEqual([14, 9268, 3575], inst.parseTestOnStartup(undefined));
    assert.deepStrictEqual(false, inst.parseTestOnStartup(''));
    assert.deepStrictEqual(false, inst.parseTestOnStartup('false'));
    assert.deepStrictEqual(false, inst.parseTestOnStartup('0'));
    assert.deepStrictEqual([0, 0, 0], inst.parseTestOnStartup('0,0,0'));
    assert.deepStrictEqual([0, 0, 0], inst.parseTestOnStartup('0/0/0'));
    assert.deepStrictEqual([3, 2, 1], inst.parseTestOnStartup('3,2,1'));
    assert.deepStrictEqual([3, 2, 1], inst.parseTestOnStartup('3/2/1'));
  });
});
