package store

import (
	"regexp"
)

var resultID = regexp.MustCompile(`^[A-Za-z0-9._-]{1,96}$`)

// ResultKey names a host-written result outside the immutable object namespace.
func ResultKey(lineage, id string) (string, bool) {
	if !Lineage(lineage) || !resultID.MatchString(id) || id == "." || id == ".." {
		return "", false
	}
	return "results/" + lineage + "/" + id, true
}
