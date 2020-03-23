FROM openmaptiles/openmaptiles-tools:build-6.0-dev
MAINTAINER Yuri Astrakhan <YuriAstrakhan@gmail.com>

WORKDIR /usr/src/app

RUN curl -sL https://deb.nodesource.com/setup_12.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/ \
    && npm config set unsafe-perm true \
    && npm install -g \
      @mapbox/tilelive@6.1.0 \
      @mapbox/mbtiles@0.11.0 \
      tilelive-pgquery@0.6.2

CMD tilelive-copy
