package store

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type CreatePaymentRequest struct {
	Amount    int64  `json:"amount"`
	Currency  string `json:"currency"`
	Reference string `json:"reference"`
}

type CreatePaymentResponse struct {
	PaymentID string    `json:"payment_id"`
	Amount    int64     `json:"amount"`
	Currency  string    `json:"currency"`
	Reference string    `json:"reference"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"created_at"`
}

// Outcome is what the HTTP layer turns into a response.
type Outcome struct {
	Code       int
	Body       []byte
	Replayed   bool
	InProgress bool // caller should retry shortly
	Mismatch   bool // key reused with a different payload
}

type Store struct{ pool *pgxpool.Pool }

func New(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

// Create claims the idempotency key by inserting it, and treats the resulting
// conflict as the answer rather than asking a question first.
//
// The claim and the payment insert share one transaction. That is the whole
// design. Because they commit together, there is no window in which a key
// exists without its payment, or a payment exists without its key.
func (s *Store) Create(ctx context.Context, key string, raw []byte, req CreatePaymentRequest) (Outcome, error) {
	sum := sha256.Sum256(raw)
	hash := sum[:]

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Outcome{}, err
	}
	defer tx.Rollback(context.Background()) //nolint:errcheck

	// ---- CLAIM -------------------------------------------------------------
	// ON CONFLICT DO NOTHING does not block on a conflicting uncommitted row;
	// it returns zero rows immediately. That matters at 500 concurrent: the
	// 499 losers release their connection in microseconds instead of queueing
	// behind the winner's transaction and exhausting the pool.
	var claimed string
	err = tx.QueryRow(ctx, `
		INSERT INTO idempotency_keys (key, request_hash, status)
		VALUES ($1, $2, 'in_progress')
		ON CONFLICT (key) DO NOTHING
		RETURNING key`, key, hash).Scan(&claimed)

	if errors.Is(err, pgx.ErrNoRows) {
		// Someone else owns this key. Nothing here is ours to roll back.
		_ = tx.Rollback(ctx)
		return s.replay(ctx, key, hash)
	}
	if err != nil {
		return Outcome{}, err
	}

	// ---- WINNER ------------------------------------------------------------
	resp := CreatePaymentResponse{
		PaymentID: uuid.NewString(),
		Amount:    req.Amount,
		Currency:  req.Currency,
		Reference: req.Reference,
		Status:    "succeeded",
		CreatedAt: time.Now().UTC(),
	}

	if _, err = tx.Exec(ctx, `
		INSERT INTO payments (id, idempotency_key, amount, currency, reference, created_at)
		VALUES ($1,$2,$3,$4,$5,$6)`,
		resp.PaymentID, key, resp.Amount, resp.Currency, resp.Reference, resp.CreatedAt,
	); err != nil {
		return Outcome{}, err
	}

	out, err := json.Marshal(resp)
	if err != nil {
		return Outcome{}, err
	}

	// Store the exact bytes that go back to this caller, so every later replay
	// is byte-identical rather than regenerated from the row.
	if _, err = tx.Exec(ctx, `
		UPDATE idempotency_keys
		   SET status = 'completed', response_code = 201, response_body = $2
		 WHERE key = $1`, key, out,
	); err != nil {
		return Outcome{}, err
	}

	// Payment and key become visible in the same instant.
	if err = tx.Commit(ctx); err != nil {
		return Outcome{}, err
	}
	return Outcome{Code: 201, Body: out}, nil
}

// replay serves a request whose key was already claimed by someone else.
func (s *Store) replay(ctx context.Context, key string, hash []byte) (Outcome, error) {
	var (
		gotHash []byte
		status  string
		code    *int
		body    []byte
	)
	err := s.pool.QueryRow(ctx, `
		SELECT request_hash, status, response_code, response_body
		  FROM idempotency_keys WHERE key = $1`, key).
		Scan(&gotHash, &status, &code, &body)

	// The claim conflicted but the row is invisible, so the winner is holding
	// an uncommitted insert. There is no stored response to return yet.
	if errors.Is(err, pgx.ErrNoRows) {
		return Outcome{InProgress: true}, nil
	}
	if err != nil {
		return Outcome{}, err
	}
	if string(gotHash) != string(hash) {
		return Outcome{Mismatch: true}, nil
	}
	if status != "completed" {
		return Outcome{InProgress: true}, nil
	}
	return Outcome{Code: *code, Body: body, Replayed: true}, nil
}

// CountPayments reports how many payment rows exist for a key. Used by the proof.
func (s *Store) CountPayments(ctx context.Context, key string) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM payments WHERE idempotency_key = $1`, key).Scan(&n)
	return n, err
}