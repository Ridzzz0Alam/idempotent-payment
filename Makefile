DB ?= postgres://idem:idem@localhost:5432/idem
N  ?= 500

.PHONY: up down proof reset logs

up:
	docker compose up --build -d
	@echo "waiting for load balancer..."
	@until curl -sf http://localhost:8080/healthz >/dev/null; do sleep 1; done
	@echo "ready on :8080"

down:
	docker compose down -v

logs:
	docker compose logs -f api-1 api-2

reset:
	psql "$(DB)" -c "TRUNCATE payments, idempotency_keys"

proof:
	cd backend && npm run proof -- --n $(N) --db "$(DB)" --label "$$(git describe --tags --always)"
