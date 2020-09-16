# tilelive-pgquery
[![](https://img.shields.io/npm/dm/tilelive-pgquery?label=NPM)](https://www.npmjs.com/package/tilelive-pgquery)
[![](https://img.shields.io/docker/cloud/build/nyurik/tilelive-pgquery?label=Docker)](https://hub.docker.com/r/nyurik/tilelive-pgquery)
[![](https://img.shields.io/microbadger/layers/nyurik/tilelive-pgquery?label=Docker%20layers)](https://hub.docker.com/r/nyurik/tilelive-pgquery)
[![](https://img.shields.io/microbadger/image-size/nyurik/tilelive-pgquery?label=Docker%20size)](https://hub.docker.com/r/nyurik/tilelive-pgquery)
[![](https://img.shields.io/docker/pulls/nyurik/tilelive-pgquery?label=Docker%20downloads)](https://hub.docker.com/r/nyurik/tilelive-pgquery)
[![](https://img.shields.io/docker/stars/nyurik/tilelive-pgquery?label=Docker%20stars)](https://hub.docker.com/r/nyurik/tilelive-pgquery)

This [tilelive](https://github.com/mapbox/tilelive#readme) module runs a PostgreSQL query created by the
 [OpenMapTiles MVT tools](https://github.com/openmaptiles/openmaptiles-tools#generate-sql-code-to-create-mvt-tiles-directly-by-postgis),
 and returns the data blob from the query results.

This module can connect to more than one postgreSQL server and load-balance requests based on the number of pending queries, weighted by the maxpool param.

This module expects either a parametrized query, or the name of a PostgreSQL function with three parameters: `z, x, y`. The result is expected to be zero or one row,
with the first column being the tile data blob. If the `key` parameter is set, the second column must be the hash of the content. If the result blob is empty,
or there are no rows, pgquery raises the standard "no-tile" error. 

### Parameters

* `database` (string, required) - PostgreSQL database name. Uses `PGDATABASE` env var if not set.
* `host` (string, required) - PostgreSQL host. Could be used multiple times for load balancing.  Uses `PGHOST` env var if not set.
* `port` (integer) - PostgreSQL port. Could be used multiple times for load balancing. If given, must be used once or the same number of times as there are hosts.  Uses `PGPORT` env var if not set.
* `username` (string) - PostgreSQL username. Uses `PGUSER` env var if not set.
* `password` (string) - PostgreSQL password. Uses `PGPASSWORD` env var if not set.
* `maxpool` (integer) - size of the connection pool (default=10). If given, must be used once or the same number of times as there are hosts.
* `minzoom` (zoom) - minimum allowed zoom (default=0)
* `maxzoom` (zoom) - maximum allowed zoom (default=22)
* `testOnStartup` (tile index) - set which tile (in z/x/y or z,x,y format) to get on startup to verify database connection.  To disable, set to an empty value. By default uses a simple tile in Norway on zoom 10.
* `serverInfo` (boolean) - if non-empty or not given, prints PostgreSQL & PostGIS version data and key metrics. To disable, set to an empty value.
* `prepareStatement` (boolean) - use prepared statements (defaults to `false` for funcZXY and query, `true` for `queryFile`).
* `resolveDns` (boolean) - convert host value(s) to corresponding IPs on startup. If DNS resolves to multiple IPs, all IPs will be used in a pool.
* `errorsAsEmpty` (boolean) - if set, treats all query errors as empty tiles, returning standard `Tile does not exist` error. 
* `connectionInitQuery` (string) - if set, run this query each time a new connection is made to a server.
* `name` (string) - if set, adds this name to the metadata's name field
* `key` (boolean) - if set, assumes the second query result column is a key that should be attached to the result buffer.
* `nogzip` (boolean) - do not compress data blob (use this if the query returns compressed data or an image) 
* `contentType` (string) - set `content-type` header. Uses `application/x-protobuf` by default.
* `contentEncoding` (string) - set `content-encoding` header. Uses `gzip` by default.

Exactly one of the following 3 parameters must be given.
* `funcZXY` (string) - name of the function that accepts the `Z, X, Y` int parameters.
* `query` (string) - an SQL statement that uses `$1, $2, $3` parameters for `Z, X, Y`.
* `queryFile` (string) - filename of a file that contains the query with `$1, $2, $3` parameters for `Z, X, Y`.

### Testing
Testing requires a local PostgreSQL service, even if it is empty and runs inside a docker container:

```bash
docker run -it --rm --name pg-docker -e POSTGRES_PASSWORD=openmaptiles -e POSTGRES_USER=openmaptiles -e POSTGRES_DB=openmaptiles -p 5432:5432 postgres

# For multi-host test, run another instance on a different port
docker run -it --rm --name pg-docker2 -e POSTGRES_PASSWORD=openmaptiles -e POSTGRES_USER=openmaptiles -e POSTGRES_DB=openmaptiles -p 5433:5432 postgres
```

Run tests in a separate shell using `yarn run test`
