FROM public.ecr.aws/docker/library/alpine:3.24.3@sha256:c6b073f8e9e58d881f6ffba6ebf3b9ebd60b9e7d6e8337018c0e68bb5c356873
COPY livekit-server /livekit-server
COPY LICENSE provenance.json /usr/share/livekit/
RUN echo '6786561cd569c399bf2849e05251e19a30e9eee41bcf1180e527d1b810f07c78  /livekit-server' | sha256sum -c - && chmod 755 /livekit-server
ENTRYPOINT ["/livekit-server"]
