package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Ridzzz0Alam/idempotent-payment/internal/api"
	"github.com/Ridzzz0Alam/idempotent-payment/internal/store"
)

func main() {
	ctx := context.Background()

	dsn := env("DATABASE_URL", "postgres://idem:idem@localhost:5432/idem?sslmode=disable")
	port := env("PORT", "8080")
	instance := env("INSTANCE_ID", "api-1")

	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		log.Fatalf("bad DATABASE_URL: %v", err)
	}
	// Deliberately smaller than the proof's concurrency. Losers must not hold a
	// connection while they wait, or the pool becomes the bottleneck and the
	// experiment measures queueing instead of correctness.
	cfg.MaxConns = 20
	cfg.MaxConnLifetime = time.Hour

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		log.Fatalf("connect: %v", err)
	}
	defer pool.Close()

	if err := waitForDB(ctx, pool); err != nil {
		log.Fatalf("database never became ready: %v", err)
	}
	if err := migrate(ctx, pool); err != nil {
		log.Fatalf("migrate: %v", err)
	}

	srv := &api.Server{Store: store.New(pool), Instance: instance}
	log.Printf("%s listening on :%s", instance, port)
	if err := http.ListenAndServe(":"+port, srv.Routes()); err != nil {
		log.Fatal(err)
	}
}

func waitForDB(ctx context.Context, pool *pgxpool.Pool) error {
	var err error
	for i := 0; i < 30; i++ {
		if err = pool.Ping(ctx); err == nil {
			return nil
		}
		time.Sleep(time.Second)
	}
	return err
}

// migrate applies the schema. Both instances race to run it on boot, so every
// statement is IF NOT EXISTS and the whole thing runs inside one transaction.
func migrate(ctx context.Context, pool *pgxpool.Pool) error {
	sql, err := os.ReadFile(env("MIGRATION_PATH", "migrations/001_schema.sql"))
	if err != nil {
		return err
	}
	_, err = pool.Exec(ctx, string(sql))
	return err
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}