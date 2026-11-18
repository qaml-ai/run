//go:build !linux

package workdisk

import (
	"context"
	"fmt"
)

type Device struct{ Path string }

func (v *View) Attach(context.Context, []string) (*Device, error) {
	return nil, fmt.Errorf("workspace NBD requires Linux")
}

func (d *Device) Close() error { return nil }
