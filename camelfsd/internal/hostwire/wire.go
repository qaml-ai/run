// Package hostwire defines the compute protocol between the API tier and hosts.
// Hosts send callbacks over mTLS to the tier's private host listener.
// The tier reads the host identity from the verified TLS client certificate.
package hostwire

type Shape struct {
	VCPUs     int `json:"vcpus"`
	MemoryMiB int `json:"memoryMiB"`
	DiskMiB   int `json:"diskMiB"`
}

// Register announces a host boot. Addr is the host's compute listener (host:8792).
// Images lists guest images already verified on this host.
type Register struct {
	BootID   string   `json:"bootId"`
	Pool     string   `json:"pool"`
	Addr     string   `json:"addr"`
	Shape    Shape    `json:"shape"`
	Slots    int      `json:"slots"`
	Features []string `json:"features"`
	Images   []string `json:"images"`
}

type Registered struct {
	BootEpoch int64 `json:"bootEpoch"`
}

// Heartbeat is sent one at a time. The host applies a reply only if its
// request's BootEpoch is still current. Times are Unix milliseconds on the host clock.
// For C4's in-VPC CAS, the host sends {holder, epoch} in the body under mTLS,
// with no fence token. The tier accepts it only if holder.host matches the
// certificate's host id and holder.boot matches that host's registered boot epoch.
type Heartbeat struct {
	BootEpoch int64     `json:"bootEpoch"`
	At        int64     `json:"at"`
	Free      int       `json:"free"`
	Running   []Running `json:"running"`
}

// Running includes every VM record the host retains. The host keeps the record,
// lists it (Finished: true once done), and refuses a boot of that id until the
// tier acknowledges Ended with a 2xx. The host resends Ended until then.
type Running struct {
	ID        string `json:"id"`
	StartedAt *int64 `json:"startedAt,omitempty"`
	Finished  bool   `json:"finished"`
}

// HeartbeatReply lists in Boot only placed or booting VMs assigned to this
// host and epoch and absent from this heartbeat's Running.
type HeartbeatReply struct {
	BootEpoch int64      `json:"bootEpoch"`
	Stop      []string   `json:"stop"`
	Boot      []BootSpec `json:"boot"`
}

// BootSpec is also the body of POST https://<addr>/v1/vms. Image is the only
// image pin: the host boots exactly this required 64-hex SHA after verifying
// the bytes against guest/<sha>.json. The host has no image pin of its own.
type BootSpec struct {
	ID       string   `json:"id"`
	Lineage  string   `json:"lineage"`
	Ref      string   `json:"ref"`
	Version  string   `json:"version"`
	Tree     string   `json:"tree"`
	Parent   string   `json:"parent"`
	Image    string   `json:"image"`
	Lease    Lease    `json:"lease"`
	Shape    Shape    `json:"shape"`
	Internet bool     `json:"internet"`
	Session  *Session `json:"session,omitempty"`
	Deadline int64    `json:"deadline"`
}

type Lease struct {
	Holder   Holder `json:"holder"`
	Epoch    int64  `json:"epoch"`
	Deadline int64  `json:"deadline"`
}

type Session struct {
	IdleStopS int64 `json:"idleStopS"`
}

type Started struct {
	BootEpoch int64 `json:"bootEpoch"`
	At        int64 `json:"at"`
}

// Ended reports a stopped session or a failed boot.
type Ended struct {
	BootEpoch       int64  `json:"bootEpoch"`
	At              int64  `json:"at"`
	Code            string `json:"code"`
	Version         string `json:"version"`
	CheckpointError string `json:"checkpointError"`
}

// Stop is the body of POST https://<addr>/v1/vms/{id}/stop.
type Stop struct {
	Checkpoint bool `json:"checkpoint"`
}

// Renew asks for a fresh certificate using the host's current mTLS identity.
// Hosts renew every eight hours.
type Renew struct {
	CSR string `json:"csr"`
}

// Enrolled is the reply to both initial enrollment and renewal. NotAfter is Unix milliseconds.
type Enrolled struct {
	CertificatePEM string `json:"certificatePem"`
	ChainPEM       string `json:"chainPem"`
	CAPEM          string `json:"caPem"`
	NotAfter       int64  `json:"notAfter"`
	HostID         string `json:"hostId"`
}
