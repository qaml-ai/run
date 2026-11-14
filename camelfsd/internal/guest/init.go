package guest

import (
	"context"
	"encoding/binary"
	"fmt"
	"log"
	"net"
	"os"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

const guestPath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

type bootConfig struct{ ip, gw, proxy, repo string }

func parseCmdline(line string) bootConfig {
	var c bootConfig
	for _, word := range strings.Fields(line) {
		key, value, _ := strings.Cut(word, "=")
		switch key {
		case "camel.ip":
			c.ip = value
		case "camel.gw":
			c.gw = value
		case "camel.proxy":
			c.proxy = value
		case "camel.repo":
			c.repo = value
		}
	}
	return c
}

func proxyProfile(proxy string) string {
	return fmt.Sprintf("export https_proxy=%[1]s HTTPS_PROXY=%[1]s http_proxy=%[1]s HTTP_PROXY=%[1]s no_proxy=localhost,127.0.0.1\n", proxy)
}

type mount struct {
	source, target, kind string
	flags                uintptr
}

var earlyMounts = []mount{
	{"proc", "/proc", "proc", 0},
	{"sysfs", "/sys", "sysfs", 0},
	{"devtmpfs", "/dev", "devtmpfs", 0},
	{"devpts", "/dev/pts", "devpts", 0},
	{"tmpfs", "/dev/shm", "tmpfs", 0},
	{"tmpfs", "/run", "tmpfs", 0},
	{"cgroup2", "/sys/fs/cgroup", "cgroup2", 0},
}

type bootSystem struct {
	mount       func(mount) error
	readCmdline func() ([]byte, error)
	prepare     func()
	network     func(bootConfig)
	writeFile   func(string, []byte, os.FileMode) error
	report      func(error)
}

func setupBoot(s bootSystem) bootConfig {
	for _, m := range earlyMounts {
		if err := s.mount(m); err != nil && err != unix.EBUSY {
			s.report(fmt.Errorf("mount %s: %w", m.target, err))
		}
	}
	s.prepare()
	cmdline, err := s.readCmdline()
	if err != nil {
		s.report(err)
	}
	c := parseCmdline(string(cmdline))
	s.network(c)
	if err := s.writeFile("/etc/resolv.conf", nil, 0644); err != nil {
		s.report(err)
	}
	if c.proxy != "" {
		if err := s.writeFile("/etc/profile.d/camel-proxy.sh", []byte(proxyProfile(c.proxy)), 0644); err != nil {
			s.report(err)
		}
	}
	if c.repo != "" {
		if err := s.mount(mount{c.repo, "/repo", "ext4", unix.MS_NOATIME}); err != nil {
			s.report(fmt.Errorf("camelFS repo disk mount failed: %w", err))
		}
	}
	return c
}

func console(err error) {
	f, e := os.OpenFile("/dev/console", os.O_WRONLY, 0)
	if e != nil {
		log.Print(err)
		return
	}
	defer f.Close()
	fmt.Fprintln(f, err)
}

func Init(ctx context.Context) error {
	if os.Getpid() != 1 {
		return fmt.Errorf("camelfsd init must run as PID 1")
	}
	os.Setenv("PATH", guestPath)
	r := startReaper()
	cfg := setupBoot(bootSystem{
		mount: func(m mount) error {
			if err := os.MkdirAll(m.target, 0755); err != nil {
				return err
			}
			return unix.Mount(m.source, m.target, m.kind, m.flags, "")
		},
		readCmdline: func() ([]byte, error) { return os.ReadFile("/proc/cmdline") },
		prepare: func() {
			for _, err := range []error{
				os.MkdirAll("/tmp", 0755),
				os.Chmod("/tmp", os.ModeSticky|0777),
				unix.Sethostname([]byte("job")),
			} {
				if err != nil {
					console(err)
				}
			}
		},
		network: func(c bootConfig) {
			if err := configureNetwork(c); err != nil {
				console(err)
			}
		},
		writeFile: os.WriteFile,
		report:    console,
	})
	if cfg.repo != "" {
		os.Setenv("CAMEL_VSOCK_CONNECT", "1")
	}
	if cfg.proxy != "" {
		for _, key := range []string{"http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"} {
			os.Setenv(key, cfg.proxy)
		}
		os.Setenv("no_proxy", "localhost,127.0.0.1")
	}
	if err := ServeVM(ctx, cfg.repo != "" || os.Getenv("CAMEL_VSOCK_CONNECT") == "1", r); err != nil {
		console(err)
		for {
			time.Sleep(time.Hour)
		}
	}
	unix.Sync()
	// x86 Firecracker exits on the emulated i8042 reset triggered by reboot=k.
	// Its virtual hardware lacks the power-management device for POWER_OFF.
	if err := unix.Reboot(unix.LINUX_REBOOT_CMD_RESTART); err != nil {
		console(err)
	}
	// Returning from PID 1 would panic the kernel if the reboot syscall fails.
	for {
		time.Sleep(time.Hour)
	}
}

func configureNetwork(c bootConfig) error {
	fd, err := unix.Socket(unix.AF_NETLINK, unix.SOCK_RAW|unix.SOCK_CLOEXEC, unix.NETLINK_ROUTE)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	if err = unix.Bind(fd, &unix.SockaddrNetlink{Family: unix.AF_NETLINK}); err != nil {
		return err
	}
	up := func(name string) (int, error) {
		dev, err := net.InterfaceByName(name)
		if err != nil {
			return 0, err
		}
		b := make([]byte, unix.SizeofIfInfomsg)
		binary.NativeEndian.PutUint32(b[4:], uint32(dev.Index))
		binary.NativeEndian.PutUint32(b[8:], unix.IFF_UP)
		binary.NativeEndian.PutUint32(b[12:], unix.IFF_UP)
		return dev.Index, netlink(fd, unix.RTM_NEWLINK, 0, b)
	}
	if _, err := up("lo"); err != nil {
		return err
	}
	if c.ip == "" {
		return nil
	}
	idx, err := up("eth0")
	if err != nil {
		return err
	}
	ip, network, err := net.ParseCIDR(c.ip)
	if err != nil || ip.To4() == nil {
		return fmt.Errorf("invalid camel.ip")
	}
	prefix, _ := network.Mask.Size()
	addr := make([]byte, unix.SizeofIfAddrmsg)
	addr[0], addr[1] = unix.AF_INET, byte(prefix)
	binary.NativeEndian.PutUint32(addr[4:], uint32(idx))
	addr = append(addr, attribute(unix.IFA_LOCAL, ip.To4())...)
	addr = append(addr, attribute(unix.IFA_ADDRESS, ip.To4())...)
	flags := unix.NLM_F_CREATE | unix.NLM_F_EXCL
	if err := netlink(fd, unix.RTM_NEWADDR, flags, addr); err != nil || c.gw == "" {
		return err
	}
	gw := net.ParseIP(c.gw).To4()
	if gw == nil {
		return fmt.Errorf("invalid camel.gw")
	}
	route := make([]byte, unix.SizeofRtMsg)
	route[0], route[4], route[5], route[6], route[7] = unix.AF_INET, unix.RT_TABLE_MAIN, unix.RTPROT_BOOT, unix.RT_SCOPE_UNIVERSE, unix.RTN_UNICAST
	route = append(route, attribute(unix.RTA_GATEWAY, gw)...)
	route = append(route, attribute(unix.RTA_OIF, binary.NativeEndian.AppendUint32(nil, uint32(idx)))...)
	return netlink(fd, unix.RTM_NEWROUTE, flags, route)
}

func attribute(kind uint16, data []byte) []byte {
	length := unix.SizeofRtAttr + len(data)
	a := make([]byte, (length+3)&^3)
	binary.NativeEndian.PutUint16(a, uint16(length))
	binary.NativeEndian.PutUint16(a[2:], kind)
	copy(a[unix.SizeofRtAttr:], data)
	return a
}

func netlink(fd int, kind, flags int, payload []byte) error {
	b := make([]byte, unix.NLMSG_HDRLEN, len(payload)+unix.NLMSG_HDRLEN)
	binary.NativeEndian.PutUint32(b, uint32(cap(b)))
	binary.NativeEndian.PutUint16(b[4:], uint16(kind))
	binary.NativeEndian.PutUint16(b[6:], uint16(flags|unix.NLM_F_REQUEST|unix.NLM_F_ACK))
	if err := unix.Sendto(fd, append(b, payload...), 0, &unix.SockaddrNetlink{Family: unix.AF_NETLINK}); err != nil {
		return err
	}
	var reply [4096]byte
	for {
		n, _, err := unix.Recvfrom(fd, reply[:], 0)
		if err == unix.EINTR {
			continue
		}
		if err != nil {
			return err
		}
		if n < unix.NLMSG_HDRLEN+4 || binary.NativeEndian.Uint16(reply[4:]) != unix.NLMSG_ERROR {
			return fmt.Errorf("invalid netlink ACK")
		}
		code := int32(binary.NativeEndian.Uint32(reply[unix.NLMSG_HDRLEN:]))
		if code == 0 {
			return nil
		}
		return unix.Errno(-code)
	}
}
