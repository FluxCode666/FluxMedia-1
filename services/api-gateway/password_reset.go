package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func (b *backend) handleRequestPasswordReset(w http.ResponseWriter, r *http.Request) error {
	noStore(w)
	if err := b.checkOrigin(r); err != nil {
		return err
	}
	if err := b.authRateLimit(r, "request-password-reset", 5); err != nil {
		return err
	}
	var in struct {
		Email      string `json:"email"`
		RedirectTo string `json:"redirectTo"`
	}
	if err := decodeBody(r, &in); err != nil {
		return err
	}
	redirect, err := b.safeRedirect(in.RedirectTo)
	if err != nil {
		return err
	}
	token, err := randomToken(24)
	if err != nil {
		return err
	}
	var id string
	err = b.db.QueryRow(r.Context(), `SELECT id FROM "user" WHERE lower(email)=$1 AND NOT banned`, normalizeEmail(in.Email)).Scan(&id)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if err == nil {
		verificationID := newRequestID()
		if _, err := b.db.Exec(r.Context(), `INSERT INTO verification(id,identifier,value,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')`, verificationID, "reset-password:"+token, id); err != nil {
			return err
		}
		link := strings.TrimRight(b.config.authURL, "/") + "/api/auth/reset-password/" + token + "?callbackURL=" + url.QueryEscape(redirect)
		if err := b.sendMail(r.Context(), outgoingMail{To: normalizeEmail(in.Email), Subject: "Reset your password - FluxMedia", HTML: authLinkHTML("Reset password", link)}); err != nil {
			_, cleanupErr := b.db.Exec(r.Context(), `DELETE FROM verification WHERE id=$1`, verificationID)
			return errors.Join(err, cleanupErr)
		}
	}
	writeJSON(w, 200, map[string]any{"status": true, "message": "If this email exists in our system, check your email for the reset link"})
	return nil
}
func (b *backend) handleResetPasswordCallback(w http.ResponseWriter, r *http.Request) error {
	noStore(w)
	raw := r.URL.Query().Get("callbackURL")
	if raw == "" {
		raw = "/reset-password"
	}
	redirect, err := b.safeRedirect(raw)
	if err != nil {
		return err
	}
	target, _ := url.Parse(redirect)
	query := target.Query()
	token := r.PathValue("token")
	var exists bool
	err = b.db.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM verification WHERE identifier=$1 AND expires_at>now())`, "reset-password:"+token).Scan(&exists)
	if err != nil {
		return err
	}
	if exists {
		query.Set("token", token)
	} else {
		query.Set("error", "INVALID_TOKEN")
	}
	target.RawQuery = query.Encode()
	http.Redirect(w, r, target.String(), 302)
	return nil
}
func (b *backend) handleResetPassword(w http.ResponseWriter, r *http.Request) error {
	noStore(w)
	if err := b.checkOrigin(r); err != nil {
		return err
	}
	if err := b.authRateLimit(r, "reset-password", 10); err != nil {
		return err
	}
	var in struct {
		Token       string `json:"token"`
		NewPassword string `json:"newPassword"`
	}
	if err := decodeBody(r, &in); err != nil {
		return err
	}
	if in.Token == "" {
		in.Token = r.URL.Query().Get("token")
	}
	if in.Token == "" || len(in.Token) > 512 {
		return &apiError{400, "INVALID_TOKEN", "Invalid token"}
	}
	if passwordLength(in.NewPassword) < 8 || passwordLength(in.NewPassword) > 128 {
		return invalid("密码长度应为 8–128 个字符")
	}
	password, err := hashPassword(r.Context(), in.NewPassword)
	if err != nil {
		return err
	}
	tx, err := b.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer rollback(tx)
	var userID string
	err = tx.QueryRow(r.Context(), `DELETE FROM verification WHERE id=(SELECT id FROM verification WHERE identifier=$1 AND expires_at>now() ORDER BY created_at DESC LIMIT 1 FOR UPDATE) RETURNING value`, "reset-password:"+in.Token).Scan(&userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return &apiError{400, "INVALID_TOKEN", "Invalid or expired token"}
	}
	if err != nil {
		return err
	}
	var banned bool
	if err := tx.QueryRow(r.Context(), `SELECT banned FROM "user" WHERE id=$1 FOR UPDATE`, userID).Scan(&banned); err != nil {
		return err
	}
	if banned {
		return forbidden()
	}
	tag, err := tx.Exec(r.Context(), `UPDATE account SET password=$2,updated_at=now() WHERE user_id=$1 AND provider_id='credential'`, userID, password)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		if _, err := tx.Exec(r.Context(), `INSERT INTO account(id,account_id,provider_id,user_id,password) VALUES($1,$2,'credential',$2,$3)`, newRequestID(), userID, password); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(r.Context(), `DELETE FROM session WHERE user_id=$1`, userID); err != nil {
		return err
	}
	if err := tx.Commit(r.Context()); err != nil {
		return err
	}
	clearSessionCookies(w, r)
	writeJSON(w, 200, map[string]bool{"status": true})
	return nil
}
func (b *backend) emailVerificationToken(email string) (string, error) {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256"}`))
	payload, err := json.Marshal(map[string]any{"email": email, "iat": time.Now().Unix(), "exp": time.Now().Add(time.Hour).Unix()})
	if err != nil {
		return "", err
	}
	value := header + "." + base64.RawURLEncoding.EncodeToString(payload)
	signature := hmac.New(sha256.New, []byte(b.config.authSecret))
	_, _ = signature.Write([]byte(value))
	return value + "." + base64.RawURLEncoding.EncodeToString(signature.Sum(nil)), nil
}
func (b *backend) verifiedEmailToken(token string) (string, error) {
	invalidToken := &apiError{400, "INVALID_TOKEN", "Invalid or expired token"}
	if len(token) > 4096 {
		return "", invalidToken
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return "", invalidToken
	}
	header, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return "", invalidToken
	}
	var algorithm struct {
		Alg string `json:"alg"`
	}
	if err := json.Unmarshal(header, &algorithm); err != nil || algorithm.Alg != "HS256" {
		return "", invalidToken
	}
	signature := hmac.New(sha256.New, []byte(b.config.authSecret))
	_, _ = signature.Write([]byte(parts[0] + "." + parts[1]))
	given, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || !hmac.Equal(given, signature.Sum(nil)) {
		return "", invalidToken
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", invalidToken
	}
	var claims struct {
		Email    string `json:"email"`
		Expires  int64  `json:"exp"`
		UpdateTo string `json:"updateTo"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil || claims.Expires <= time.Now().Unix() || claims.Email == "" || claims.UpdateTo != "" {
		return "", invalidToken
	}
	return claims.Email, nil
}
func (b *backend) handleSendVerificationEmail(w http.ResponseWriter, r *http.Request) error {
	if err := b.checkOrigin(r); err != nil {
		return err
	}
	if err := b.authRateLimit(r, "send-verification-email", 5); err != nil {
		return err
	}
	var in struct {
		Email       string `json:"email"`
		CallbackURL string `json:"callbackURL"`
	}
	if err := decodeBody(r, &in); err != nil {
		return err
	}
	redirect, err := b.safeRedirect(in.CallbackURL)
	if err != nil {
		return err
	}
	var exists bool
	if err := b.db.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM "user" WHERE lower(email)=$1 AND NOT banned AND NOT email_verified)`, normalizeEmail(in.Email)).Scan(&exists); err != nil {
		return err
	}
	if exists {
		token, err := b.emailVerificationToken(normalizeEmail(in.Email))
		if err != nil {
			return err
		}
		link := strings.TrimRight(b.config.authURL, "/") + "/api/auth/verify-email?token=" + url.QueryEscape(token) + "&callbackURL=" + url.QueryEscape(redirect)
		if err := b.sendMail(r.Context(), outgoingMail{To: normalizeEmail(in.Email), Subject: "Verify your email - FluxMedia", HTML: authLinkHTML("Verify email", link)}); err != nil {
			return err
		}
	}
	writeJSON(w, 200, map[string]bool{"status": true})
	return nil
}
func (b *backend) handleVerifyEmail(w http.ResponseWriter, r *http.Request) error {
	noStore(w)
	email, err := b.verifiedEmailToken(r.URL.Query().Get("token"))
	if err != nil {
		return err
	}
	redirect, err := b.safeRedirect(r.URL.Query().Get("callbackURL"))
	if err != nil {
		return err
	}
	tag, err := b.db.Exec(r.Context(), `UPDATE "user" SET email_verified=true,updated_at=now() WHERE lower(email)=$1 AND NOT banned`, email)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return &apiError{400, "USER_NOT_FOUND", "User not found"}
	}
	if redirect != "" {
		http.Redirect(w, r, redirect, 302)
	} else {
		writeJSON(w, 200, map[string]any{"status": true, "user": nil})
	}
	return nil
}
