// runGoBuild shells one GOOS=wasip1 build for tests. Shelling is deliberate:
// the runner must prove the exact artifact pipeline (`make strategy-build`
// runs the same command) instead of hand-rolling compilation.
package strategies

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
)

func runGoBuild(dir, out string) error {
	cmd := exec.Command("go", "build", "-o", out, ".")
	cmd.Dir = dir
	cmd.Env = append(filterEnv(), "GOOS=wasip1", "GOARCH=wasm", "CGO_ENABLED=0")
	var sb strings.Builder
	cmd.Stdout = &lineWriter{sb: &sb}
	cmd.Stderr = &lineWriter{sb: &sb}
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("go build: %w: %s", err, sb.String())
	}
	return nil
}

func filterEnv() []string {
	out := []string{}
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, "GOOS=") || strings.HasPrefix(kv, "GOARCH=") || strings.HasPrefix(kv, "CGO_ENABLED=") {
			continue
		}
		out = append(out, kv)
	}
	return out
}

type lineWriter struct{ sb *strings.Builder }

func (w *lineWriter) Write(p []byte) (int, error) {
	return w.sb.Write(p)
}
