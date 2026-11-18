//go:build !linux

package vm

import (
	"fmt"
	"os/exec"
)

func launchFirecracker(_ *exec.Cmd) (chan struct{}, error) {
	return nil, fmt.Errorf("Firecracker requires Linux")
}
