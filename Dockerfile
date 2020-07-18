FROM openmaptiles/openmaptiles-tools:build-6.0-dev
LABEL maintainer="Yuri Astrakhan <YuriAstrakhan@gmail.com>"

WORKDIR /usr/src/app

RUN set -eux  ;\
    curl -sL https://deb.nodesource.com/setup_12.x | bash -  ;\
    DEBIAN_FRONTEND=noninteractive apt-get update  ;\
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends  \
        nodejs  ;\
    rm -rf /var/lib/apt/lists/  ;\
    npm config set unsafe-perm true  ;\
    npm install -g \
      @mapbox/tilelive@6.1.0 \
      @mapbox/mbtiles@0.11.0 \
      tilelive-pgquery@0.7.1

CMD tilelive-copy
