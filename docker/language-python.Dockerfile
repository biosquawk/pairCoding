FROM python@sha256:8cdd496996889eef0a8a7921c152c0a4a9f18a26c7a5e7257d3c90b431891894
COPY wheels/ /wheels/
COPY requirements.lock /requirements.lock
# Build network disabled. Exact12 wheel bytes/hash lock, no resolver or startup install.
RUN /usr/local/bin/python -m pip --isolated install --no-index --no-deps --require-hashes --no-compile --find-links=/wheels --target=/opt/pylsp -r /requirements.lock && \
    chmod -R a+rX /opt/pylsp && rm -rf /wheels
ENV HOME=/tmp XDG_CACHE_HOME=/tmp/cache PYTHONPATH=/opt/pylsp PYTHONDONTWRITEBYTECODE=1
USER 10001:10001
WORKDIR /workspace
ENTRYPOINT []
CMD ["/usr/local/bin/python", "-m", "pylsp"]
