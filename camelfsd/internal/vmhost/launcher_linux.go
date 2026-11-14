// Package vmhost launches and stops Firecracker VMs on Linux.
package vmhost

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

const (
	mib            = 1 << 20
	DefaultUIDBase = 200000
)

var (
	jobID    = regexp.MustCompile(`^[A-Za-z0-9._-]{1,96}$`)
	jailerID = regexp.MustCompile(`^[A-Za-z0-9-]{1,64}$`)
)

// Launcher owns one work directory and the host's job tap and UID range.
// Its configuration is immutable after first use.
type Launcher struct {
	Firecracker, Jailer, Kernel, Initrd, Image, Work, PolicyDir string
	KVM, Build                                                  bool
	Reflink                                                     string
	UIDBase                                                     int
	Egress                                                      []string
	RuntimeHost                                                 string

	mu   sync.Mutex
	live map[string]*VM
	// Cache the hash of the pinned, immutable base image.
	imageOnce sync.Once
	imageSHA  string
	imageErr  error
}

type VMRecord struct {
	ID        string    `json:"id"`
	Slot      int       `json:"slot"`
	Tap       string    `json:"tap"`
	Jail      string    `json:"jail"`
	Scope     string    `json:"scope"`
	StartedAt time.Time `json:"startedAt"`
	ImageSHA  string    `json:"imageSha"`
	Shape     Shape     `json:"shape"`
}

type VM struct {
	host                                *Launcher
	record                              VMRecord
	root                                string
	cmd                                 *exec.Cmd
	exited                              chan struct{}
	exitErr                             error
	channel                             *channel
	mu                                  sync.Mutex
	gone                                bool
	scopeAttempted, tapOwned, jailOwned bool
}

func (v *VM) Slot() int           { return v.record.Slot }
func (v *VM) GuestSocket() string { return filepath.Join(v.root, "guest.vsock") }
func (v *VM) GuestUID() int       { return v.host.uidBase() + v.record.Slot }

func (v *VM) ID() string { return v.record.ID }

func (l *Launcher) Adopt(id string) (*VM, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if v := l.live[id]; v != nil {
		return v, nil
	}
	r, err := l.readRecord(id)
	if err != nil {
		return nil, err
	}
	fc, err := filepath.EvalSymlinks(l.Firecracker)
	if err != nil {
		return nil, err
	}
	v := &VM{
		host: l, record: r, root: jailRoot(r, fc),
		scopeAttempted: true, tapOwned: true, jailOwned: true,
	}
	if l.live == nil {
		l.live = make(map[string]*VM)
	}
	l.live[id] = v
	return v, nil
}

func (l *Launcher) Boot(ctx context.Context, id string, shape Shape, boot Boot) (*VM, error) {
	v, err := l.start(ctx, id, shape, boot)
	if err != nil {
		return nil, err
	}
	v.mu.Lock()
	if v.gone {
		v.mu.Unlock()
		return nil, errors.New("VM was destroyed during boot")
	}
	guestCtx, cancel := context.WithCancel(ctx)
	watched := make(chan struct{})
	go func() {
		defer close(watched)
		select {
		case <-v.exited:
			cancel()
		case <-guestCtx.Done():
		}
	}()
	v.channel, err = connectGuest(guestCtx, filepath.Join(v.root, "guest.vsock"), bootDeadline)
	cancel()
	<-watched
	select {
	case <-v.exited:
		err = fmt.Errorf("Firecracker exited before the guest answered (%v); see %s", v.exitErr, l.logPath(id))
	default:
	}
	v.mu.Unlock()
	if err != nil {
		return nil, errors.Join(err, v.Destroy(context.Background()))
	}
	return v, nil
}

func (v *VM) Request(ctx context.Context, req any, onLog LogFunc, events ...EventFunc) (Reply, error) {
	c, err := v.getChannel(ctx)
	if err != nil {
		return nil, err
	}
	return c.request(ctx, req, onLog, events...)
}

func (v *VM) getChannel(ctx context.Context) (*channel, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.channel != nil {
		select {
		case <-v.channel.closed:
		default:
			return v.channel, nil
		}
	}
	_, err := v.reconnect(ctx)
	return v.channel, err
}

// Reconnect replaces the current channel and returns the guest's session inventory.
func (v *VM) Reconnect(ctx context.Context) (Reply, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.gone || v.root == "" {
		return nil, errors.New("VM has no guest socket")
	}
	return v.reconnect(ctx)
}

func (v *VM) reconnect(ctx context.Context) (Reply, error) {
	if v.channel != nil {
		_ = v.channel.conn.Close()
		v.channel = nil
	}
	ctx, cancel := context.WithTimeout(ctx, bootDeadline)
	defer cancel()
	c, err := connectGuest(ctx, filepath.Join(v.root, "guest.vsock"), bootDeadline)
	if err != nil {
		return nil, err
	}
	reply, err := c.request(ctx, map[string]string{"op": "sessions"}, nil)
	if err != nil || reply["ok"] != true {
		c.conn.Close()
		if err == nil {
			err = errors.New("guest refused sessions request")
		}
		return nil, err
	}
	v.channel = c
	return reply, nil
}

