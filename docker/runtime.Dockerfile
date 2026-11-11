# Supplied only by reviewed runtime-prepare request; both references must be @sha256.
ARG NODE_IMAGE
ARG BASE_IMAGE
FROM ${NODE_IMAGE} AS dispatcher
FROM maven@sha256:be898b0cf3929205778d61b2841aa36733513a79b0404f9cac67837863c8641f AS maven
FROM ${BASE_IMAGE}
USER root
# Fixed official Maven3.9.12 inventory; runs under selected base JDK, never the Maven-stage JDK.
COPY --from=maven /usr/share/maven/ /usr/share/maven/
COPY --from=dispatcher /usr/local/bin/node /opt/paircoach/node/bin/node
COPY --from=dispatcher /usr/local/lib/node_modules/npm/ /usr/local/lib/node_modules/npm/
# No network package install. Approved regular-file inventory contains pinned compiler/parser tools.
COPY tools/ /opt/paircoach/tools/
COPY scripts/ /opt/paircoach/
# Parser resolution is local to the dispatcher; no task dependency supplies control code.
ENV NODE_PATH=/opt/paircoach/tools/node_modules
RUN mkdir -p /opt/paircoach/node_modules /workspace /input /artifacts /cache && \
    cp -a /opt/paircoach/tools/node_modules/. /opt/paircoach/node_modules/ && \
    chmod -R a+rX /opt/paircoach/tools /opt/paircoach/node_modules /opt/paircoach/*.mjs && \
    chown -R 10001:10001 /workspace /input /artifacts /cache
USER 10001:10001
WORKDIR /workspace
ENTRYPOINT []
CMD ["/opt/paircoach/node/bin/node", "--version"]
