// Package skills — loader wires built-in skills into the watcher.
//
// Call RegisterBuiltins(reg) once at startup (from main.go) to populate the
// skill registry. The registry is then exposed through Router and can be
// reached by the Worker via an HTTP facade (see workers/src/skills).
package skills

import (
	"encoding/json"
	"net/http"
)

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeJSONErr(w http.ResponseWriter, status int, code, reason string) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"code": code, "reason": reason})
}

// RegisterBuiltins registers all native skills into reg.
func RegisterBuiltins(reg *Registry) {
	reg.Register(MarketRegime{})
	reg.Register(PositionSize{})
}

// HandleRoute returns an http.HandlerFunc that dispatches POST /skills/{name}.
func HandleRoute(rt *Router) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "content-type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		name := r.PathValue("name")
		if name == "" {
			http.Error(w, "skill name required", http.StatusBadRequest)
			return
		}
		var req Request
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&req); err != nil {
			writeJSONErr(w, http.StatusBadRequest, "BAD_JSON", err.Error())
			return
		}
		if req.Symbol == "" {
			writeJSONErr(w, http.StatusBadRequest, "VALIDATION", "symbol required")
			return
		}
		if req.Deadline <= 0 {
			req.Deadline = 5000
		}
		res, err := rt.Run(r.Context(), name, req)
		if err != nil {
			writeJSONErr(w, http.StatusInternalServerError, "SKILL_ERROR", err.Error())
			return
		}
		status := http.StatusOK
		if !res.OK {
			status = http.StatusUnprocessableEntity
		}
		writeJSON(w, status, res)
	}
}
