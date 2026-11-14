package store

import (
	"regexp"
	"strings"
)

var resultID = regexp.MustCompile(`^[A-Za-z0-9._-]{1,96}$`)

// ResultKey names a host-written result outside the immutable object namespace.
func ResultKey(lineage, id string) (string, bool) {
	if !Lineage(lineage) || !resultID.MatchString(id) || id == "." || id == ".." {
		return "", false
	}
	return "results/" + lineage + "/" + id, true
}

func validReadKey(key string) bool {
	if valid(key) {
		return true
	}
	parts := strings.Split(key, "/")
	if len(parts) != 3 || parts[0] != "results" {
		return false
	}
	_, ok := ResultKey(parts[1], parts[2])
	return ok
}
