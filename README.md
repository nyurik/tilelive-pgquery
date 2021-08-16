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
with the first column being the tile data blob. The data blob could be gzip-compressed by the server, in which case tilelive-pgqeury will work faster by skipping the compression step.  An optional second column may contain a hash string, i.e. the result of the `MD5(tile)` which will also speed up tilelive-pgquery tile retrieval. Without the hash, tilelive-pgquery will have to compute MD5 hash string itself. Tilelive-pgquery will determine the structure of the response during the startup by querying a tile specified by the `testOnStartup` parameter (or default tile `14/9268/3575`). 

### Parameters

* `database` (string, required) - PostgreSQL database name. Uses `PGDATABASE` env var if not set.
* `host` (string, required) - PostgreSQL host. Could be used multiple times for load balancing.  Uses `PGHOST` env var if not set.
* `port` (integer) - PostgreSQL port. Could be used multiple times for load balancing. If given, must be used once or the same number of times as there are hosts.  Uses `PGPORT` env var if not set.
* `username` (string) - PostgreSQL username. Uses `PGUSER` env var if not set.
* `password` (string) - PostgreSQL password. Uses `PGPASSWORD` env var if not set.
* `maxpool` (integer) - size of the per-server connection pool (default=10). If given, must be used once or the same number of times as there are hosts.
* `minzoom` (zoom) - minimum allowed zoom (default=0)
* `maxzoom` (zoom) - maximum allowed zoom (default=22)
* `testOnStartup` (tile index) - set which tile (in z/x/y or z,x,y format) to get on startup to verify database connection.  By default, uses a simple tile in Norway on zoom 10.
* `serverInfo` (boolean) - if non-empty or not given, prints PostgreSQL & PostGIS version data and key metrics. To disable, set to an empty value.
* `prepareStatement` (boolean) - use prepared statements (defaults to `false` for funcZXY and query, `true` for `queryFile`).
* `resolveDns` (boolean) - convert host value(s) to corresponding IPs on startup. If DNS resolves to multiple IPs, all IPs will be used in a pool.
* `errorsAsEmpty` (boolean) - if set, treats all query errors as empty tiles, returning standard `Tile does not exist` error. 
* `connectionInitQuery` (string) - if set, run this query each time a new connection is made to a server.
* `name` (string) - if set, adds this name to the metadata's name field
* `key` (boolean) - if set, assumes the second query result column is a key (hash) value that should be attached to the result buffer. By default auto-detects it by looking at the response.
* `gzip` (boolean) - if set, will gzip-compresses data tile. By default, auto-detects if the server has gzip-compressed data by trying to un-gzip the `testOnStartup` tile. The `nogzip` obsolete parameter will be used if `gzip` is not set, and has the inverse meaning.
* `contentType` (string) - set `content-type` header. Uses `auto` by default, detecting the tile type by querying `testOnStartup` tile. If the tile content is recognized, content type will be set to one of these values:
     `application/x-protobuf`, `image/jpeg`, or `image/png`
* `contentEncoding` (string) - set `content-encoding` header. Uses `auto` by default -- `gzip` for vector tiles, and unset for jpg/png images.

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
