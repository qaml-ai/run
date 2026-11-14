package compute

import (
	"context"
	"errors"
	"expvar"
	"net/http"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/smithy-go/middleware"
	smithyhttp "github.com/aws/smithy-go/transport/http"
)

var ErrClockSkew = errors.New("DynamoDB clock check failed")

var clockSkewRefusals = expvar.NewInt("camelfsd_clock_skew_refused")

type clockObservation struct {
	sync.Mutex
	at, lastWarning time.Time
	skew            time.Duration
}

// MONEY: Observe the Date header on each DynamoDB response, including SDK retries.
// Call before serving requests. Use the wall clock, independent of the lifecycle test clock.
func (c *Controller) EnableClockCheck() {
	c.clock = &clockObservation{}
	clock := c.clock
	opts := c.DB.Options()
	opts.APIOptions = append(opts.APIOptions, func(stack *middleware.Stack) error {
		return stack.Deserialize.Add(middleware.DeserializeMiddlewareFunc("ComputeClock", func(ctx context.Context, in middleware.DeserializeInput, next middleware.DeserializeHandler) (middleware.DeserializeOutput, middleware.Metadata, error) {
			return clock.observe(ctx, in, next)
		}), middleware.Before)
	})
	c.DB = dynamodb.New(opts)
}

func (o *clockObservation) observe(ctx context.Context, in middleware.DeserializeInput, next middleware.DeserializeHandler) (middleware.DeserializeOutput, middleware.Metadata, error) {
	out, meta, err := next.HandleDeserialize(ctx, in)
	if response, ok := out.RawResponse.(*smithyhttp.Response); ok {
		if date, err := http.ParseTime(response.Header.Get("Date")); err == nil {
			o.Lock()
			now := time.Now()
			o.at, o.skew = now, now.Sub(date)
			o.Unlock()
		}
	}
	return out, meta, err
}

// ClockCheckEnabled reports whether EnableClockCheck instrumented this controller's DynamoDB client.
func (c *Controller) ClockCheckEnabled() bool { return c.clock != nil }

// MONEY: Fail closed before minting a usage ULID. Date has one-second granularity.
func (c *Controller) requireClock(ctx context.Context, id string) error {
	// MONEY: no instrumented client means no observation: fail closed.
	if c.clock == nil {
		clockSkewRefusals.Add(1)
		c.log("clock_skew_refused", map[string]any{"reason": "clock check not enabled"})
		return ErrClockSkew
	}
	c.clock.Lock()
	stale := time.Since(c.clock.at) >= time.Minute
	c.clock.Unlock()
	if stale {
		// A Get already made by the caller normally refreshed this observation.
		if _, err := c.Get(ctx, id); err != nil && !errors.Is(err, ErrNotFound) {
			c.log("clock_probe_failed", map[string]any{"error": err.Error()})
		}
	}
	c.clock.Lock()
	now := time.Now()
	skew := c.clock.skew
	stale = now.Sub(c.clock.at) >= time.Minute
	bad := stale || skew > 6*time.Second || skew < -6*time.Second
	warn := bad && now.Sub(c.clock.lastWarning) >= time.Minute
	if warn {
		c.clock.lastWarning = now
	}
	c.clock.Unlock()
	if !bad {
		return nil
	}
	clockSkewRefusals.Add(1)
	fields := map[string]any{"skewMs": skew.Milliseconds(), "stale": stale}
	c.log("clock_skew_refused", fields)
	if warn {
		c.log("clock_skew", fields)
	}
	return ErrClockSkew
}
