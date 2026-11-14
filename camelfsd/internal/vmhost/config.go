package vmhost

import (
	"encoding/json"
	"errors"
	"net/netip"
	"os"
	"path/filepath"
)

type Shape struct {
	VCPUs     int   `json:"vcpus"`
	MemoryMiB int   `json:"memoryMiB"`
	DiskMiB   int64 `json:"diskMiB"`
}

type Boot struct {
	Internet bool
	Repo     string
}

type configFiles struct {
	kernel, initrd, disk, repo, vsock string
}

func firecrackerConfig(files configFiles, address Address, shape Shape, build, kvm, internet bool) map[string]any {
	args := "console=ttyS0 panic=1 initcall_blacklist=i8042_init quiet"
	args += " reboot=k root=/dev/vda rw init=/sbin/camel-init " + GuestNetArgs(address, internet)
	drives := []map[string]any{drive("root", files.disk, true)}
	if files.repo != "" {
		args += " camel.repo=/dev/vdb"
		drives = append(drives, drive("repo", files.repo, false))
	}
	source := map[string]any{"kernel_image_path": files.kernel, "boot_args": args}
	if files.initrd != "" {
		source["initrd_path"] = files.initrd
	}
	config := map[string]any{
		"boot-source":        source,
		"drives":             drives,
		"machine-config":     map[string]any{"vcpu_count": shape.VCPUs, "mem_size_mib": shape.MemoryMiB, "smt": false},
		"vsock":              map[string]any{"guest_cid": 3, "uds_path": files.vsock},
		"network-interfaces": []map[string]any{{"iface_id": "eth0", "host_dev_name": address.Tap, "guest_mac": address.MAC}},
	}
	if !kvm {
		config["enclave"] = map[string]any{"direct_mode": true, "cpu_overcommit": !build}
	}
	return config
}

func drive(id, path string, root bool) map[string]any {
	return map[string]any{"drive_id": id, "path_on_host": path, "is_root_device": root, "is_read_only": false, "io_engine": "Async"}
}

var defaultEgress = []string{
	"github.com", "*.github.com", "*.githubusercontent.com", "codeload.github.com",
	"registry.npmjs.org", "registry.yarnpkg.com",
	"pypi.org", "files.pythonhosted.org",
	"crates.io", "index.crates.io", "static.crates.io",
	"proxy.golang.org", "sum.golang.org",
}

// EgressPolicy is the policy written for one guest address.
type EgressPolicy struct {
	Job   string   `json:"job"`
	Allow []string `json:"allow"`
}

func (l *Launcher) policy(id string, internet bool) EgressPolicy {
	p := EgressPolicy{Job: id, Allow: []string{}}
	if internet {
		allowed := l.Egress
		if allowed == nil {
			allowed = defaultEgress
		}
		p.Allow = append(p.Allow, allowed...)
		if l.RuntimeHost != "" {
			p.Allow = append(p.Allow, l.RuntimeHost)
		}
	}
	return p
}

func writePolicy(dir string, ip netip.Addr, p EgressPolicy) error {
	if !ip.Is4() {
		return errors.New("invalid guest address")
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	return writeJSON(filepath.Join(dir, ip.String()+".json"), p, 0644)
}

func removePolicy(dir string, ip netip.Addr) error {
	if !ip.Is4() {
		return nil
	}
	return removeFile(filepath.Join(dir, ip.String()+".json"))
}

func writeJSON(path string, value any, mode os.FileMode) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".tmp-")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	if _, err := f.Write(data); err != nil {
		return err
	}
	if err := f.Chmod(mode); err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}

func removeFile(path string) error {
	err := os.Remove(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