func (l *Launcher) validate(id string, shape Shape, imagePath ...string) (int64, error) {
	if !jobID.MatchString(id) {
		return 0, errors.New("invalid job id")
	}
	path := l.Image
	if len(imagePath) > 0 {
		path = imagePath[0]
	}
	image, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	if !image.Mode().IsRegular() {
		return 0, errors.New("base image must be a regular file")
	}
	size := image.Size()
	minMiB := size / mib
	if size%mib != 0 {
		minMiB++
	}
	if shape.DiskMiB < minMiB {
		return 0, fmt.Errorf("invalid_request: job disk %d MiB is smaller than the base image %d MiB", shape.DiskMiB, minMiB)
	}
	if shape.DiskMiB > math.MaxInt64/mib {
		return 0, errors.New("invalid_request: job disk size overflows bytes")
	}
	if shape.VCPUs <= 0 || shape.MemoryMiB <= 0 {
		return 0, errors.New("invalid_request: VM needs positive CPU and memory")
	}
	if l.Reflink != "" && l.Reflink != "always" && l.Reflink != "auto" {
		return 0, errors.New("reflink must be always or auto")
	}
	base := l.uidBase()
	if base < 1 || base > math.MaxInt32-MaxSlots || (base <= 65534 && base+MaxSlots > 65534) {
		return 0, errors.New("invalid VM UID range")
	}
	if !filepath.IsAbs(l.Work) || !filepath.IsAbs(l.PolicyDir) {
		return 0, errors.New("work and policy directories must be absolute")
	}
	return shape.DiskMiB * mib, nil
}

func (l *Launcher) uidBase() int {
	if l.UIDBase == 0 {
		return DefaultUIDBase
	}
	return l.UIDBase
}

func (l *Launcher) recordPath(id string) string { return filepath.Join(l.Work, "vms", id+".json") }
func (l *Launcher) logPath(id string) string    { return filepath.Join(l.Work, "logs", id+".log") }

func (l *Launcher) jailPath(id string) string {
	switch id {
	case ".":
		id = "%2e"
	case "..":
		id = "%2e%2e"
	}
	return filepath.Join(l.Work, "jail", id)
}

func (l *Launcher) reserve(id string, shape Shape, imageSHA string) (*VM, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	dir := filepath.Dir(l.recordPath(id))
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	if _, err := os.Lstat(l.jailPath(id)); !errors.Is(err, os.ErrNotExist) {
		if err != nil {
			return nil, err
		}
		return nil, fmt.Errorf("jail for VM %q already exists", id)
	}
	var used [MaxSlots]bool
	for _, entry := range entries {
		recordID, ok := strings.CutSuffix(entry.Name(), ".json")
		if !ok {
			continue
		}
		if recordID == id {
			return nil, fmt.Errorf("VM %q already exists", id)
		}
		record, err := l.readRecord(recordID)
		if err != nil {
			return nil, err
		}
		used[record.Slot] = true
	}
	for slot, taken := range used {
		if taken {
			continue
		}
		addr, _ := JobAddress(slot)
		if _, err := tapIndex(addr.Tap); !errors.Is(err, unix.ENODEV) {
			if err != nil {
				return nil, err
			}
			continue
		}
		r := VMRecord{id, slot, addr.Tap, l.jailPath(id), scopeName(id), time.Now().UTC(), imageSHA, shape}
		if err := writeJSON(l.recordPath(id), r, 0600); err != nil {
			return nil, err
		}
		v := &VM{host: l, record: r}
		v.mu.Lock()
		if l.live == nil {
			l.live = make(map[string]*VM)
		}
		l.live[id] = v
		return v, nil
	}
	return nil, errors.New("no free job slot on this host")
}

func scopeName(id string) string { return "camel-vm-" + id + ".scope" }

func (l *Launcher) readRecord(id string) (VMRecord, error) {
	var r VMRecord
	if !jobID.MatchString(id) {
		return r, errors.New("invalid job id")
	}
	data, err := os.ReadFile(l.recordPath(id))
	if err != nil {
		return r, err
	}
	if err := json.Unmarshal(data, &r); err != nil {
		return r, err
	}
	addr, err := JobAddress(r.Slot)
	if err != nil || r.ID != id || r.Tap != addr.Tap || r.Jail != l.jailPath(id) || r.Scope != scopeName(id) {
		return r, fmt.Errorf("invalid VM record for %q", id)
	}
	return r, nil
}

func (l *Launcher) start(ctx context.Context, id string, shape Shape, boot Boot) (*VM, error) {
	if boot.Session && boot.Repo == "" {
		return nil, errors.New("session requires a branch disk")
	}
	path := boot.Image
	if path == "" {
		path = l.Image
	}
	size, err := l.validate(id, shape, path)
	if err != nil {
		return nil, err
	}
	fc, err := filepath.EvalSymlinks(l.Firecracker)
	if err != nil {
		return nil, err
	}
	if !filepath.IsAbs(fc) || !filepath.IsAbs(l.Jailer) {
		return nil, errors.New("Firecracker and jailer paths must be absolute")
	}
	var sha string
	if boot.Image == "" {
		l.imageOnce.Do(func() { l.imageSHA, l.imageErr = imageSHA(path) })
		sha, err = l.imageSHA, l.imageErr
	} else {
		// The compute host verified and atomically published this image by SHA.
		sha = strings.TrimSuffix(filepath.Base(path), ".ext4")
	}
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	v, err := l.reserve(id, shape, sha)
	if err != nil {
		return nil, err
	}
	err = v.prepareAndLaunch(ctx, fc, path, size, boot)
	if err != nil {
		err = errors.Join(err, v.destroyLocked(context.Background()))
	}
	v.mu.Unlock()
	if err != nil {
		return nil, err
	}
	return v, nil
}

