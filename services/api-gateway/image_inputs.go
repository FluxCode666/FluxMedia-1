package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type imageInputReference struct {
	Source string `json:"source"`
	MIME   string `json:"mimeType"`
	Base64 string `json:"base64,omitempty"`
	URL    string `json:"url,omitempty"`
	Key    string `json:"storageKey,omitempty"`
	Bucket string `json:"storageBucket,omitempty"`
	Bytes  int    `json:"byteLength"`
}
type stagedImageObject struct {
	UserID string `json:"userId"`
	Key    string `json:"storageKey"`
	Bucket string `json:"storageBucket"`
}
type stagedImageInputs struct {
	References []imageInputReference `json:"references"`
	Objects    []stagedImageObject   `json:"objects"`
}

func (b *backend) handleImageInputsStage(w http.ResponseWriter, r *http.Request) error {
	p, err := b.imageUOLPrincipal(r)
	if err != nil {
		return err
	}
	var input struct {
		UserID       string                `json:"userId"`
		GenerationID string                `json:"generationId"`
		References   []imageInputReference `json:"references"`
	}
	if err := decodeBody(r, &input); err != nil {
		return err
	}
	if input.UserID != "" && input.UserID != p.UserID {
		return &apiError{403, "FORBIDDEN", "Image input owner does not match the authenticated user"}
	}
	result, err := b.stageImageInputs(r, p.UserID, input.References)
	if err != nil {
		return err
	}
	writeJSON(w, 200, result)
	return nil
}

