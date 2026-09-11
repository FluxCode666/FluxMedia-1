package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/mail"
	"net/smtp"
	"os"
	"strconv"
	"strings"
	"time"
)

type outgoingMail struct{ To, Subject, HTML string }

func (b *backend) sendMail(ctx context.Context, message outgoingMail) error {
	if b.mailDelivery != nil {
		return b.mailDelivery(ctx, message)
	}
	if os.Getenv("NODE_ENV") == "development" {
		// Preserve development simulation without logging reset tokens or OTPs.
		b.logger.InfoContext(ctx, "email delivery simulated in development")
		return nil
	}
	keys := []string{"EMAIL_PROVIDER", "EMAIL_FROM", "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_SECURE", "RESEND_API_KEY"}
	values := map[string]string{}
	for _, key := range keys {
		value, err := b.settingString(ctx, key, "")
		if err != nil {
			return err
		}
		values[key] = value
	}
	from := values["EMAIL_FROM"]
	if from == "" {
		from = "FluxMedia <support@media.flux-code.cc>"
	}
	sender, err := mail.ParseAddress(from)
	if err != nil {
		return fmt.Errorf("invalid mail sender")
	}
	recipient, err := mail.ParseAddress(message.To)
	if err != nil {
		return fmt.Errorf("invalid mail recipient")
	}
	if strings.ContainsAny(message.Subject, "\r\n") {
		return fmt.Errorf("invalid mail subject")
	}
	provider := values["EMAIL_PROVIDER"]
	if provider == "" {
		provider = "resend"
		if values["SMTP_HOST"] != "" && values["SMTP_USER"] != "" && values["SMTP_PASS"] != "" {
			provider = "smtp"
		}
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if provider == "resend" {
		if values["RESEND_API_KEY"] == "" {
			return fmt.Errorf("mail service not configured")
		}
		payload, err := json.Marshal(map[string]any{"from": from, "to": []string{recipient.Address}, "subject": message.Subject, "html": message.HTML})
		if err != nil {
			return err
		}
		request, err := http.NewRequestWithContext(ctx, "POST", "https://api.resend.com/emails", bytes.NewReader(payload))
		if err != nil {
			return err
		}
		request.Header.Set("Authorization", "Bearer "+values["RESEND_API_KEY"])
		request.Header.Set("Content-Type", "application/json")
		response, err := (&http.Client{Timeout: 30 * time.Second}).Do(request)
		if err != nil {
			return fmt.Errorf("mail delivery failed")
		}
		defer response.Body.Close()
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return fmt.Errorf("mail delivery rejected: status %d", response.StatusCode)
		}
		return nil
	}
	if provider != "smtp" || values["SMTP_HOST"] == "" {
		return fmt.Errorf("mail service not configured")
	}
	port := values["SMTP_PORT"]
	if port == "" {
		port = "465"
	}
	parsedPort, err := strconv.Atoi(port)
	if err != nil || parsedPort < 1 || parsedPort > 65535 {
		return fmt.Errorf("invalid SMTP port")
	}
	secure := port == "465"
	if value := values["SMTP_SECURE"]; value != "" {
		secure, err = strconv.ParseBool(value)
		if err != nil {
			return fmt.Errorf("invalid SMTP secure setting")
		}
	}
	address := net.JoinHostPort(values["SMTP_HOST"], port)
	tlsConfig := &tls.Config{ServerName: values["SMTP_HOST"], MinVersion: tls.VersionTLS12}
	var conn net.Conn
	if secure {
		conn, err = (&tls.Dialer{NetDialer: &net.Dialer{Timeout: 10 * time.Second}, Config: tlsConfig}).DialContext(ctx, "tcp", address)
	} else {
		conn, err = (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, "tcp", address)
	}
	if err != nil {
		return fmt.Errorf("SMTP connection failed")
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	if deadline, ok := ctx.Deadline(); ok {
		if err := conn.SetDeadline(deadline); err != nil {
			return err
		}
	}
	client, err := smtp.NewClient(conn, values["SMTP_HOST"])
	if err != nil {
		return fmt.Errorf("SMTP handshake failed")
	}
	defer client.Close()
	if !secure {
		if err := client.StartTLS(tlsConfig); err != nil {
			return fmt.Errorf("SMTP requires TLS")
		}
	}
	if values["SMTP_USER"] != "" {
		if err := client.Auth(smtp.PlainAuth("", values["SMTP_USER"], values["SMTP_PASS"], values["SMTP_HOST"])); err != nil {
			return fmt.Errorf("SMTP authentication failed")
		}
	}
	if err := client.Mail(sender.Address); err != nil {
		return fmt.Errorf("SMTP sender rejected")
	}
	if err := client.Rcpt(recipient.Address); err != nil {
		return fmt.Errorf("SMTP recipient rejected")
	}
	writer, err := client.Data()
	if err != nil {
		return fmt.Errorf("SMTP body rejected")
	}
	_, err = fmt.Fprintf(writer, "From: %s\r\nTo: %s\r\nSubject: %s\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n%s", sender.String(), recipient.String(), message.Subject, message.HTML)
	if err != nil {
		_ = writer.Close()
		return fmt.Errorf("SMTP write failed")
	}
	if err := writer.Close(); err != nil {
		return fmt.Errorf("SMTP delivery failed")
	}
	return client.Quit()
}
