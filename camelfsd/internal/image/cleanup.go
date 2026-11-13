package image

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"golang.org/x/sys/unix"
	"os"
	"path/filepath"
	"strings"
)

func DMPrefix(data string) string {
	absolute, _ := filepath.Abs(data)
	sum := sha256.Sum256([]byte(absolute))
	return fmt.Sprintf("camelfs-%x-", sum[:4])
}

type DeviceCommands interface {
	Run(context.Context, string, ...string) error
}
type systemDevices struct{}

func (systemDevices) Run(ctx context.Context, name string, args ...string) error {
	_, e := run(ctx, name, args...)
	return e
}

// Cleanup requires stopped guests and exclusive ownership of the data directory.
func Cleanup(ctx context.Context, data string, commands DeviceCommands) error {
	data, e := filepath.Abs(data)
	if e != nil {
		return e
	}
	lock, e := os.OpenFile(filepath.Join(data, "host.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return e
	}
	defer lock.Close()
	if e = unix.Flock(int(lock.Fd()), unix.LOCK_EX|unix.LOCK_NB); e != nil {
		return fmt.Errorf("data is in use: %w", e)
	}
	if commands == nil {
		commands = systemDevices{}
	}
	files, e := filepath.Glob(filepath.Join(data, "mounts", "*", "state.json"))
	if e != nil {
		return e
	}
	type state struct{ DM, OriginDM, NBD, CowLoop, DestLoop string }
	var mounts []state
	for _, p := range files {
		b, e := os.ReadFile(p)
		if e != nil {
			return e
		}
		var v state
		if e = json.Unmarshal(b, &v); e != nil {
			return e
		}
		if v.DM != "" && v.DM != DMPrefix(data)+filepath.Base(filepath.Dir(p)) {
			return fmt.Errorf("foreign dm device")
		}
		if v.OriginDM != "" && v.OriginDM != DMPrefix(data)+filepath.Base(filepath.Dir(p))+"-o" {
			return fmt.Errorf("foreign origin device")
		}
		for _, loop := range []string{v.CowLoop, v.DestLoop} {
			if loop != "" && !deviceNumber(loop, "/dev/loop") {
				return fmt.Errorf("invalid loop device")
			}
		}
		if v.NBD != "" && !deviceNumber(v.NBD, "/dev/nbd") {
			return fmt.Errorf("invalid nbd device")
		}
		mounts = append(mounts, v)
	}
	for _, v := range mounts {
		if v.DM != "" {
			if e = commands.Run(ctx, "dmsetup", "remove", v.DM); e != nil {
				return e
			}
		}
		if v.OriginDM != "" {
			if e = commands.Run(ctx, "dmsetup", "remove", v.OriginDM); e != nil {
				return e
			}
		}
		for _, loop := range []string{v.CowLoop, v.DestLoop} {
			if loop != "" {
				if e = commands.Run(ctx, "losetup", "-d", loop); e != nil {
					return e
				}
			}
		}
		if v.NBD != "" {
			if e = commands.Run(ctx, "nbd-client", "-d", v.NBD); e != nil {
				return e
			}
		}
	}
	dirs, e := os.ReadDir(filepath.Join(data, "mounts"))
	if os.IsNotExist(e) {
		return nil
	}
	if e != nil {
		return e
	}
	for _, d := range dirs {
		if e = os.RemoveAll(filepath.Join(data, "mounts", d.Name())); e != nil {
			return e
		}
	}
	return nil
}
func deviceNumber(v, prefix string) bool {
	tail := strings.TrimPrefix(v, prefix)
	if tail == v || tail == "" {
		return false
	}
	for _, r := range tail {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
