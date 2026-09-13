DB ?= postgres://idem:idem@localhost:5432/idem?sslmode=disable
N  ?= 500

.PHONY: up down proof reset compare

up:
	docker compose up --build -d
	@echo "waiting for load balancer..."
	@until curl -sf http://localhost:8080/healthz >/dev/null; do sleep 1; done
	@echo "ready on :8080"

down:
	docker compose down -v

reset:
	psql "$(DB)" -c "TRUNCATE payments, idempotency_keys"

proof:
	go run ./cmd/proof -n $(N) -db "$(DB)" -label "$$(git describe --tags --always)"

# Run the same harness against both tags and keep the output side by side.
compare:
	@git stash push -u -q --keep-index 2>/dev/null || true
	git checkout -q v0-naive && $(MAKE) up  && -$(MAKE) proof N=$(N) | tee /tmp/naive.txt
	git checkout -q v1-idempotent && $(MAKE) up && $(MAKE) proof N=$(N) | tee /tmp/fixed.txt
	@echo; echo "=== side by side ==="; paste /tmp/naive.txt /tmp/fixed.txt