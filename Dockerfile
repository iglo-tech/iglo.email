# The official image wraps the release executable of the image's architecture (D3, D89). Nothing is
# compiled here: the release workflow builds and verifies one executable per architecture and puts
# them at dist/docker/<amd64|arm64>/iglo.email before a multi-arch build. To build locally for the
# host's architecture:
#
#   bun run build && install -D -m 0755 dist/iglo.email dist/docker/amd64/iglo.email   # or arm64
#   docker build --build-arg VERSION=dev -t iglo.email .
#
# Base images are pinned by digest; Renovate updates them.

# Only makes the data directory, with the runtime user as its owner. It runs on the build host, so
# the arm64 image needs no emulation.
FROM --platform=$BUILDPLATFORM debian:12-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc AS data
RUN install -d -o 65532 -g 65532 -m 0700 /data

# glibc, libstdc++ and CA certificates, no shell. 65532 is its non-root user.
FROM gcr.io/distroless/cc-debian12@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f
ARG TARGETARCH
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="iglo.email" \
      org.opencontainers.image.source="https://github.com/iglo-tech/iglo.email" \
      org.opencontainers.image.licenses="AGPL-3.0" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
COPY --from=data --chown=65532:65532 /data /data
COPY --chmod=0755 dist/docker/${TARGETARCH}/iglo.email /usr/local/bin/iglo.email
USER 65532:65532
WORKDIR /data
# The server must listen on all interfaces inside the container; publish the port to the host
# only where it should be reachable. Set IGLO_EMAIL_ROOT_URL to the public URL.
ENV IGLO_EMAIL_DATA_DIR=/data \
    IGLO_EMAIL_HOST=0.0.0.0 \
    IGLO_EMAIL_PORT=9000
VOLUME /data
EXPOSE 9000
# No HEALTHCHECK: the image has no shell or HTTP client. Probe GET /health from the orchestrator.
ENTRYPOINT ["/usr/local/bin/iglo.email"]
CMD ["serve"]
