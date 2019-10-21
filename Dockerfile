FROM node:12
MAINTAINER Yuri Astrakhan <YuriAstrakhan@gmail.com>

WORKDIR /usr/src/app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        sqlite3 \
        libsqlite3-dev \
        postgresql-client \
        sqlite3 \
    && rm -rf /var/lib/apt/lists/

RUN npm config set unsafe-perm true \
    && npm install -g \
      @mapbox/tilelive@6.0.0 \
      @mapbox/mbtiles@0.11.0 \
      tilelive-pgquery@0.2.7

ENTRYPOINT ["tilelive-copy"]