func (b *backend) handleImageInputsCleanup(w http.ResponseWriter, r *http.Request) error {
	p, err := b.imageUOLPrincipal(r)
	if err != nil {
		return err
	}
	var input struct {
		Objects []stagedImageObject `json:"objects"`
	}
	if err := decodeBody(r, &input); err != nil {
		return err
	}
	if len(input.Objects) > 257 {
		return invalid("Too many image input objects")
	}
	_, bucket, err := b.storageBuckets(r.Context())
	if err != nil {
		return err
	}
	for _, object := range input.Objects {
		if object.UserID != p.UserID || object.Bucket != bucket || !validStorageObjectPath(object.Bucket, object.Key) || !strings.HasPrefix(object.Key, p.UserID+"/image-inputs/") {
			return &apiError{403, "FORBIDDEN", "Image input cleanup owner mismatch"}
		}
	}
	for _, object := range input.Objects {
		// Creation adopts the input manifest atomically with the generation. A
		// caller timing out while Go continues processing must not remove it.
		var adopted bool
		err := b.db.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM generation WHERE user_id=$1 AND metadata::text LIKE '%' || $2 || '%' UNION ALL SELECT 1 FROM image_async_task WHERE user_id=$1 AND generation_inputs::text LIKE '%' || $2 || '%')`, p.UserID, object.Key).Scan(&adopted)
		if err != nil {
			return err
		}
		if adopted {
			continue
		}
		if err := b.deleteStorageObject(r.Context(), object.Bucket, object.Key); err != nil {
			return err
		}
	}
	writeJSON(w, 200, map[string]any{"success": true})
	return nil
}

func (b *backend) stageImageInputs(r *http.Request, userID string, refs []imageInputReference) (result stagedImageInputs, err error) {
	result = stagedImageInputs{References: []imageInputReference{}, Objects: []stagedImageObject{}}
	limits, err := b.imageGenerationMediaLimits(r)
	if err != nil {
		return result, err
	}
	if len(refs) > limits["maxEditImages"].(int)+1 {
		return result, invalid("Too many reference images")
	}
	_, bucket, err := b.storageBuckets(r.Context())
	if err != nil {
		return result, err
	}
	defer func() {
		if err != nil {
			for _, object := range result.Objects {
				if cleanupErr := b.deleteStorageObject(r.Context(), object.Bucket, object.Key); cleanupErr != nil {
					err = errors.Join(err, cleanupErr)
				}
			}
		}
	}()
	var total int
	for _, ref := range refs {
		if ref.MIME != "image/png" && ref.MIME != "image/jpeg" && ref.MIME != "image/webp" {
			return result, invalid("Unsupported image input MIME")
		}
		max := limits["maxFileSizeBytes"].(int)
		if ref.Bytes <= 0 || ref.Bytes > max {
			return result, invalid("Image input byte length exceeds the configured limit")
		}
		var data []byte
		switch ref.Source {
		case "data":
			if len(ref.Base64) > base64.StdEncoding.EncodedLen(max) {
				return result, invalid("Image input is too large")
			}
			data, err = base64.StdEncoding.Strict().DecodeString(ref.Base64)
		case "storage":
			if ref.Bucket == "" {
				ref.Bucket = bucket
			}
			if err = b.validateModerationStorageOwner(r.Context(), userID, ref.Bucket, ref.Key); err != nil {
				return result, err
			}
			if ref.Bucket != bucket {
				return result, invalid("Image input storage bucket is not the generation bucket")
			}
			data, err = b.readStorageObject(r.Context(), ref.Bucket, ref.Key)
		case "remote":
			data, err = readPublicImage(r.Context(), ref.URL, max)
		default:
			return result, invalid("Unsupported image input source")
		}
		if err != nil {
			return result, invalid("Image input could not be loaded")
		}
		if len(data) != ref.Bytes || len(data) > max {
			return result, invalid("Image input byte length does not match its contents")
		}
		if http.DetectContentType(data) != ref.MIME {
			return result, invalid("Image input MIME does not match its contents")
		}
		total += len(data)
		if total > limits["maxUploadBytes"].(int) {
			return result, invalid("Image inputs exceed the configured upload limit")
		}
		if ref.Source != "storage" {
			ext := "png"
			if ref.MIME == "image/jpeg" {
				ext = "jpg"
			}
			if ref.MIME == "image/webp" {
				ext = "webp"
			}
			ref.Key = fmt.Sprintf("%s/image-inputs/%s/input.%s", userID, newRequestID(), ext)
			ref.Bucket = bucket
			if err = b.putStorageObject(r.Context(), bucket, ref.Key, data, ref.MIME); err != nil {
				return result, err
			}
			result.Objects = append(result.Objects, stagedImageObject{userID, ref.Key, bucket})
		}
		ref.Source = "storage"
		ref.Base64 = ""
		ref.URL = ""
		result.References = append(result.References, ref)
	}
	return result, nil
}

// DNS is resolved and checked inside the dialer, so redirects and DNS rebinding
// cannot turn an allowed public URL into a request to a private service.
func publicMediaIP(ip net.IP) bool {
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
		return false
	}
	for _, cidr := range []string{"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4", "2001:db8::/32", "64:ff9b::/96"} {
		_, network, _ := net.ParseCIDR(cidr)
		if network.Contains(ip) {
			return false
		}
	}
	return true
}
func validatePublicMediaURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil {
		return invalid("Remote image URL must use public HTTPS")
	}
	if ip := net.ParseIP(u.Hostname()); ip != nil && !publicMediaIP(ip) {
		return invalid("Remote image URL must be public")
	}
	return nil
}
func publicMediaTransport() *http.Transport {
	return &http.Transport{DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
		if err != nil {
			return nil, err
		}
		if len(ips) == 0 {
			return nil, errors.New("remote image has no address")
		}
		for _, ip := range ips {
			if !publicMediaIP(ip.IP) {
				return nil, errors.New("remote image resolves to a private address")
			}
		}
		return (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, network, net.JoinHostPort(ips[0].IP.String(), port))
	}, TLSHandshakeTimeout: 10 * time.Second}
}
func readPublicImage(ctx context.Context, raw string, max int) ([]byte, error) {
	if err := validatePublicMediaURL(raw); err != nil {
		return nil, err
	}
	transport := publicMediaTransport()
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 30 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("too many redirects")
		}
		return validatePublicMediaURL(req.URL.String())
	}}
	req, err := http.NewRequestWithContext(ctx, "GET", raw, nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, errors.New("remote image request failed")
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, int64(max)+1))
	if len(data) > max {
		return nil, errors.New("remote image too large")
	}
	return data, err
}

func (b *backend) stageImageRequest(r *http.Request, p *apiPrincipal, body map[string]json.RawMessage, operation string) (stagedImageInputs, error) {
	var refs []imageInputReference
	if raw := body["images"]; raw != nil {
		if json.Unmarshal(raw, &refs) != nil {
			return stagedImageInputs{}, invalid("Invalid image references")
		}
	}
	if operation != "generate" && len(refs) == 0 {
		return stagedImageInputs{}, invalid("At least one source image is required")
	}
	count := len(refs)
	limits, err := b.imageGenerationMediaLimits(r)
	if err != nil {
		return stagedImageInputs{}, err
	}
	if count > limits["maxEditImages"].(int) {
		return stagedImageInputs{}, invalid("Too many reference images")
	}
	if raw := body["mask"]; raw != nil {
		var mask imageInputReference
		if json.Unmarshal(raw, &mask) != nil {
			return stagedImageInputs{}, invalid("Invalid mask")
		}
		refs = append(refs, mask)
	} else if operation == "mask" {
		return stagedImageInputs{}, invalid("Mask is required")
	}
	staged, err := b.stageImageInputs(r, p.UserID, refs)
	if err != nil {
		return staged, err
	}
	if count > 0 {
		body["images"], _ = json.Marshal(staged.References[:count])
	}
	if len(staged.References) > count {
		body["mask"], _ = json.Marshal(staged.References[count])
	}
	return staged, nil
}
