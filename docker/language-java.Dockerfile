# Fixed official linux/amd64 bases, separate from Run images. No network during build.
FROM eclipse-temurin@sha256:3bfab378c70af35cb21b49f195f51059257cfed17758d1d2c02500c9f292cd5c AS target11
FROM eclipse-temurin@sha256:101376794254cc58a1aa952a35ade1709cbc0f5942d5da35e226009171dde46e AS target17
FROM eclipse-temurin@sha256:de25c3be25d05d4e1f82d594fb3f3914271964361cb7cf20f3abf9d027c5ae72 AS server27
FROM eclipse-temurin@sha256:0b84a658e0d745af944a4e4d40454bac2b2fba5252cf0f2990573a8aa0cb83e1
COPY --from=target11 /opt/java/openjdk/ /opt/jdk11/
COPY --from=target17 /opt/java/openjdk/ /opt/jdk17/
COPY --from=server27 /opt/java/openjdk/ /opt/jdk27/
# Exact b1f2abe0... archive verified BEFORE build; fixed Eclipse distribution only.
ADD jdt.tar.gz /opt/jdt/
ENV HOME=/tmp XDG_CACHE_HOME=/tmp/cache JAVA_HOME=/opt/jdk27
USER 10001:10001
WORKDIR /workspace
ENTRYPOINT []
CMD ["/opt/jdk27/bin/java", "-version"]
