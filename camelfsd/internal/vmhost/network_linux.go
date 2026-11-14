package vmhost

import (
	"encoding/binary"
	"errors"
	"fmt"
	"net/netip"
	"syscall"

	"golang.org/x/sys/unix"
)

const (
	MaxSlots  = 250
	ProxyPort = 3128
)

type Address struct {
	Slot            int
	Tap             string
	HostIP, GuestIP netip.Addr
	MAC             string
	Prefix          int
}

func JobAddress(slot int) (Address, error) {
	if slot < 0 || slot >= MaxSlots {
		return Address{}, fmt.Errorf("invalid job slot %d", slot)
	}
	return Address{
		Slot: slot, Tap: fmt.Sprintf("cj%d", slot),
		HostIP:  netip.AddrFrom4([4]byte{10, 200, byte(slot), 1}),
		GuestIP: netip.AddrFrom4([4]byte{10, 200, byte(slot), 2}),
		MAC:     fmt.Sprintf("06:00:0a:c8:%02x:02", slot), Prefix: 30,
	}, nil
}

func GuestNetArgs(addr Address, internet bool) string {
	args := fmt.Sprintf("camel.ip=%s/%d camel.gw=%s", addr.GuestIP, addr.Prefix, addr.HostIP)
	if internet {
		args += fmt.Sprintf(" camel.proxy=http://%s:%d", addr.HostIP, ProxyPort)
	}
	return args
}

// TapUp creates a persistent tap owned by the jailed Firecracker UID.
// An existing tap is left alone because it may belong to a surviving VM.
func TapUp(addr Address, uid int) error {
	fd, err := unix.Open("/dev/net/tun", unix.O_RDWR|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	req, err := unix.NewIfreq(addr.Tap)
	if err != nil {
		return err
	}
	req.SetUint16(unix.IFF_TAP | unix.IFF_NO_PI | unix.IFF_VNET_HDR | unix.IFF_TUN_EXCL)
	if err := unix.IoctlIfreq(fd, unix.TUNSETIFF, req); err != nil {
		return err
	}
	if err := unix.IoctlSetInt(fd, unix.TUNSETOWNER, uid); err != nil {
		return err
	}
	ip := addr.HostIP.As4()
	msg := []byte{unix.AF_INET, byte(addr.Prefix), 0, unix.RT_SCOPE_UNIVERSE, 0, 0, 0, 0}
	index, err := tapIndex(addr.Tap)
	if err != nil {
		return err
	}
	binary.NativeEndian.PutUint32(msg[4:], uint32(index))
	msg = append(msg, 0, 0, 0, 0)
	binary.NativeEndian.PutUint16(msg[8:], 8)
	binary.NativeEndian.PutUint16(msg[10:], unix.IFA_LOCAL)
	msg = append(msg, ip[:]...)
	if err := route(unix.RTM_NEWADDR, unix.NLM_F_CREATE|unix.NLM_F_EXCL, msg); err != nil {
		return err
	}
	if err := route(unix.RTM_NEWLINK, 0, linkMessage(index, unix.IFF_UP)); err != nil {
		return err
	}
	return unix.IoctlSetInt(fd, unix.TUNSETPERSIST, 1)
}

func TapDown(addr Address) error {
	index, err := tapIndex(addr.Tap)
	if errors.Is(err, unix.ENODEV) {
		return nil
	}
	if err != nil {
		return err
	}
	err = route(unix.RTM_DELLINK, 0, linkMessage(index, 0))
	if errors.Is(err, unix.ENODEV) {
		return nil
	}
	return err
}

func tapIndex(name string) (int, error) {
	fd, err := unix.Socket(unix.AF_INET, unix.SOCK_DGRAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return 0, err
	}
	defer unix.Close(fd)
	req, err := unix.NewIfreq(name)
	if err != nil {
		return 0, err
	}
	if err := unix.IoctlIfreq(fd, unix.SIOCGIFINDEX, req); err != nil {
		return 0, err
	}
	return int(req.Uint32()), nil
}

func linkMessage(index int, up uint32) []byte {
	msg := make([]byte, unix.SizeofIfInfomsg)
	binary.NativeEndian.PutUint32(msg[4:], uint32(index))
	binary.NativeEndian.PutUint32(msg[8:], up)
	binary.NativeEndian.PutUint32(msg[12:], up)
	return msg
}

// Each operation uses its own socket and waits for the kernel's acknowledgement.
func route(kind, flags uint16, payload []byte) error {
	fd, err := unix.Socket(unix.AF_NETLINK, unix.SOCK_RAW|unix.SOCK_CLOEXEC, unix.NETLINK_ROUTE)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	msg := make([]byte, unix.NLMSG_HDRLEN, unix.NLMSG_HDRLEN+len(payload))
	binary.NativeEndian.PutUint32(msg, uint32(unix.NLMSG_HDRLEN+len(payload)))
	binary.NativeEndian.PutUint16(msg[4:], kind)
	binary.NativeEndian.PutUint16(msg[6:], flags|unix.NLM_F_REQUEST|unix.NLM_F_ACK)
	binary.NativeEndian.PutUint32(msg[8:], 1)
	if err := unix.Sendto(fd, append(msg, payload...), 0, &unix.SockaddrNetlink{Family: unix.AF_NETLINK}); err != nil {
		return err
	}
	var buf [4096]byte
	for {
		n, sender, err := unix.Recvfrom(fd, buf[:], 0)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			return err
		}
		if from, ok := sender.(*unix.SockaddrNetlink); !ok || from.Pid != 0 {
			continue
		}
		messages, err := syscall.ParseNetlinkMessage(buf[:n])
		if err != nil {
			return err
		}
		for _, reply := range messages {
			if reply.Header.Seq != 1 || reply.Header.Type != unix.NLMSG_ERROR || len(reply.Data) < 4 {
				continue
			}
			code := int32(binary.NativeEndian.Uint32(reply.Data))
			if code == 0 {
				return nil
			}
			return unix.Errno(-code)
		}
	}
}

func BaseRules() string {
	return `# camelRun job host base rules (generated from jobhost/network.ts baseRules; a test checks this file matches).
table inet camel_jobs
delete table inet camel_jobs
table inet camel_jobs {
  set private4 {
    type ipv4_addr; flags interval
    elements = { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.168.0.0/16, 198.18.0.0/15, 224.0.0.0/3 }
  }
  set private6 {
    type ipv6_addr; flags interval
    elements = { ::/127, ::ffff:0:0/96, 64:ff9b::/96, fc00::/7, fe80::/10, ff00::/8 }
  }
  chain input {
    type filter hook input priority filter; policy accept;
    iifname "cj*" jump from_job
    tcp dport 3128 counter drop
  }
  chain from_job {
    fib saddr . iif oif missing counter drop
    ct state established,related accept
    fib daddr . iif type local tcp dport 3128 ct state new accept
    counter drop
  }
  chain forward {
    type filter hook forward priority filter; policy accept;
    iifname "cj*" counter drop
    oifname "cj*" counter drop
  }
  chain output {
    type filter hook output priority filter; policy accept;
    oifname "cj*" ct state established,related accept
    oifname "cj*" counter drop
    meta skuid 940 jump proxy_out
  }
  chain proxy_out {
    oifname "lo" counter drop
    ip daddr 169.254.169.253 meta l4proto { tcp, udp } th dport 53 accept
    ip daddr @private4 counter drop
    ip6 daddr fd00:ec2::253 meta l4proto { tcp, udp } th dport 53 accept
    ip6 daddr @private6 counter drop
    tcp dport 443 accept
    counter drop
  }
}
`
}
