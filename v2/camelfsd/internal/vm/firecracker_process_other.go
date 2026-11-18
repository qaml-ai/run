//go:build !linux

package vm

import (
	"fmt"
	"os/exec"
)

func launchFirecracker(_ *exec.Cmd) (chan struct{}, error) {
	return nil, fmt.Errorf("Firecracker requires Linux")
}

func firecrackerServiceCgroup() (string, error) {
	return "", fmt.Errorf("the Firecracker jailer requires Linux")
}

func prepareFirecrackerJail(_, _, _, _ string) (string, error) {
	return "", fmt.Errorf("the Firecracker jailer requires Linux")
}
