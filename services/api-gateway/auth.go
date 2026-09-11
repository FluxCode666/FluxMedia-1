package main

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/scrypt"
	"golang.org/x/text/unicode/norm"
)

type authUser struct {
	ID            string    `json:"id"`
	Name          string    `json:"name"`
	Email         string    `json:"email"`
	EmailVerified bool      `json:"emailVerified"`
	Image         *string   `json:"image"`
	Role          string    `json:"role"`
	Banned        bool      `json:"banned"`
	BannedReason  *string   `json:"bannedReason"`
	CreatedAt     time.Time `json:"createdAt"`
	UpdatedAt     time.Time `json:"updatedAt"`
}
type authSession struct {
	ID        string    `json:"id"`
	Token     string    `json:"token"`
	UserID    string    `json:"userId"`
	ExpiresAt time.Time `json:"expiresAt"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
	IPAddress *string   `json:"ipAddress"`
	UserAgent *string   `json:"userAgent"`
}
type sessionResponse struct {
	Session authSession `json:"session"`
	User    authUser    `json:"user"`
}

const userColumns = `id,name,email,email_verified,image,role,banned,banned_reason,created_at,updated_at`

func scanUser(row pgx.Row) (authUser, error) {
	var u authUser
	err := row.Scan(&u.ID, &u.Name, &u.Email, &u.EmailVerified, &u.Image, &u.Role, &u.Banned, &u.BannedReason, &u.CreatedAt, &u.UpdatedAt)
	return u, err
}

func passwordLength(password string) int { return len(utf16.Encode([]rune(password))) }

func randomToken(size int) (string, error) {
	data := make([]byte, size)
	if _, err := rand.Read(data); err != nil {
		return "", fmt.Errorf("generate token: %w", err)
	}
	return hex.EncodeToString(data), nil
}

// Better Auth uses NFKC and the ASCII hex salt, not the decoded salt bytes.
// Bound concurrent scrypt work to keep unauthenticated traffic within memory limits.
var passwordSlots = make(chan struct{}, 4)

func passwordKey(ctx context.Context, password, salt string) ([]byte, error) {
	select {
	case passwordSlots <- struct{}{}:
		defer func() { <-passwordSlots }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	return scrypt.Key([]byte(norm.NFKC.String(password)), []byte(salt), 16384, 16, 1, 64)
}
func hashPassword(ctx context.Context, password string) (string, error) {
	salt, err := randomToken(16)
	if err != nil {
		return "", err
	}
	key, err := passwordKey(ctx, password, salt)
	if err != nil {
		return "", err
	}
	return salt + ":" + hex.EncodeToString(key), nil
}
func verifyPassword(ctx context.Context, password, stored string) (bool, error) {
	salt, encoded, ok := strings.Cut(stored, ":")
	if !ok || len(salt) != 32 || len(encoded) != 128 {
		return false, nil
	}
	expected, err := hex.DecodeString(encoded)
	if err != nil {
		return false, nil
	}
	key, err := passwordKey(ctx, password, salt)
	if err != nil {
		return false, err
	}
	return subtle.ConstantTimeCompare(key, expected) == 1, nil
}
func signSessionToken(token, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(token))
	return token + "." + base64.StdEncoding.EncodeToString(mac.Sum(nil))
}
func verifySessionCookie(cookie, secret string) string {
	if secret == "" {
		return ""
	}
	value, err := url.PathUnescape(cookie)
	if err != nil {
		return ""
	}
	index := strings.LastIndexByte(value, '.')
	if index < 1 {
		return ""
	}
	token := value[:index]
	if len(token) > 256 {
		return ""
	}
	if !hmac.Equal([]byte(signSessionToken(token, secret)), []byte(value)) {
		return ""
	}
	return token
}
func (b *backend) cookieName() string {
	if strings.HasPrefix(b.config.authURL, "https://") {
		return "__Secure-better-auth.session_token"
	}
	return "better-auth.session_token"
}
func (b *backend) setSessionCookie(w http.ResponseWriter, session authSession, remember bool) {
	cookie := &http.Cookie{Name: b.cookieName(), Value: url.QueryEscape(signSessionToken(session.Token, b.config.authSecret)), Path: "/", Secure: strings.HasPrefix(b.config.authURL, "https://"), HttpOnly: true, SameSite: http.SameSiteLaxMode}
	if remember {
		cookie.Expires = session.ExpiresAt
		cookie.MaxAge = max(1, int(time.Until(session.ExpiresAt).Seconds()))
	}
	http.SetCookie(w, cookie)
}
func clearSessionCookies(w http.ResponseWriter, r *http.Request) {
	for _, cookie := range r.Cookies() {
		name := strings.TrimPrefix(cookie.Name, "__Secure-")
		if name == "better-auth.session_token" || name == "better-auth.session_data" || name == "better-auth.dont_remember" || strings.HasPrefix(name, "better-auth.session_data.") {
			http.SetCookie(w, &http.Cookie{Name: cookie.Name, Value: "", Path: "/", MaxAge: -1, Secure: strings.HasPrefix(cookie.Name, "__Secure-"), HttpOnly: true, SameSite: http.SameSiteLaxMode})
		}
	}
}
func (b *backend) sessionToken(r *http.Request) string {
	// An HTTPS deployment must never accept the insecure alternate cookie name.
	cookie, err := r.Cookie(b.cookieName())
	if err != nil {
		return ""
	}
	return verifySessionCookie(cookie.Value, b.config.authSecret)
}
func (b *backend) currentSession(r *http.Request) (*sessionResponse, error) {
	token := b.sessionToken(r)
	if token == "" {
		return nil, nil
	}
	var s sessionResponse
	err := b.db.QueryRow(r.Context(), `SELECT s.id,s.token,s.user_id,s.expires_at,s.created_at,s.updated_at,s.ip_address,s.user_agent,u.id,u.name,u.email,u.email_verified,u.image,u.role,u.banned,u.banned_reason,u.created_at,u.updated_at FROM session s JOIN "user" u ON u.id=s.user_id WHERE s.token=$1 AND s.expires_at>now()`, token).Scan(&s.Session.ID, &s.Session.Token, &s.Session.UserID, &s.Session.ExpiresAt, &s.Session.CreatedAt, &s.Session.UpdatedAt, &s.Session.IPAddress, &s.Session.UserAgent, &s.User.ID, &s.User.Name, &s.User.Email, &s.User.EmailVerified, &s.User.Image, &s.User.Role, &s.User.Banned, &s.User.BannedReason, &s.User.CreatedAt, &s.User.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("query session: %w", err)
	}
	return &s, nil
}
func (b *backend) requireSession(r *http.Request) (*sessionResponse, error) {
	s, err := b.currentSession(r)
	if err != nil {
		return nil, err
	}
	if s == nil {
		return nil, unauthorized()
	}
	if s.User.Banned {
		return nil, &apiError{403, "ACCOUNT_BANNED", "账号已被封禁"}
	}
	return s, nil
}
func (b *backend) handleSession(w http.ResponseWriter, r *http.Request) error {
	noStore(w)
	s, err := b.currentSession(r)
	if err != nil {
		return err
	}
	if s == nil {
		clearSessionCookies(w, r)
		writeJSON(w, 200, nil)
		return nil
	}
	// Match Better Auth's rolling one-day refresh without rewriting each read.
	if !s.User.Banned && time.Since(s.Session.UpdatedAt) >= 24*time.Hour && r.URL.Query().Get("disableSessionRefresh") != "true" {
		err = b.db.QueryRow(r.Context(), `UPDATE session SET expires_at=now()+interval '7 days',updated_at=now() WHERE id=$1 AND expires_at>now() RETURNING expires_at,updated_at`, s.Session.ID).Scan(&s.Session.ExpiresAt, &s.Session.UpdatedAt)
		if errors.Is(err, pgx.ErrNoRows) {
			clearSessionCookies(w, r)
			writeJSON(w, 200, nil)
			return nil
		}
		if err != nil {
			return err
		}
		b.setSessionCookie(w, s.Session, true)
	}
	if r.URL.Path == "/api/session/current" {
		writeJSON(w, 200, map[string]any{"session": s.Session, "user": map[string]any{"id": s.User.ID, "name": s.User.Name, "email": s.User.Email, "image": s.User.Image, "role": s.User.Role, "banned": s.User.Banned, "bannedReason": s.User.BannedReason}})
	} else {
		writeJSON(w, 200, s)
	}
	return nil
}
func (b *backend) createSession(ctx context.Context, tx pgx.Tx, userID string, r *http.Request, remember bool) (authSession, error) {
	token, err := randomToken(32)
	if err != nil {
		return authSession{}, err
	}
	id, err := randomToken(16)
	if err != nil {
		return authSession{}, err
	}
	duration := 7 * 24 * time.Hour
	if !remember {
		duration = 24 * time.Hour
	}
	ip, _, _ := net.SplitHostPort(r.RemoteAddr)
	agent := r.UserAgent()
	s := authSession{ID: id, Token: token, UserID: userID, ExpiresAt: time.Now().UTC().Add(duration), IPAddress: &ip, UserAgent: &agent}
	err = tx.QueryRow(ctx, `INSERT INTO session(id,token,user_id,expires_at,ip_address,user_agent) VALUES($1,$2,$3,$4,$5,$6) RETURNING created_at,updated_at`, id, token, userID, s.ExpiresAt, ip, agent).Scan(&s.CreatedAt, &s.UpdatedAt)
	return s, err
}
func (b *backend) authRateLimit(r *http.Request, scope string, limit int) error {
	ip, _, _ := net.SplitHostPort(r.RemoteAddr)
	digest := sha256.Sum256([]byte(scope + ":" + ip))
	key := "fluxmedia:go:auth-rate:" + hex.EncodeToString(digest[:])
	n, err := b.redis.Eval(r.Context(), `local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n`, []string{key}).Int()
	if err != nil {
		return fmt.Errorf("auth rate limit: %w", err)
	}
	if n > limit {
		return &apiError{429, "TOO_MANY_REQUESTS", "请求过于频繁，请稍后重试"}
	}
	return nil
}
func (b *backend) safeRedirect(raw string) (string, error) {
	base, err := url.Parse(b.config.authURL)
	if err != nil {
		return "", invalid("登录地址配置无效")
	}
	if raw == "" {
		return "", nil
	}
	dest, err := url.Parse(raw)
	if err != nil {
		return "", invalid("跳转地址无效")
	}
	dest = base.ResolveReference(dest)
	if dest.User != nil || (dest.Scheme != "https" && dest.Scheme != "http") {
		return "", invalid("跳转地址无效")
	}
	allowed := dest.Scheme == base.Scheme && dest.Host == base.Host
	for _, origin := range b.config.trustedOrigins {
		if dest.Scheme+"://"+dest.Host == origin {
			allowed = true
		}
	}
	if !allowed {
		return "", invalid("跳转地址不受信任")
	}
	return dest.String(), nil
}
func (b *backend) checkOrigin(r *http.Request) error {
	origin := r.Header.Get("Origin")
	if origin == "" || origin == "null" {
		return nil
	} // Keep existing embedded-browser flows.
	target, err := b.safeRedirect(origin)
	if err != nil || target == "" {
		return forbidden()
	}
	return nil
}
func (b *backend) handleSignIn(w http.ResponseWriter, r *http.Request) error {
	noStore(w)
	if err := b.checkOrigin(r); err != nil {
		return err
	}
	if err := b.authRateLimit(r, "sign-in", 10); err != nil {
		return err
	}
	var in struct {
		Email       string `json:"email"`
		Password    string `json:"password"`
		CallbackURL string `json:"callbackURL"`
		RememberMe  *bool  `json:"rememberMe"`
	}
	if err := decodeBody(r, &in); err != nil {
		return err
	}
	if passwordLength(in.Password) > 128 || len(in.Email) > 320 {
		return invalid("邮箱或密码无效")
	}
	redirect, err := b.safeRedirect(in.CallbackURL)
	if err != nil {
		return err
	}
	var id, password string
	err = b.db.QueryRow(r.Context(), `SELECT u.id,a.password FROM "user" u JOIN account a ON a.user_id=u.id AND a.provider_id='credential' WHERE lower(u.email)=$1 LIMIT 1`, strings.ToLower(strings.TrimSpace(in.Email))).Scan(&id, &password)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if errors.Is(err, pgx.ErrNoRows) {
		password = strings.Repeat("0", 32) + ":" + strings.Repeat("0", 128)
	}
	valid, err := verifyPassword(r.Context(), in.Password, password)
	if err != nil {
		return err
	}
	if !valid || id == "" {
		return &apiError{401, "INVALID_EMAIL_OR_PASSWORD", "Invalid email or password"}
	}
	tx, err := b.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer rollback(tx)
	user, err := scanUser(tx.QueryRow(r.Context(), `SELECT `+userColumns+` FROM "user" WHERE id=$1 FOR UPDATE`, id))
	if err != nil {
		return err
	}
	if user.Banned {
		return &apiError{403, "ACCOUNT_BANNED", "Account has been banned"}
	}
	var unchanged bool
	if err := tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM account WHERE user_id=$1 AND provider_id='credential' AND password=$2)`, id, password).Scan(&unchanged); err != nil {
		return err
	}
	if !unchanged {
		return &apiError{401, "INVALID_EMAIL_OR_PASSWORD", "Invalid email or password"}
	}
	remember := in.RememberMe == nil || *in.RememberMe
	session, err := b.createSession(r.Context(), tx, id, r, remember)
	if err != nil {
		return err
	}
	if err := tx.Commit(r.Context()); err != nil {
		return err
	}
	b.setSessionCookie(w, session, remember)
	writeJSON(w, 200, map[string]any{"redirect": redirect != "", "token": session.Token, "url": redirect, "user": user})
	return nil
}
func rollback(tx pgx.Tx) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = tx.Rollback(ctx)
}
func (b *backend) handleSignOut(w http.ResponseWriter, r *http.Request) error {
	noStore(w)
	if err := b.checkOrigin(r); err != nil {
		return err
	}
	token := b.sessionToken(r)
	if token != "" {
		if _, err := b.db.Exec(r.Context(), `DELETE FROM session WHERE token=$1`, token); err != nil {
			return err
		}
	}
	clearSessionCookies(w, r)
	writeJSON(w, 200, map[string]bool{"success": true})
	return nil
}
func (b *backend) handleUpdateUser(w http.ResponseWriter, r *http.Request) error {
	noStore(w)
	if err := b.checkOrigin(r); err != nil {
		return err
	}
	s, err := b.requireSession(r)
	if err != nil {
		return err
	}
	var in struct {
		Name  *string `json:"name"`
		Image *string `json:"image"`
	}
	if err := decodeBody(r, &in); err != nil {
		return err
	}
	if in.Name != nil && (utf8.RuneCountInString(strings.TrimSpace(*in.Name)) < 2 || utf8.RuneCountInString(*in.Name) > 50) {
		return invalid("名称长度应为 2–50 个字符")
	}
	if in.Image != nil {
		// Avatar values are storage keys (for example avatars/<user-id>/file.webp)
		// in the existing database contract. Absolute URLs remain accepted for
		// compatibility with older records, but arbitrary schemes are rejected.
		image := strings.TrimSpace(*in.Image)
		u, err := url.Parse(image)
		if len(image) > 4096 || err != nil || (u.IsAbs() && u.Scheme != "https" && u.Scheme != "http") || (!u.IsAbs() && (image == "" || strings.ContainsAny(image, "\r\n\\"))) {
			return invalid("头像地址无效")
		}
		in.Image = &image
	}
	_, err = b.db.Exec(r.Context(), `UPDATE "user" SET name=COALESCE($2,name),image=COALESCE($3,image),updated_at=now() WHERE id=$1`, s.User.ID, in.Name, in.Image)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]bool{"status": true}})
	return nil
}

