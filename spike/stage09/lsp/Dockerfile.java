FROM eclipse-temurin:27-jdk@sha256:de25c3be25d05d4e1f82d594fb3f3914271964361cb7cf20f3abf9d027c5ae72 AS target27
FROM eclipse-temurin:21-jdk@sha256:0b84a658e0d745af944a4e4d40454bac2b2fba5252cf0f2990573a8aa0cb83e1
COPY --from=target27 /opt/java/openjdk /opt/jdk27
ADD --chown=10001:10001 jdt.tar.gz /opt/jdt/
ENV HOME=/tmp XDG_CACHE_HOME=/tmp/cache
USER 10001:10001
WORKDIR /work
ENTRYPOINT []
