package image

import (
	"context"
	"fmt"
	"os"
	"time"
)

func (m *Manager) swap(ctx context.Context, v *Mount) error {
	if v.DestLoop == "" {
		loop, e := run(ctx, "losetup", "-f", "--show", v.Dest)
		if e != nil {
			return e
		}
		v.DestLoop = loop
		if e = m.save(v); e != nil {
			return e
		}
	}
	st, e := os.Stat(v.Dest)
	if e != nil {
		return e
	}
	t := time.Now()
	if _, e = run(ctx, "dmsetup", "suspend", v.OriginDM); e != nil {
		return e
	}
	_, e = run(ctx, "dmsetup", "reload", v.OriginDM, "--table", fmt.Sprintf("0 %d linear %s 0", st.Size()/512, v.DestLoop))
	resumeCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_, re := run(resumeCtx, "dmsetup", "resume", v.OriginDM)
	if e != nil {
		return e
	}
	if re != nil {
		return re
	}
	v.SwapMs = ms(t)
	// Save attachment state before detach; cleanup can retry a failed detach.
	if v.NBD != "" {
		if _, e = run(ctx, "nbd-client", "-d", v.NBD); e != nil {
			return e
		}
		v.NBD = ""
	}
	if v.releaseOrigin != nil {
		v.releaseOrigin()
		v.releaseOrigin = nil
	}
	v.State = "hydrated"
	v.Hydrating = false
	v.HydrationError = ""
	return m.save(v)
}
