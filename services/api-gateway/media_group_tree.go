package main

import (
	"context"
)

// Descendants are part of the authorized root group. Disabled nodes stop
// traversal, and UNION deduplicates shared descendants and legacy cycles.
func reachableMediaGroupIDs(ctx context.Context, db videoPricingStore, root string) ([]string, error) {
	var ids []string
	err := db.QueryRow(ctx, `WITH RECURSIVE authorized(id,metadata) AS (
 SELECT id,metadata::jsonb FROM image_backend_group WHERE id=$1 AND is_enabled
 UNION
 SELECT child.id,child.metadata::jsonb FROM authorized parent
 CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(parent.metadata->'childGroupIds')='array' THEN parent.metadata->'childGroupIds' ELSE '[]'::jsonb END) edge(id)
 JOIN image_backend_group child ON child.id=edge.id AND child.is_enabled
 ) SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::text[]) FROM authorized`, root).Scan(&ids)
	return ids, err
}
