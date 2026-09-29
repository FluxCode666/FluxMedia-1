//go:build embed

package webui

import (
	"io/fs"
	"os"
	"testing"
)

// TestDistEmbedsEveryBuildFile guards against go:embed silently skipping build
// output, e.g. chunks whose names start with "_".
func TestDistEmbedsEveryBuildFile(t *testing.T) {
	embedded, ok := Dist()
	if !ok {
		t.Fatal("embedded web build has no index.html")
	}
	count := 0
	err := fs.WalkDir(os.DirFS("dist"), ".", func(name string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		count++
		if _, err := fs.Stat(embedded, name); err != nil {
			t.Errorf("build file %s is not embedded", name)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if count == 0 {
		t.Fatal("web build directory is empty")
	}
}
