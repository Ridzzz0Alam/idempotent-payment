package api

import (
	"encoding/json"
	"io"
	"net/http"

	"github.com/Ridzzz0Alam/idempotent-payment/internal/store"
)

type Server struct {
	Store    *store.Store
	Instance string
}

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /payments", s.createPayment)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	return mux
}

func (s *Server) createPayment(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Served-By", s.Instance)
	w.Header().Set("Content-Type", "application/json")

	key := r.Header.Get("Idempotency-Key")
	if key == "" {
		fail(w, http.StatusBadRequest, "missing Idempotency-Key header")
		return
	}

	raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		fail(w, http.StatusBadRequest, "unreadable body")
		return
	}

	var req store.CreatePaymentRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		fail(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.Amount <= 0 || req.Currency == "" {
		fail(w, http.StatusUnprocessableEntity, "amount must be positive and currency required")
		return
	}

	out, err := s.Store.Create(r.Context(), key, raw, req)
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal error")
		return
	}

	switch {
	case out.Mismatch:
		// Same key, different payload. Replaying the stored response here would
		// silently discard the caller's new request, so refuse instead.
		fail(w, http.StatusUnprocessableEntity, "idempotency key reused with a different payload")
	case out.InProgress:
		// The winning request holds the key but has not committed yet. There is
		// no response to replay, so say so honestly rather than inventing one.
		w.Header().Set("Retry-After", "1")
		fail(w, http.StatusConflict, "request with this idempotency key is still in flight")
	default:
		if out.Replayed {
			w.Header().Set("Idempotency-Replayed", "true")
		} else {
			w.Header().Set("Idempotency-Replayed", "false")
		}
		w.WriteHeader(out.Code)
		_, _ = w.Write(out.Body)
	}
}

func fail(w http.ResponseWriter, code int, msg string) {
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}