func jailerVMID(id string) string {
	if jailerID.MatchString(id) {
		return id
	}
	return fmt.Sprintf("%x", sha256.Sum256([]byte(id)))
}

func jailRoot(r VMRecord, fc string) string {
	return filepath.Join(r.Jail, filepath.Base(fc), jailerVMID(r.ID), "root")
}

func (v *VM) prepareAndLaunch(ctx context.Context, fc, imagePath string, size int64, boot Boot) error {
	l, r := v.host, v.record
	uid := l.uidBase() + r.Slot
	v.root = jailRoot(r, fc)
	if err := os.MkdirAll(filepath.Dir(r.Jail), 0700); err != nil {
		return err
	}
	if err := os.Mkdir(r.Jail, 0700); err != nil {
		return err
	}
	v.jailOwned = true
	if err := os.MkdirAll(v.root, 0700); err != nil {
		return err
	}
	files := configFiles{kernel: "/kernel", disk: "/root.ext4", vsock: "guest.vsock"}
	disk := filepath.Join(v.root, files.disk)
	if err := cloneDisk(ctx, imagePath, disk, size, l.Reflink); err != nil {
		return err
	}
	if err := os.Chown(disk, uid, uid); err != nil {
		return err
	}
	if err := mountAsset(l.Kernel, filepath.Join(v.root, files.kernel), true, uid); err != nil {
		return err
	}
	if l.Initrd != "" {
		files.initrd = "/initrd"
		if err := mountAsset(l.Initrd, filepath.Join(v.root, files.initrd), true, uid); err != nil {
			return err
		}
	}
	if boot.Repo != "" {
		files.repo = "/repo"
		if boot.Session {
			if err := os.Chown(boot.Repo, uid, uid); err != nil {
				return err
			}
		}
		if err := mountAsset(boot.Repo, filepath.Join(v.root, files.repo), false, uid); err != nil {
			return err
		}
	}
	addr, _ := JobAddress(r.Slot)
	if err := TapUp(addr, uid); err != nil {
		return fmt.Errorf("tap %s: %w", addr.Tap, err)
	}
	v.tapOwned = true
	if err := writePolicy(l.PolicyDir, addr.GuestIP, l.policy(r.ID, boot.Internet)); err != nil {
		return err
	}
	config := firecrackerConfig(files, addr, r.Shape, l.Build, l.KVM, boot.Internet, boot.Session)
	if err := writeJSON(filepath.Join(v.root, "config.json"), config, 0644); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(l.logPath(r.ID)), 0700); err != nil {
		return err
	}
	log, err := os.OpenFile(l.logPath(r.ID), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer log.Close()
	if err := ctx.Err(); err != nil {
		return err
	}
	// systemd-run moves itself into the scope before exec. The scope owns the
	// process lifetime, so the boot context must not own the command.
	uidArg := strconv.Itoa(uid)
	cmd := exec.Command("systemd-run", "--scope", "--slice=system.slice", "--unit="+r.Scope,
		"--property=KillMode=control-group", "--property=TimeoutStopSec=3s",
		"--", l.Jailer, "--id", jailerVMID(r.ID), "--exec-file", fc, "--uid", uidArg, "--gid", uidArg,
		"--chroot-base-dir", r.Jail, "--cgroup-version", "2", "--parent-cgroup", "system.slice/"+r.Scope,
		"--", "--no-api", "--config-file", "/config.json", "--level", "Warning")
	cmd.Stdout, cmd.Stderr = log, log
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	v.scopeAttempted = true
	v.cmd = cmd
	v.exited = make(chan struct{})
	go func() {
		v.exitErr = cmd.Wait()
		close(v.exited)
	}()
	return nil
}

func imageSHA(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// Exited reports an exited child or an adopted scope that is no longer present.
func (v *VM) Exited() bool {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.exited != nil {
		select {
		case <-v.exited:
			return true
		default:
			return false
		}
	}
	_, err := os.Stat(filepath.Join("/sys/fs/cgroup/system.slice", v.record.Scope, "cgroup.events"))
	return errors.Is(err, os.ErrNotExist)
}

// Subscribe returns a stream completion signal for this exec attachment. A
// replacement attachment or a disconnected guest channel also closes it.
func (v *VM) Subscribe(ctx context.Context, req any, event EventFunc) (Reply, <-chan struct{}, error) {
	c, err := v.getChannel(ctx)
	if err != nil {
		return nil, nil, err
	}
	return c.exchange(ctx, req, nil, event)
}
