package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"math/big"
	"net/http"
	"net/mail"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func normalizeEmail(email string) string { return strings.ToLower(strings.TrimSpace(email)) }
func canonicalEmail(email string) string {
	email = normalizeEmail(email)
	local, domain, ok := strings.Cut(email, "@")
	if !ok {
		return email
	}
	if index := strings.IndexByte(local, '+'); index >= 0 {
		local = local[:index]
	}
	if domain == "gmail.com" || domain == "googlemail.com" {
		local = strings.ReplaceAll(local, ".", "")
	}
	if local == "" {
		return email
	}
	return local + "@" + domain
}
func validateRegistrationEmail(email string) error {
	address, err := mail.ParseAddress(email)
	if err != nil || address.Address != email || len(email) > 320 {
		return invalid("Invalid email address")
	}
	_, domain, _ := strings.Cut(email, "@")
	switch domain {
	case "163.com", "126.com", "qq.com", "gmail.com":
		return nil
	}
	return &apiError{400, "EMAIL_DOMAIN_NOT_ALLOWED", "Please use one of these email domains: 163.com, 126.com, qq.com, gmail.com."}
}
func (b *backend) registrationOpen(ctx context.Context) error {
	enabled, err := b.settingBool(ctx, "SELF_USE_MODE_ENABLED", true)
	if err != nil {
		return err
	}
	if enabled {
		return &apiError{403, "REGISTRATION_DISABLED", "Registration is disabled in self-use mode"}
	}
	return nil
}
func (b *backend) registrationEmailTaken(ctx context.Context, email string) (bool, error) {
	var exists bool
	err := b.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM registration_identity WHERE email=$1) OR EXISTS(SELECT 1 FROM "user" WHERE lower(email)=$2)`, canonicalEmail(email), email).Scan(&exists)
	return exists, err
}
func (b *backend) handleRegistrationCode(w http.ResponseWriter, r *http.Request) error {
	if err := b.checkOrigin(r); err != nil {
		return err
	}
	if err := b.authRateLimit(r, "registration-code", 10); err != nil {
		return err
	}
	if err := b.registrationOpen(r.Context()); err != nil {
		return err
	}
	var in struct {
		Email string `json:"email"`
	}
	if err := decodeBody(r, &in); err != nil {
		return err
	}
	email := normalizeEmail(in.Email)
	if err := validateRegistrationEmail(email); err != nil {
		return err
	}
	taken, err := b.registrationEmailTaken(r.Context(), email)
	if err != nil {
		return err
	}
	if taken {
		return &apiError{400, "EMAIL_ALREADY_REGISTERED", "Email already registered"}
	}
	n, err := rand.Int(rand.Reader, big.NewInt(1000000))
	if err != nil {
		return err
	}
	code := fmt.Sprintf("%06d", n.Int64())
	id := newRequestID()
	identifier := "registration-email-code:" + email
	tx, err := b.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer rollback(tx)
	if _, err := tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, identifier); err != nil {
		return err
	}
	var createdAt time.Time
	err = tx.QueryRow(r.Context(), `SELECT created_at FROM verification WHERE identifier=$1 ORDER BY created_at DESC LIMIT 1`, identifier).Scan(&createdAt)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if err == nil && time.Since(createdAt) < time.Minute {
		return &apiError{429, "VERIFICATION_COOLDOWN", "Please wait before requesting another code"}
	}
	if _, err := tx.Exec(r.Context(), `DELETE FROM verification WHERE identifier=$1`, identifier); err != nil {
		return err
	}
	if _, err := tx.Exec(r.Context(), `INSERT INTO verification(id,identifier,value,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')`, id, identifier, code+"|0"); err != nil {
		return err
	}
	if err := tx.Commit(r.Context()); err != nil {
		return err
	}
	if err := b.sendMail(r.Context(), outgoingMail{To: email, Subject: "Your FluxMedia verification code", HTML: "<p>Verification code: <strong>" + code + "</strong></p><p>Expires in 10 minutes.</p>"}); err != nil {
		_, cleanupErr := b.db.Exec(r.Context(), `DELETE FROM verification WHERE id=$1`, id)
		return errors.Join(err, cleanupErr)
	}
	writeJSON(w, 200, map[string]bool{"success": true})
	return nil
}
func consumeRegistrationCode(ctx context.Context, tx pgx.Tx, email, code string) (bool, error) {
	var id, value string
	var expires time.Time
	err := tx.QueryRow(ctx, `SELECT id,value,expires_at FROM verification WHERE identifier=$1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, "registration-email-code:"+email).Scan(&id, &value, &expires)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	stored, attemptsText, _ := strings.Cut(value, "|")
	attempts, _ := strconv.Atoi(attemptsText)
	valid := expires.After(time.Now()) && attempts < 5 && subtle.ConstantTimeCompare([]byte(stored), []byte(strings.TrimSpace(code))) == 1
	if valid || !expires.After(time.Now()) || attempts >= 4 {
		_, err = tx.Exec(ctx, `DELETE FROM verification WHERE id=$1`, id)
	} else {
		_, err = tx.Exec(ctx, `UPDATE verification SET value=$2,updated_at=now() WHERE id=$1`, id, stored+"|"+strconv.Itoa(attempts+1))
	}
	return valid, err
}
func (b *backend) handleSignUp(w http.ResponseWriter, r *http.Request) error {
	noStore(w)
	if err := b.checkOrigin(r); err != nil {
		return err
	}
	if err := b.authRateLimit(r, "sign-up", 10); err != nil {
		return err
	}
	if err := b.registrationOpen(r.Context()); err != nil {
		return err
	}
	var in struct {
		Email            string  `json:"email"`
		Password         string  `json:"password"`
		Name             string  `json:"name"`
		VerificationCode string  `json:"verificationCode"`
		Image            *string `json:"image"`
		CallbackURL      string  `json:"callbackURL"`
		RememberMe       *bool   `json:"rememberMe"`
	}
	if err := decodeBody(r, &in); err != nil {
		return err
	}
	in.Email = normalizeEmail(in.Email)
	if err := validateRegistrationEmail(in.Email); err != nil {
		return err
	}
	if passwordLength(in.Password) < 8 || passwordLength(in.Password) > 128 || strings.TrimSpace(in.Name) == "" || utf8.RuneCountInString(in.Name) > 100 {
		return invalid("Invalid name or password")
	}
	if _, err := b.safeRedirect(in.CallbackURL); err != nil {
		return err
	}
	if in.VerificationCode == "" {
		return &apiError{400, "VERIFICATION_CODE_REQUIRED", "Verification code is required"}
	}
	taken, err := b.registrationEmailTaken(r.Context(), in.Email)
	if err != nil {
		return err
	}
	if taken {
		return &apiError{400, "EMAIL_ALREADY_REGISTERED", "Email already registered"}
	}
	password, err := hashPassword(r.Context(), in.Password)
	if err != nil {
		return err
	}
	tx, err := b.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer rollback(tx)
	valid, err := consumeRegistrationCode(r.Context(), tx, in.Email, in.VerificationCode)
	if err != nil {
		return err
	}
	if !valid {
		if err := tx.Commit(r.Context()); err != nil {
			return err
		}
		return &apiError{400, "INVALID_VERIFICATION_CODE", "Invalid or expired verification code"}
	}
	id := newRequestID()
	user, err := scanUser(tx.QueryRow(r.Context(), `INSERT INTO "user"(id,name,email,email_verified,image) VALUES($1,$2,$3,true,$4) RETURNING `+userColumns, id, in.Name, in.Email, in.Image))
	if err != nil {
		return registrationConflict(err)
	}
	if _, err := tx.Exec(r.Context(), `INSERT INTO registration_identity(id,email,user_id) VALUES($1,$2,$3)`, newRequestID(), canonicalEmail(in.Email), id); err != nil {
		return registrationConflict(err)
	}
	if _, err := tx.Exec(r.Context(), `INSERT INTO account(id,account_id,provider_id,user_id,password) VALUES($1,$2,'credential',$2,$3)`, newRequestID(), id, password); err != nil {
		return err
	}
	if cookie, err := r.Cookie("fluxmedia_referral_code"); err == nil && len(cookie.Value) <= 100 {
		config, err := b.setting(r.Context(), "REFERRAL_REWARD_CONFIG", map[string]any{"enabled": false, "inviter": map[string]any{"mode": "percentage", "value": 10}, "invitee": map[string]any{"mode": "percentage", "value": 10}})
		if err != nil {
			return err
		}
		encoded, err := json.Marshal(config)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(r.Context(), `INSERT INTO referral_relationship(id,inviter_user_id,invitee_user_id,referral_code,reward_config_snapshot) SELECT $1,user_id,$2,code,$3::json FROM referral_profile WHERE code=$4 AND user_id<>$2 ON CONFLICT(invitee_user_id) DO NOTHING`, newRequestID(), id, encoded, cookie.Value); err != nil {
			return err
		}
	}
	remember := in.RememberMe == nil || *in.RememberMe
	session, err := b.createSession(r.Context(), tx, id, r, remember)
	if err != nil {
		return err
	}
	if err := tx.Commit(r.Context()); err != nil {
		return registrationConflict(err)
	}
	b.setSessionCookie(w, session, remember)
	writeJSON(w, 200, map[string]any{"token": session.Token, "user": user})
	return nil
}
func registrationConflict(err error) error {
	var pgError *pgconn.PgError
	if errors.As(err, &pgError) && pgError.Code == "23505" {
		return &apiError{400, "EMAIL_ALREADY_REGISTERED", "Email already registered"}
	}
	return err
}
func authLinkHTML(label, link string) string {
	return "<p><a href=\"" + html.EscapeString(link) + "\">" + html.EscapeString(label) + "</a></p>"
}