func (b *backend) handleUpdateTimeZone(w http.ResponseWriter, r *http.Request) error {
	noStore(w)
	if err := b.checkOrigin(r); err != nil {
		return err
	}
	s, err := b.requireSession(r)
	if err != nil {
		return err
	}
	var in struct {
		TimeZone *string `json:"timeZone"`
	}
	if err := decodeBody(r, &in); err != nil {
		return err
	}
	var value *string
	if in.TimeZone != nil {
		trimmed := strings.TrimSpace(*in.TimeZone)
		if trimmed == "" {
			return invalid("时区不能为空")
		}
		if len(trimmed) > 100 {
			return invalid("时区名称过长")
		}
		if _, err := time.LoadLocation(trimmed); err != nil {
			return invalid("无效的 IANA 时区")
		}
		value = &trimmed
	}
	if _, err := b.db.Exec(r.Context(), `UPDATE "user" SET time_zone=$2,updated_at=now() WHERE id=$1`, s.User.ID, value); err != nil {
		return err
	}
	defaultZone, err := b.settingString(r.Context(), "APP_TIME_ZONE", "UTC")
	if err != nil {
		return err
	}
	if _, err := time.LoadLocation(defaultZone); err != nil {
		defaultZone = "UTC"
	}
	effective := defaultZone
	if value != nil {
		effective = *value
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{
		"timeZone": value, "defaultTimeZone": defaultZone, "effectiveTimeZone": effective,
	}})
	return nil
}

