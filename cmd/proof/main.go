// proof fires N concurrent POSTs at one idempotency key and checks the
// database, not just the HTTP responses, to prove exactly one payment row
// was created no matter how many callers raced for it.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

type state string

const (
	stateCreated  state = "created"
	stateReplayed state = "replayed"
	stateConflict state = "conflict"
	stateError    state = "error"
)

type result struct {
	state    state
	status   int
	attempts int
	servedBy string
	bodyHash string
}

const payload = `{"amount":4200,"currency":"EUR","reference":"invoice-7781"}`

var (
	flagURL     = flag.String("url", "http://localhost:8080", "base URL of the API")
	flagDB      = flag.String("db", envOr("DATABASE_URL", "postgres://idem:idem@localhost:5432/idem?sslmode=disable"), "database DSN, for the ground-truth counts")
	flagN       = flag.Int("n", 500, "number of concurrent requests")
	flagRetries = flag.Int("retries", 20, "max retries on 409 before giving up on one caller")
	flagKey     = flag.String("key", "", "idempotency key to use (default: proof-<unix ms>)")
	flagLabel   = flag.String("label", "current", "label for the report header")
)

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func main() {
	flag.Parse()

	key := *flagKey
	if key == "" {
		key = fmt.Sprintf("proof-%d", time.Now().UnixMilli())
	}
	n := *flagN

	// Go's default transport does not cap concurrent connections per host the
	// way Node's undici dispatcher does, but a generous MaxIdleConnsPerHost
	// still keeps the burst from repeatedly tearing down and reopening TCP
	// connections mid-run.
	client := &http.Client{
		Transport: &http.Transport{
			MaxIdleConnsPerHost: n,
			IdleConnTimeout:     30 * time.Second,
		},
	}

	fmt.Printf("firing %d concurrent requests at %s\n", n, *flagURL)
	fmt.Printf("key: %s\n\n", key)

	// Every goroutine blocks on the same gate before firing, so the start is
	// simultaneous rather than staggered past the window under test.
	gate := make(chan struct{})
	results := make([]result, n)
	var wg sync.WaitGroup
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func(i int) {
			defer wg.Done()
			<-gate
			results[i] = fire(client, key)
		}(i)
	}

	t0 := time.Now()
	close(gate)
	wg.Wait()
	elapsed := time.Since(t0)

	report(key, elapsed, results)
}

func fire(client *http.Client, key string) result {
	for attempt := 1; ; attempt++ {
		res, err := doRequest(client, key)
		if err != nil {
			return result{state: stateError, attempts: attempt, servedBy: "unreachable"}
		}

		// 409 means the winner holds the key but has not committed yet. That
		// is the endpoint working, not failing.
		if res.status == http.StatusConflict && attempt <= *flagRetries {
			time.Sleep(time.Duration(attempt) * 25 * time.Millisecond)
			continue
		}

		res.attempts = attempt
		return res
	}
}

func doRequest(client *http.Client, key string) (result, error) {
	req, err := http.NewRequest(http.MethodPost, strings.TrimRight(*flagURL, "/")+"/payments", strings.NewReader(payload))
	if err != nil {
		return result{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", key)

	resp, err := client.Do(req)
	if err != nil {
		return result{}, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return result{}, err
	}

	replayed := resp.Header.Get("Idempotency-Replayed") == "true"
	ok := resp.StatusCode >= 200 && resp.StatusCode < 300

	st := stateError
	switch {
	case resp.StatusCode == http.StatusConflict:
		st = stateConflict
	case ok && replayed:
		st = stateReplayed
	case ok:
		st = stateCreated
	}

	servedBy := resp.Header.Get("X-Served-By")
	if servedBy == "" {
		servedBy = "unknown"
	}

	sum := sha256.Sum256(body)
	return result{
		state:    st,
		status:   resp.StatusCode,
		servedBy: servedBy,
		bodyHash: hex.EncodeToString(sum[:])[:12],
	}, nil
}

func report(key string, elapsed time.Duration, results []result) {
	bodies := map[string]int{}
	instances := map[string]int{}
	var created, replayed, conflicts, errs, maxAttempts int

	for _, r := range results {
		instances[r.servedBy]++
		if r.attempts > maxAttempts {
			maxAttempts = r.attempts
		}
		if r.state == stateCreated || r.state == stateReplayed {
			bodies[r.bodyHash]++
		}
		switch r.state {
		case stateCreated:
			created++
		case stateReplayed:
			replayed++
		case stateConflict:
			conflicts++
		default:
			errs++
		}
	}

	rows, keyRows, err := counts(key)
	if err != nil {
		fmt.Fprintf(os.Stderr, "counting rows: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("=== %s ===\n", *flagLabel)
	row("wall clock", fmt.Sprintf("%d ms", elapsed.Milliseconds()))
	row("payment rows created", rows)
	row("idempotency key rows", keyRows)
	row("HTTP 201 created", created)
	row("HTTP replays", replayed)
	row("distinct bodies", len(bodies))
	row("unresolved 409s", conflicts)
	row("errors", errs)
	row("max attempts by one", maxAttempts)
	row("served by", servedBySummary(instances))

	if len(bodies) > 1 {
		fmt.Println("\ndistinct response bodies (each one is a separate payment):")
		for hash, count := range bodies {
			fmt.Printf("  %s  x%d\n", hash, count)
		}
	}

	n := *flagN
	checks := []struct {
		name   string
		ok     bool
		detail string
	}{
		{"exactly one payment row", rows == 1, fmt.Sprintf("%d", rows)},
		{"exactly one 201 created", created == 1, fmt.Sprintf("%d", created)},
		{"all others replayed", replayed == n-1, fmt.Sprintf("%d, want %d", replayed, n-1)},
		{"one distinct response body", len(bodies) == 1, fmt.Sprintf("%d", len(bodies))},
		{"no errors", errs == 0, fmt.Sprintf("%d", errs)},
		{"no unresolved conflicts", conflicts == 0, fmt.Sprintf("%d", conflicts)},
	}

	fmt.Println()
	failed := 0
	for _, c := range checks {
		status := "PASS"
		if !c.ok {
			status = "FAIL"
			failed++
		}
		fmt.Printf("[%s] %-28s %s\n", status, c.name, c.detail)
	}

	if failed > 0 {
		fmt.Printf("\n%d/%d checks failed. Duplicates: %d extra payment rows.\n", failed, len(checks), rows-1)
		os.Exit(1)
	}
	fmt.Printf("\nall %d checks passed.\n", len(checks))
}

func servedBySummary(instances map[string]int) string {
	names := make([]string, 0, len(instances))
	for name := range instances {
		names = append(names, name)
	}
	sort.Strings(names)

	parts := make([]string, 0, len(names))
	for _, name := range names {
		parts = append(parts, fmt.Sprintf("%s=%d", name, instances[name]))
	}
	return strings.Join(parts, "  ")
}

func counts(key string) (paymentRows, keyRows int, err error) {
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, *flagDB)
	if err != nil {
		return 0, 0, err
	}
	defer conn.Close(ctx)

	if err := conn.QueryRow(ctx,
		`SELECT count(*) FROM payments WHERE idempotency_key = $1`, key,
	).Scan(&paymentRows); err != nil {
		return 0, 0, err
	}
	if err := conn.QueryRow(ctx,
		`SELECT count(*) FROM idempotency_keys WHERE key = $1`, key,
	).Scan(&keyRows); err != nil {
		return 0, 0, err
	}
	return paymentRows, keyRows, nil
}

func row(label string, value any) {
	fmt.Printf("%-22s%v\n", label, value)
}
