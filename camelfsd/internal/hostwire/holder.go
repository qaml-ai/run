package hostwire

import (
	"errors"
	"regexp"
	"strconv"
	"strings"
)

var HostID = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)
var MountID = regexp.MustCompile(`^[A-Za-z0-9._-]{1,96}$`)

type Holder struct {
	Host  string `json:"host"`
	Boot  int64  `json:"boot"`
	Mount string `json:"mount"`
}

func (h Holder) String() string {
	return h.Host + ":" + strconv.FormatInt(h.Boot, 10) + ":" + h.Mount
}

func ParseHolder(s string) (Holder, error) {
	parts := strings.SplitN(s, ":", 3)
	if len(parts) == 3 {
		boot, err := strconv.ParseInt(parts[1], 10, 64)
		h := Holder{Host: parts[0], Boot: boot, Mount: parts[2]}
		if err == nil && boot > 0 && HostID.MatchString(h.Host) && MountID.MatchString(h.Mount) && h.String() == s {
			return h, nil
		}
	}
	return Holder{}, errors.New("invalid lease holder")
}