func (b *backend) handleMyCreditsBalance(w http.ResponseWriter, r *http.Request) error {
	noStore(w)
	if err := b.checkOrigin(r); err != nil {
		return err
	}
	s, err := b.requireSession(r)
	if err != nil {
		return err
	}
	// credits_balance.balance is numeric(18,2) after migration 0007; scanning it
	// into an integer makes pgx reject authenticated requests with a 500 response.
	var balance float64
	err = b.db.QueryRow(r.Context(), `SELECT COALESCE(balance, 0) FROM credits_balance WHERE user_id=$1`, s.User.ID).Scan(&balance)
	if errors.Is(err, pgx.ErrNoRows) {
		balance = 0
	} else if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"balance": balance}})
	return nil
}
func (b *backend) handleChangePassword(w http.ResponseWriter, r *http.Request) error {
	if err := b.checkOrigin(r); err != nil {
		return err
	}
	if err := b.authRateLimit(r, "change-password", 10); err != nil {
		return err
	}
	s, err := b.requireSession(r)
	if err != nil {
		return err
	}
	var in struct {
		CurrentPassword     string `json:"currentPassword"`
		NewPassword         string `json:"newPassword"`
		RevokeOtherSessions bool   `json:"revokeOtherSessions"`
	}
	if err := decodeBody(r, &in); err != nil {
		return err
	}
	if passwordLength(in.CurrentPassword) > 128 || passwordLength(in.NewPassword) < 8 || passwordLength(in.NewPassword) > 128 {
		return invalid("密码长度应为 8–128 个字符")
	}
	var old string
	if err := b.db.QueryRow(r.Context(), `SELECT password FROM account WHERE user_id=$1 AND provider_id='credential'`, s.User.ID).Scan(&old); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return invalid("未设置密码")
		}
		return err
	}
	valid, err := verifyPassword(r.Context(), in.CurrentPassword, old)
	if err != nil {
		return err
	}
	if !valid {
		return &apiError{400, "INVALID_PASSWORD", "密码错误"}
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
	tag, err := tx.Exec(r.Context(), `UPDATE account SET password=$2,updated_at=now() WHERE user_id=$1 AND provider_id='credential' AND password=$3`, s.User.ID, password, old)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return &apiError{409, "PASSWORD_CHANGED", "密码已变更，请重新登录"}
	}
	if in.RevokeOtherSessions {
		if _, err := tx.Exec(r.Context(), `DELETE FROM session WHERE user_id=$1 AND id<>$2`, s.User.ID, s.Session.ID); err != nil {
			return err
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"token": nil, "user": s.User})
	return nil
}
func (b *backend) handleListSessions(w http.ResponseWriter, r *http.Request) error {
	noStore(w)
	s, err := b.requireSession(r)
	if err != nil {
		return err
	}
	rows, err := b.db.Query(r.Context(), `SELECT id,token,user_id,expires_at,created_at,updated_at,ip_address,user_agent FROM session WHERE user_id=$1 AND expires_at>now() ORDER BY created_at DESC`, s.User.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	sessions := []authSession{}
	for rows.Next() {
		var item authSession
		if err := rows.Scan(&item.ID, &item.Token, &item.UserID, &item.ExpiresAt, &item.CreatedAt, &item.UpdatedAt, &item.IPAddress, &item.UserAgent); err != nil {
			return err
		}
		sessions = append(sessions, item)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	writeJSON(w, 200, sessions)
	return nil
}
func (b *backend) handleRevokeSessions(w http.ResponseWriter, r *http.Request) error {
	if err := b.checkOrigin(r); err != nil {
		return err
	}
	s, err := b.requireSession(r)
	if err != nil {
		return err
	}
	switch r.URL.Path {
	case "/api/auth/revoke-session":
		var in struct {
			Token string `json:"token"`
		}
		if err := decodeBody(r, &in); err != nil {
			return err
		}
		_, err = b.db.Exec(r.Context(), `DELETE FROM session WHERE user_id=$1 AND token=$2`, s.User.ID, in.Token)
	case "/api/auth/revoke-other-sessions":
		_, err = b.db.Exec(r.Context(), `DELETE FROM session WHERE user_id=$1 AND id<>$2`, s.User.ID, s.Session.ID)
	default:
		_, err = b.db.Exec(r.Context(), `DELETE FROM session WHERE user_id=$1`, s.User.ID)
	}
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]bool{"status": true})
	return nil
}
func (b *backend) registerAuth(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/auth/sign-in/social", b.endpoint(b.handleSocialSignIn))
	mux.HandleFunc("GET /api/auth/callback/{provider}", b.endpoint(b.handleOAuthCallback))
	mux.HandleFunc("POST /api/auth/sign-up/email", b.endpoint(b.handleSignUp))
	mux.HandleFunc("POST /api/auth/registration-verification", b.endpoint(b.handleRegistrationCode))
	mux.HandleFunc("POST /api/auth/request-password-reset", b.endpoint(b.handleRequestPasswordReset))
	mux.HandleFunc("GET /api/auth/reset-password/{token}", b.endpoint(b.handleResetPasswordCallback))
	mux.HandleFunc("POST /api/auth/reset-password", b.endpoint(b.handleResetPassword))
	mux.HandleFunc("POST /api/auth/send-verification-email", b.endpoint(b.handleSendVerificationEmail))
	mux.HandleFunc("GET /api/auth/verify-email", b.endpoint(b.handleVerifyEmail))
	mux.HandleFunc("GET /api/auth/get-session", b.endpoint(b.handleSession))
	mux.HandleFunc("GET /api/session/current", b.endpoint(b.handleSession))
	mux.HandleFunc("POST /api/session/current", b.endpoint(b.handleSession))
	mux.HandleFunc("POST /api/auth/sign-in/email", b.endpoint(b.handleSignIn))
	mux.HandleFunc("POST /api/auth/sign-out", b.endpoint(b.handleSignOut))
	mux.HandleFunc("POST /api/auth/update-user", b.endpoint(b.handleUpdateUser))
	mux.HandleFunc("POST /api/user/time-zone", b.endpoint(b.handleUpdateTimeZone))
	mux.HandleFunc("GET /api/user/credits", b.endpoint(b.handleMyCreditsBalance))
	mux.HandleFunc("POST /api/auth/change-password", b.endpoint(b.handleChangePassword))
	mux.HandleFunc("GET /api/auth/list-sessions", b.endpoint(b.handleListSessions))
	for _, path := range []string{"revoke-session", "revoke-sessions", "revoke-other-sessions"} {
		mux.HandleFunc("POST /api/auth/"+path, b.endpoint(b.handleRevokeSessions))
	}
}
