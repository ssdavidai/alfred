FROM python:3.11-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    rsync gettext-base git && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /setup

# Clone Alfred at pinned commit
ARG ALFRED_SHA=40f3df416cae8c145f1a9bc14211487557f37c7b
RUN git init /alfred-src && \
    git -C /alfred-src fetch --depth 1 https://github.com/ssdavidai/alfred.git ${ALFRED_SHA} && \
    git -C /alfred-src checkout FETCH_HEAD
RUN pip install --no-cache-dir --no-deps /alfred-src

COPY init/entrypoint.sh ./entrypoint.sh
COPY config.yaml.tpl ./config.yaml.tpl

RUN chmod +x entrypoint.sh

ENTRYPOINT ["./entrypoint.sh"]
