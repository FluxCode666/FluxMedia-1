package main

import "net/http"

func (b *backend) assertImageStatusScope(r *http.Request, p *apiPrincipal, id string) error {
	if p.KeyID == "" {
		return nil
	}
	var owned bool
	if err := b.db.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM image_async_task WHERE user_id=$1 AND api_key_id=$2 AND (id=$3 OR generation_id=$3))`, p.UserID, p.KeyID, id).Scan(&owned); err != nil {
		return err
	}
	if !owned {
		return &apiError{404, "NOT_FOUND", "Image task not found"}
	}
	return nil
}
