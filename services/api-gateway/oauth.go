package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"golang.org/x/oauth2"
)

type oauthState struct {
	Provider string `json:"provider"`
	Verifier string `json:"verifier"`
	Redirect string `json:"redirect"`
}
type oauthProfile struct {
	ID, Email, Name string
	Image           *string
	EmailVerified   bool
}

func (b *backend) oauthConfig(provider string) (*oauth2.Config, error) {
	cfg := &oauth2.Config{RedirectURL: strings.TrimRight(b.config.authURL, "/") + "/api/auth/callback/" + provider}
	switch provider {
	case "github":
		cfg.ClientID = os.Getenv("GITHUB_CLIENT_ID")
		cfg.ClientSecret = os.Getenv("GITHUB_CLIENT_SECRET")
		cfg.Endpoint = oauth2.Endpoint{AuthURL: "https://github.com/login/oauth/authorize", TokenURL: "https://github.com/login/oauth/access_token"}
		cfg.Scopes = []string{"read:user", "user:email"}
	case "google":
		cfg.ClientID = os.Getenv("GOOGLE_CLIENT_ID")
		cfg.ClientSecret = os.Getenv("GOOGLE_CLIENT_SECRET")
		cfg.Endpoint = oauth2.Endpoint{AuthURL: "https://accounts.google.com/o/oauth2/v2/auth", TokenURL: "https://oauth2.googleapis.com/token"}
		cfg.Scopes = []string{"openid", "email", "profile"}
	default:
		return nil, &apiError{400, "PROVIDER_NOT_FOUND", "Unknown OAuth provider"}
	}
	if cfg.ClientID == "" || cfg.ClientSecret == "" {
		return nil, &apiError{400, "PROVIDER_NOT_CONFIGURED", "OAuth provider is not configured"}
	}
	return cfg, nil
}
func (b *backend) oauthCookieName() string {
	if strings.HasPrefix(b.config.authURL, "https://") {
		return "__Secure-fluxmedia.oauth_state"
	}
	return "fluxmedia.oauth_state"
}
func (b *backend) handleSocialSignIn(w http.ResponseWriter, r *http.Request) error {
	noStore(w)
	if err := b.checkOrigin(r); err != nil {
		return err
	}
	if err := b.authRateLimit(r, "social-sign-in", 20); err != nil {
		return err
	}
	var in struct {
		Provider           string `json:"provider"`
		CallbackURL        string `json:"callbackURL"`
		ErrorCallbackURL   string `json:"errorCallbackURL"`
		NewUserCallbackURL string `json:"newUserCallbackURL"`
		DisableRedirect    bool   `json:"disableRedirect"`
		RequestSignUp      bool   `json:"requestSignUp"`
	}
	if err := decodeBody(r, &in); err != nil {
		return err
	}
	cfg, err := b.oauthConfig(in.Provider)
	if err != nil {
		return err
	}
	redirect, err := b.safeRedirect(in.CallbackURL)
	if err != nil {
		return err
	}
	if redirect == "" {
		redirect = b.config.authURL
	}
	if in.NewUserCallbackURL != "" || in.ErrorCallbackURL != "" {
		return invalid("This application uses callbackURL for OAuth callbacks")
	}
	state, err := randomToken(24)
	if err != nil {
		return err
	}
	verifier, err := randomToken(32)
	if err != nil {
		return err
	}
	value, err := json.Marshal(oauthState{Provider: in.Provider, Verifier: verifier, Redirect: redirect})
	if err != nil {
		return err
	}
	if _, err := b.db.Exec(r.Context(), `INSERT INTO verification(id,identifier,value,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')`, newRequestID(), "fluxmedia-oauth:"+state, string(value)); err != nil {
		return err
	}
	cookie := &http.Cookie{Name: b.oauthCookieName(), Value: signSessionToken(state, b.config.authSecret), Path: "/api/auth", HttpOnly: true, Secure: strings.HasPrefix(b.config.authURL, "https://"), SameSite: http.SameSiteLaxMode, MaxAge: 600}
	http.SetCookie(w, cookie)
	link := cfg.AuthCodeURL(state, oauth2.S256ChallengeOption(verifier))
	writeJSON(w, 200, map[string]any{"url": link, "redirect": !in.DisableRedirect})
	return nil
}
func readOAuthJSON(ctx context.Context, client *http.Client, target string, value any) error {
	request, err := http.NewRequestWithContext(ctx, "GET", target, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("OAuth profile request failed")
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return fmt.Errorf("OAuth profile request rejected")
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 1<<20))
	if err := decoder.Decode(value); err != nil {
		return fmt.Errorf("OAuth profile response invalid")
	}
	return nil
}
func loadOAuthProfile(ctx context.Context, provider string, client *http.Client) (oauthProfile, error) {
	if provider == "google" {
		var p struct {
			ID       string  `json:"sub"`
			Email    string  `json:"email"`
			Name     string  `json:"name"`
			Picture  *string `json:"picture"`
			Verified bool    `json:"email_verified"`
		}
		if err := readOAuthJSON(ctx, client, "https://openidconnect.googleapis.com/v1/userinfo", &p); err != nil {
			return oauthProfile{}, err
		}
		return oauthProfile{p.ID, normalizeEmail(p.Email), p.Name, p.Picture, p.Verified}, nil
	}
	var p struct {
		ID     int64   `json:"id"`
		Name   string  `json:"name"`
		Login  string  `json:"login"`
		Avatar *string `json:"avatar_url"`
	}
	if err := readOAuthJSON(ctx, client, "https://api.github.com/user", &p); err != nil {
		return oauthProfile{}, err
	}
	var emails []struct {
		Email    string `json:"email"`
		Primary  bool   `json:"primary"`
		Verified bool   `json:"verified"`
	}
	if err := readOAuthJSON(ctx, client, "https://api.github.com/user/emails", &emails); err != nil {
		return oauthProfile{}, err
	}
	if p.Name == "" {
		p.Name = p.Login
	}
	for _, email := range emails {
		if email.Primary && email.Verified {
			return oauthProfile{strconv.FormatInt(p.ID, 10), normalizeEmail(email.Email), p.Name, p.Avatar, true}, nil
		}
	}
	return oauthProfile{}, &apiError{403, "EMAIL_NOT_VERIFIED", "OAuth account needs a verified email"}
}
func (b *backend) handleOAuthCallback(w http.ResponseWriter, r *http.Request) error {
	noStore(w)
	provider := r.PathValue("provider")
	cfg, err := b.oauthConfig(provider)
	if err != nil {
		return err
	}
	state := r.URL.Query().Get("state")
	cookie, err := r.Cookie(b.oauthCookieName())
	if err != nil || state == "" || verifySessionCookie(cookie.Value, b.config.authSecret) != state {
		return &apiError{400, "INVALID_STATE", "Invalid OAuth state"}
	}
	code := r.URL.Query().Get("code")
	if code == "" || len(code) > 4096 {
		return invalid("OAuth authorization was not completed")
	}
	var raw string
	err = b.db.QueryRow(r.Context(), `DELETE FROM verification WHERE id=(SELECT id FROM verification WHERE identifier=$1 AND expires_at>now() LIMIT 1) RETURNING value`, "fluxmedia-oauth:"+state).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return &apiError{400, "INVALID_STATE", "Expired OAuth state"}
	}
	if err != nil {
		return err
	}
	var stored oauthState
	if err := json.Unmarshal([]byte(raw), &stored); err != nil || stored.Provider != provider {
		return invalid("Invalid OAuth provider state")
	}
	redirect, err := b.safeRedirect(stored.Redirect)
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: 30 * time.Second}
	if b.oauthHTTPClient != nil {
		client = b.oauthHTTPClient
	}
	ctx, cancel := context.WithTimeout(context.WithValue(r.Context(), oauth2.HTTPClient, client), 45*time.Second)
	defer cancel()
	token, err := cfg.Exchange(ctx, code, oauth2.VerifierOption(stored.Verifier))
	if err != nil {
		return &apiError{400, "OAUTH_EXCHANGE_FAILED", "OAuth authorization failed"}
	}
	profile, err := loadOAuthProfile(ctx, provider, cfg.Client(ctx, token))
	if err != nil {
		return err
	}
	if profile.ID == "" || profile.Email == "" || !profile.EmailVerified {
		return &apiError{403, "EMAIL_NOT_VERIFIED", "OAuth account needs a verified email"}
	}
	tx, err := b.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(tx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, provider+":"+profile.ID); err != nil {
		return err
	}
	var id string
	err = tx.QueryRow(ctx, `SELECT user_id FROM account WHERE provider_id=$1 AND account_id=$2 LIMIT 1`, provider, profile.ID).Scan(&id)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	newAccount := errors.Is(err, pgx.ErrNoRows)
	if newAccount {
		err = tx.QueryRow(ctx, `SELECT id FROM "user" WHERE lower(email)=$1 LIMIT 1 FOR UPDATE`, profile.Email).Scan(&id)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if errors.Is(err, pgx.ErrNoRows) {
			if err := b.registrationOpen(ctx); err != nil {
				return err
			}
			if err := validateRegistrationEmail(profile.Email); err != nil {
				return err
			}
			id = newRequestID()
			if _, err := tx.Exec(ctx, `INSERT INTO "user"(id,name,email,email_verified,image) VALUES($1,$2,$3,true,$4)`, id, profile.Name, profile.Email, profile.Image); err != nil {
				return registrationConflict(err)
			}
			if _, err := tx.Exec(ctx, `INSERT INTO registration_identity(id,email,user_id) VALUES($1,$2,$3)`, newRequestID(), canonicalEmail(profile.Email), id); err != nil {
				return registrationConflict(err)
			}
		}
	}
	user, err := scanUser(tx.QueryRow(ctx, `SELECT `+userColumns+` FROM "user" WHERE id=$1 FOR UPDATE`, id))
	if err != nil {
		return err
	}
	if user.Banned {
		return &apiError{403, "ACCOUNT_BANNED", "Account has been banned"}
	}
	if newAccount {
		if _, err := tx.Exec(ctx, `INSERT INTO account(id,account_id,provider_id,user_id,access_token,refresh_token,access_token_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)`, newRequestID(), profile.ID, provider, id, token.AccessToken, token.RefreshToken, token.Expiry); err != nil {
			return err
		}
	}
	session, err := b.createSession(ctx, tx, id, r, true)
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	b.setSessionCookie(w, session, true)
	http.SetCookie(w, &http.Cookie{Name: b.oauthCookieName(), Value: "", Path: "/api/auth", MaxAge: -1, HttpOnly: true, Secure: strings.HasPrefix(b.config.authURL, "https://"), SameSite: http.SameSiteLaxMode})
	http.Redirect(w, r, redirect, 302)
	return nil
}
