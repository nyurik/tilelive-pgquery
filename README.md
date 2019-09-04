# @nyurik/pgquery

This [tilelive](https://github.com/mapbox/tilelive#readme) module runs a PostgreSQL query created by the
 [OpenMapTiles MVT tools](https://github.com/openmaptiles/openmaptiles-tools#generate-sql-code-to-create-mvt-tiles-directly-by-postgis),
 and returns the MVT binary blob from the query results.

### Testing
At this point testing requires a local PostgreSQL service, even if it is empty and runs inside a docker container:

```bash
docker run --rm --name pg-docker -e POSTGRES_PASSWORD=openmaptiles -e POSTGRES_USER=openmaptiles -e POSTGRES_DB=openmaptiles -p 5432:5432 postgres
```

Run tests in a separate shell using `npm run test`
