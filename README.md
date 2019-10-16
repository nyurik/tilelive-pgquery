# tilelive-pgquery

This [tilelive](https://github.com/mapbox/tilelive#readme) module runs a PostgreSQL query created by the
 [OpenMapTiles MVT tools](https://github.com/openmaptiles/openmaptiles-tools#generate-sql-code-to-create-mvt-tiles-directly-by-postgis),
 and returns the MVT binary blob from the query results.
 
This module can connect to more than one postgreSQL server and load-balance requests based on the number of pending queries, weighted by the maxpool param.

### Parameters

* `database` (string, required) - PostgreSQL database name
* `host` (string, required) - PostgreSQL host. Could be used multiple times for load balancing.
* `port` (integer) - PostgreSQL port. Could be used multiple times for load balancing. If given, must be used once or the same number of times as there are hosts. 
* `maxpool` (integer) - size of the connection pool (default=10). If given, must be used once or the same number of times as there are hosts.
* `minzoom` (zoom) - minimum allowed zoom (default=0)
* `maxzoom` (zoom) - maximum allowed zoom (default=22)
* `testOnStartup` (boolean) - attempt to get a simple zoom 10 tile on startup to verify connection (default=true).
* `prepareStatement` (boolean) - use prepared statements (defaults to `false` for funcZXY and query, `true` for `queryFile`).  

Exactly one of the following 3 parameters must be given.
* `funcZXY` (string) - name of the MVT function that accepts the Z,X,Y int parameters and returns a single binary MVT value (one row with a single column), or nothing if empty. 
* `query` (string) - an SQL statement that uses `$1, $2, $3` for Z,X,Y, and returns an MVT tile.
* `queryFile` (string) - filename of a file that contains the query.

### Testing
At this point testing requires a local PostgreSQL service, even if it is empty and runs inside a docker container:

```bash
docker run -it --rm --name pg-docker -e POSTGRES_PASSWORD=openmaptiles -e POSTGRES_USER=openmaptiles -e POSTGRES_DB=openmaptiles -p 5432:5432 postgres

# For multi-host test, run another instance on a different port
docker run -it --rm --name pg-docker2 -e POSTGRES_PASSWORD=openmaptiles -e POSTGRES_USER=openmaptiles -e POSTGRES_DB=openmaptiles -p 5433:5432 postgres
```

Run tests in a separate shell using `npm run test`
