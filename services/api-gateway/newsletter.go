package main

import (
	"github.com/jackc/pgx/v5"
	"net/http"
	"net/mail"
	"strings"
	"time"
)

func (b *backend) registerNewsletterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/newsletter/subscribe", b.endpoint(b.handleNewsletterSubscribe))
	mux.HandleFunc("POST /api/newsletter/unsubscribe", b.endpoint(b.handleNewsletterUnsubscribe))
	mux.HandleFunc("POST /api/newsletter/status", b.endpoint(b.handleNewsletterStatus))
}

func newsletterEmail(raw string) (string, error) {
	email := strings.ToLower(strings.TrimSpace(raw))
	parsed, err := mail.ParseAddress(email)
	if err != nil || parsed.Address != email || len(email) > 320 {
		return "", invalid("请输入有效的邮箱地址")
	}
	return email, nil
}

func (b *backend) handleNewsletterSubscribe(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Email string `json:"email"`
	}
	if err := decodeBody(r, &in); err != nil {
		return err
	}
	email, err := newsletterEmail(in.Email)
	if err != nil {
		return err
	}
	var id string
	var subscribed bool
	err = b.db.QueryRow(r.Context(), `SELECT id,is_subscribed FROM newsletter_subscriber WHERE email=$1`, email).Scan(&id, &subscribed)
	if err == nil {
		if subscribed {
			writeJSON(w, http.StatusOK, map[string]any{"success": true, "message": "You are already subscribed!", "alreadySubscribed": true})
			return nil
		}
		_, err = b.db.Exec(r.Context(), `UPDATE newsletter_subscriber SET is_subscribed=true,subscribed_at=now(),unsubscribed_at=NULL,updated_at=now() WHERE id=$1`, id)
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, map[string]any{"success": true, "message": "Welcome back! Your subscription has been reactivated.", "reactivated": true})
		return nil
	}
	if err != pgx.ErrNoRows {
		return err
	}
	_, err = b.db.Exec(r.Context(), `INSERT INTO newsletter_subscriber(id,email,is_subscribed,subscribed_at,updated_at) VALUES($1,$2,true,now(),now()) ON CONFLICT(email) DO NOTHING`, newRequestID(), email)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "message": "Thank you for subscribing!"})
	return nil
}

func (b *backend) handleNewsletterUnsubscribe(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Email string `json:"email"`
	}
	if err := decodeBody(r, &in); err != nil {
		return err
	}
	email, err := newsletterEmail(in.Email)
	if err != nil {
		return err
	}
	var id string
	var subscribed bool
	err = b.db.QueryRow(r.Context(), `SELECT id,is_subscribed FROM newsletter_subscriber WHERE email=$1`, email).Scan(&id, &subscribed)
	if err == pgx.ErrNoRows {
		writeJSON(w, http.StatusOK, map[string]any{"success": false, "message": "Email not found in our subscriber list."})
		return nil
	}
	if err != nil {
		return err
	}
	if !subscribed {
		writeJSON(w, http.StatusOK, map[string]any{"success": true, "message": "You are already unsubscribed.", "alreadyUnsubscribed": true})
		return nil
	}
	if _, err = b.db.Exec(r.Context(), `UPDATE newsletter_subscriber SET is_subscribed=false,unsubscribed_at=now(),updated_at=now() WHERE id=$1`, id); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "message": "You have been unsubscribed. We're sorry to see you go!"})
	return nil
}

func (b *backend) handleNewsletterStatus(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Email string `json:"email"`
	}
	if err := decodeBody(r, &in); err != nil {
		return err
	}
	email, err := newsletterEmail(in.Email)
	if err != nil {
		return err
	}
	var subscribed bool
	var subscribedAt *time.Time
	err = b.db.QueryRow(r.Context(), `SELECT is_subscribed,subscribed_at FROM newsletter_subscriber WHERE email=$1`, email).Scan(&subscribed, &subscribedAt)
	if err == pgx.ErrNoRows {
		writeJSON(w, http.StatusOK, map[string]any{"found": false, "isSubscribed": false})
		return nil
	}
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"found": true, "isSubscribed": subscribed, "subscribedAt": subscribedAt})
	return nil
}
