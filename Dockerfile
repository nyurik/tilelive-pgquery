FROM node:19
LABEL maintainer="Yuri Astrakhan <YuriAstrakhan@gmail.com>"

WORKDIR /usr/src/app

ARG PGQUERY_VERSION
RUN set -eux  ;\
    npm install -g \
      @mapbox/tilelive@6.1.0 \
      @mapbox/mbtiles@0.12.1 \
      tilelive-pgquery@${PGQUERY_VERSION}  ;\
    :

CMD tilelive-copy
