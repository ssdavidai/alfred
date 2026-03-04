FROM python:3.11-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    rsync gettext-base git && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /setup

# Clone Alfred repo for scaffold and skills
RUN git clone --depth 1 https://github.com/ssdavidai/alfred.git /alfred-src

COPY init/entrypoint.sh ./entrypoint.sh
COPY config.yaml.tpl ./config.yaml.tpl

RUN chmod +x entrypoint.sh

ENTRYPOINT ["./entrypoint.sh"]
