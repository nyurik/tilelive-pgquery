const { describe, it, afterEach } = require('mocha');
const assert = require('assert');
const { promisify } = require('util');
const zlib = require('zlib');

const PgQuery = require('../lib/PgQuery');
const { Client } = require('pg');

/**
 * This test will attempt to connect to the PostgreSQL instance running on the localhost.
 */
describe('PostgreSQL Runner Tests', () => {
  const zxy = [8, 10, 23];
  const MD5 = 'a8372432b76f55afb7c8b2e820137b30';

  const vTile = Buffer.from([0x1A].concat(zxy));
  const vTileGz = zlib.gzipSync(vTile);
  const vTileGzKey = zlib.gzipSync(vTile);
  vTileGzKey.key = MD5;

  const jpgTile = Buffer.from([0xff, 0xd8, 0xff].concat(zxy));
  const jpgTileKey = Buffer.from(jpgTile);
  jpgTileKey.key = MD5;

  const pngTile = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].concat(zxy));
  const pngTileKey = Buffer.from(pngTile);
  pngTileKey.key = MD5;

  const PGDATABASE = process.env.PGDATABASE || 'openmaptiles';
  const PGHOST = process.env.PGHOST || 'localhost';
  const PGPORT = process.env.PGPORT || '5432';
  const PGPORT2 = process.env.PGPORT2 || '5434';
  const PGUSER = process.env.PGUSER || 'openmaptiles';
  const PGPASSWORD = process.env.PGPASSWORD || 'openmaptiles';

  let newRunner = null;

  let vTileLiteral;
  let vTileGzLiteral;
  let jpgTileLiteral;
  let pngTileLiteral;

  let QUERY_ERR;

  before(async () => {
    const client = new Client({
      database: PGDATABASE,
      host: PGHOST,
      port: PGPORT,
      user: PGUSER,
      password: PGPASSWORD,
    });
    await client.connect();

    // Ensure that the format of the binary data literal is exactly as PG expects
    // Send it as a param, get as hex-encoded. Use the decode function as part of the literal value
    const res = await client.query(
      'SELECT ' +
        "encode($1::bytea, 'hex') as a1, " +
        "encode($2::bytea, 'hex') as a2, " +
        "encode($3::bytea, 'hex') as a3, " +
        "encode($4::bytea, 'hex') as a4",
      [vTile, vTileGz, jpgTile, pngTile]
    );
    vTileLiteral = `decode('${res.rows[0].a1}', 'hex')`;
    vTileGzLiteral = `decode('${res.rows[0].a2}', 'hex')`;
    jpgTileLiteral = `decode('${res.rows[0].a3}', 'hex')`;
    pngTileLiteral = `decode('${res.rows[0].a4}', 'hex')`;
    await client.end();
  });

  function query(literal, key, type) {
    let res = `SELECT ${literal}::bytea as mvt`;
    if (key) {
      res += `, '${key}'::text as key`;
    }
    switch (type) {
      case 'funcZXY':
        return {
          funcZXY: 'pg_temp.test_mvt',
          connectionInitQuery: `\
CREATE FUNCTION pg_temp.test_mvt(zoom integer, x integer, y integer)
RETURNS TABLE(mvt bytea${key ? ', key text' : ''}) AS $$
${res} WHERE x >= 0 AND y >= 0 AND zoom >= 0
$$ LANGUAGE SQL STABLE RETURNS NULL ON NULL INPUT;`,
        };
      case 'query':
      default:
        return { query: `${res} WHERE $1 >= 0 AND $2 >= 0 AND $3 >= 0` };
    }
  }

  async function cleanup() {
    if (newRunner) {
      await newRunner.shutdownAsync();
      newRunner = null;
    }
  }

  afterEach(cleanup);

  async function newInstance(params, ...extraParams) {
    await cleanup();
    const creator = promisify((uri, callback) => new PgQuery(uri, callback));
    const queryObj = new URLSearchParams({
      database: PGDATABASE,
      host: PGHOST,
      port: PGPORT,
      username: PGUSER,
      password: PGPASSWORD,
      serverInfo: false,
      specInfo: false,
      ...(params || query(vTileLiteral)),
    });
    if (extraParams) {
      for (const vals of extraParams) {
        for (const k of Object.keys(vals)) {
          queryObj.append(k, vals[k]);
        }
      }
    }
    // noinspection JSCheckFunctionSignatures
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
    await newInstance({ ...query(vTileLiteral), serverInfo: true });
  });

  it('source info', async () => {
    await newInstance({ ...query(vTileLiteral), specInfo: true });
  });

  const assertGetTile = async (params, expectedData, expectedType, expectedEnc, ...extraParams) => {
    const inst = await newInstance(params, ...extraParams);

    return new Promise((acc, rej) => {
      inst.getTile(...zxy, (err, data, headers) => {
        if (err) {
          rej(err);
        } else {
          assert.strictEqual(data.constructor.name, 'Buffer');
          assert.deepStrictEqual(data, expectedData);
          const expectedHeaders = {
            'Content-Type': expectedType,
          };
          if (expectedEnc) {
            expectedHeaders['Content-Encoding'] = expectedEnc;
          }
          assert.deepStrictEqual(headers, expectedHeaders);
          acc();
        }
      });
    });
  };

  for (const testType of ['query', 'funcZXY']) {
    // eslint-disable-next-line no-loop-func
    describe(`get tile using ${testType} method`, () => {
      it('vector tile auto', () => assertGetTile(
        query(vTileLiteral, false, testType),
        vTileGz, 'application/x-protobuf', 'gzip'
      ));
      it('vector tile gz auto', () => assertGetTile(
        query(vTileGzLiteral, false, testType),
        vTileGz, 'application/x-protobuf', 'gzip'
      ));
      it('vector tile gz gzip=false', () => assertGetTile(
        { ...query(vTileGzLiteral, false, testType), gzip: 'false' },
        vTileGz, 'application/x-protobuf', 'gzip'
      ));
      it('vector tile nogzip=1 key=1', () => assertGetTile(
        { ...query(vTileGzLiteral, MD5, testType), nogzip: 1, key: 1 },
        vTileGzKey, 'application/x-protobuf', 'gzip'
      ));
      it('vector tile custom headers', () => assertGetTile(
        { ...query(vTileLiteral, false, testType), contentType: 'my-content', contentEncoding: 'my-encoding' },
        vTileGz, 'my-content', 'my-encoding'
      ));
      it('vector tile with key auto', () => assertGetTile(
        { ...query(vTileLiteral, MD5, testType) },
        vTileGzKey, 'application/x-protobuf', 'gzip'
      ));
      it('vector tile with key', () => assertGetTile(
        { ...query(vTileLiteral, MD5, testType), key: '1' },
        vTileGzKey, 'application/x-protobuf', 'gzip'
      ));
      it('jpg tile', () => assertGetTile(
        query(jpgTileLiteral, false, testType),
        jpgTile, 'image/jpeg', false
      ));
      it('jpg tile gzip=false', () => assertGetTile(
        { ...query(jpgTileLiteral, false, testType), gzip: 'false' },
        jpgTile, 'image/jpeg', false
      ));
      it('png tile', () => assertGetTile(
        query(pngTileLiteral, false, testType), pngTile,
        'image/png', false
      ));
      it('png tile gzip=false', () => assertGetTile(
        { ...query(pngTileLiteral, false, testType), gzip: 'false' },
        pngTile, 'image/png', false
      ));
      it('vector tile func', () => assertGetTile(
        { ...query(pngTileLiteral, false, testType), gzip: 'false' },
        pngTile, 'image/png', false
      ));
    });
  }

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
    const inst = await newInstance({
      ...query(0), testOnStartup: '', key: '0', gzip: true,
    });

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
    await newInstance(query(vTileLiteral), { host: PGHOST, port: PGPORT2 });

    // FIXME: TODO proper testing for multiple connections
  });

  it('resolveDns', async () => {
    await newInstance({ ...query(vTileLiteral), resolveDns: true });
  });

  it('initQuery', async () => {
    await newInstance({ ...query(vTileLiteral), initQuery: "SELECT 'CURRENT DB = ' || current_database();" });
  });

  it('parseTestOnStartup', async () => {
    const instanceParams = {
      ...query(vTileLiteral),
      testOnStartup: '',
      key: '0',
      gzip: 'true',
    };
    let inst = await newInstance(instanceParams);
    assert.deepStrictEqual([14, 9268, 3575], inst.parseTestOnStartup(undefined));
    assert.deepStrictEqual(false, inst.parseTestOnStartup(''));
    assert.deepStrictEqual(false, inst.parseTestOnStartup('false'));
    assert.deepStrictEqual(false, inst.parseTestOnStartup('0'));
    assert.deepStrictEqual([0, 0, 0], inst.parseTestOnStartup('0,0,0'));
    assert.deepStrictEqual([0, 0, 0], inst.parseTestOnStartup('0/0/0'));
    assert.deepStrictEqual([3, 2, 1], inst.parseTestOnStartup('3,2,1'));
    assert.deepStrictEqual([3, 2, 1], inst.parseTestOnStartup('3/2/1'));

    inst = await newInstance({
      ...instanceParams,
      maxzoom: '10',
    });
    assert.deepStrictEqual([10, 579, 223], inst.parseTestOnStartup(undefined));

    inst = await newInstance({
      ...instanceParams,
      minzoom: '15',
      maxzoom: '16',
    });
    assert.deepStrictEqual([15, 18536, 7150], inst.parseTestOnStartup(undefined));
  });
});
