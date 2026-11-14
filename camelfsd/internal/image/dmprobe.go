package image

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// The device-mapper targets a cold mount uses: linear (the swappable origin) and snapshot (the job's
// writable layer, dm-snapshot). Exactly the modules infra/job-hosts/kvm/host-setup.sh loads.
var requiredTargets = []string{"linear", "snapshot"}

// ProbeDeviceMapper fails the host's start when a required target is missing, instead of the first
// cold mount failing in dmsetup create. Unprivileged test mode (CAMELFSD_TEST_NO_REFLINK=1) has no
// device mapper and skips it, like the reflink probe.
func ProbeDeviceMapper(ctx context.Context) error {
	if os.Getenv("CAMELFSD_TEST_NO_REFLINK") == "1" {
		return nil
	}
	out, err := exec.CommandContext(ctx, "dmsetup", "targets").CombinedOutput()
	if err != nil {
		return fmt.Errorf("dmsetup targets: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return missingTargets(string(out))
}

func missingTargets(listing string) error {
	have := map[string]bool{}
	for _, line := range strings.Split(listing, "\n") {
		if fields := strings.Fields(line); len(fields) > 0 {
			have[fields[0]] = true
		}
	}
	var missing []string
	for _, target := range requiredTargets {
		if !have[target] {
			missing = append(missing, target)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("device-mapper target(s) %s missing: load dm-snapshot (modprobe dm-snapshot; see infra/job-hosts/kvm/host-setup.sh)", strings.Join(missing, ", "))
	}
	return nil
}
