package main

import (
	"encoding/hex"
	"fmt"
	"os"
	"strings"
)

func readAPIToken(path string) (string, error) {
	raw, e := os.ReadFile(path)
	if e != nil {
		return "", e
	}
	token := ""
	found := false
	for _, line := range strings.Split(string(raw), "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok || strings.TrimSpace(key) != "CAMELFS_API_TOKEN" {
			continue
		}
		if found {
			return "", fmt.Errorf("duplicate CAMELFS_API_TOKEN")
		}
		found, token = true, strings.TrimSpace(value)
	}
	if !found {
		token = strings.TrimSpace(string(raw))
	}
	if token == "" {
		return "", fmt.Errorf("empty api token")
	}
	if found {
		if _, e := hex.DecodeString(token); e != nil {
			return "", fmt.Errorf("CAMELFS_API_TOKEN must be hex")
		}
	} else if strings.ContainsAny(token, " \t\r\n") || strings.HasPrefix(token, "#") {
		return "", fmt.Errorf("expected raw token or CAMELFS_API_TOKEN=<hex>")
	}
	return token, nil
}
