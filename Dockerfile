FROM node:16
LABEL maintainer="Yuri Astrakhan <YuriAstrakhan@gmail.com>"

WORKDIR /usr/src/app

ARG PGQUERY_VERSION
RUN set -eux  ;\
    npm config set unsafe-perm true  ;\
    npm install -g \
      @mapbox/tilelive@6.1.0 \
      @mapbox/mbtiles@0.12.1 \
      tilelive-pgquery@${PGQUERY_VERSION}  ;\
    :

CMD tilelive-copy
