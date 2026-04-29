.PHONY: build-ctrl dev-ctrl build-saas test-saas-unit test-learn build-learn build-openclaw

build-ctrl:
	cd packages/ctrl && npm ci && npm run build

dev-ctrl:
	cd packages/ctrl && npm run dev

build-saas:
	cd packages/saas/app && wasp build

# Lightweight unit tests for SaaS server modules that have no Wasp/Prisma
# dependency (pure functions, guards, validators). Uses Node's built-in
# test runner + tsx for TS support so we don't have to add jest/vitest.
test-saas-unit:
	cd packages/saas/app && npx -y tsx --test "src/server/**/*.test.ts" "src/integrations/**/*.test.ts"

test-learn:
	cd packages/learn && pip install -r requirements.txt && pytest tests/ -v

build-learn:
	cd packages/learn && docker build -t ssdavidai00/alfred-learn:dev .

build-openclaw:
	cd packages/openclaw && docker build -f dockerfiles/openclaw.Dockerfile -t ssdavidai00/alfred-openclaw:dev .
