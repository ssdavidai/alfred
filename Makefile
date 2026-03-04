.PHONY: build-ctrl dev-ctrl build-saas test-learn build-learn build-openclaw

build-ctrl:
	cd packages/ctrl && npm ci && npm run build

dev-ctrl:
	cd packages/ctrl && npm run dev

build-saas:
	cd packages/saas/app && wasp build

test-learn:
	cd packages/learn && pip install -r requirements.txt && pytest tests/ -v

build-learn:
	cd packages/learn && docker build -t ssdavidai00/alfred-learn:dev .

build-openclaw:
	cd packages/openclaw && docker build -f dockerfiles/openclaw.Dockerfile -t ssdavidai00/alfred-openclaw:dev .
