# tilelive-pgquery

This [tilelive](https://github.com/mapbox/tilelive#readme) module runs a PostgreSQL query created by the
 [OpenMapTiles MVT tools](https://github.com/openmaptiles/openmaptiles-tools#generate-sql-code-to-create-mvt-tiles-directly-by-postgis),
 and returns the MVT binary blob from the query results.

### Parameters

* `database` (string, required) - PostgreSQL database name
* `host` (string, required) - PostgreSQL host
* `port` (integer) - PostgreSQL port
* `maxpool` (integer) - size of the connection pool (default=10)
* `minzoom` (zoom) - minimum allowed zoom (default=0)
* `maxzoom` (zoom) - maximum allowed zoom (default=22)
* `testOnStartup` (boolean) - attempt to get a simple zoom 10 tile on startup to verify connection (default=true). Set to an empty string to disable.
* `prepareStatement` (boolean) - (defaults to `false` for funcZXY and query, `true` for `queryFile`). Use any non-empty value to enable, or empty value to disable.  

Exactly one of the following 3 parameters must be given.
* `funcZXY` (string) - name of the MVT function that accepts the Z,X,Y int parameters and returns a single binary MVT value (one row with a single column), or nothing if empty. 
* `query` (string) - an SQL statement that uses `$1, $2, $3` for Z,X,Y, and returns an MVT tile.
* `queryFile` (string) - filename of a file that contains the query.

### Testing
At this point testing requires a local PostgreSQL service, even if it is empty and runs inside a docker container:

```bash
docker run --rm --name pg-docker -e POSTGRES_PASSWORD=openmaptiles -e POSTGRES_USER=openmaptiles -e POSTGRES_DB=openmaptiles -p 5432:5432 postgres
```

Run tests in a separate shell using `npm run test`
