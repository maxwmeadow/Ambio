package api

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// The capability is local to this installation; never put it in URLs or logs.
func LocalAPIToken(dataDir string) (string, error) {
	if token := os.Getenv("AXIOM_API_TOKEN"); token != "" {
		if len(token) < 32 {
			return "", fmt.Errorf("AXIOM_API_TOKEN must have at least 32 characters")
		}
		return token, nil
	}
	if err := os.MkdirAll(dataDir, 0700); err != nil {
		return "", err
	}
	path := filepath.Join(dataDir, "api-token")
	existing, err := os.ReadFile(path)
	if err == nil {
		token := strings.TrimSpace(string(existing))
		if len(token) < 32 {
			return "", fmt.Errorf("invalid local API token")
		}
		return token, nil
	}
	if !os.IsNotExist(err) {
		return "", err
	}
	bytes := make([]byte, 32)
	if _, err = rand.Read(bytes); err != nil {
		return "", err
	}
	token := hex.EncodeToString(bytes)
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if os.IsExist(err) {
		return LocalAPIToken(dataDir)
	}
	if err != nil {
		return "", err
	}
	_, err = file.WriteString(token)
	closeErr := file.Close()
	if err != nil {
		return "", err
	}
	return token, closeErr
}

func RequireLocalToken(token string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		provided := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if token == "" || subtle.ConstantTimeCompare([]byte(provided), []byte(token)) != 1 {
			jsonError(w, "Axiom connection needs its local API token", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}
