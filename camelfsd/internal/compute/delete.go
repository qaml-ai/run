package compute

import (
	"context"
	"errors"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
)

// EndDeletedVMs cleans up VMs after a successful ref or lineage deletion.
func (c *Controller) EndDeletedVMs(ctx context.Context, lineage, ref, reason string) {
	logFailure := func(id string, err error) {
		c.log("vm_delete_cleanup_failed", map[string]any{"vm": id, "lineage": lineage, "ref": ref,
			"reason": reason, "error": err.Error()})
	}
	const cond = "#lineage = :l"
	pages := dynamodb.NewQueryPaginator(c.DB, &dynamodb.QueryInput{
		TableName: aws.String(c.Tables.VMs), IndexName: aws.String(c.Tables.VMLineageIndex),
		KeyConditionExpression: aws.String(cond), ExpressionAttributeNames: aliases(cond),
		ExpressionAttributeValues: attrs{":l": s(lineage)},
	})
	for pages.HasMorePages() {
		page, err := pages.NextPage(ctx)
		if err != nil {
			logFailure("", err)
			return
		}
		for _, row := range page.Items {
			i := item(row)
			phase := Phase(i.text("phase"))
			if phase == Stopping || phase == Ended || (ref != "" && i.text("ref") != ref) {
				continue
			}
			id := i.text("id")
			if err := c.endDeletedVM(ctx, id, reason); err != nil {
				logFailure(id, err)
			}
		}
	}
}

func (c *Controller) endDeletedVM(ctx context.Context, id, reason string) error {
	// The index is eventually consistent. Use the base row to decide which
	// transition to make and re-evaluate if the VM advances during cleanup.
	v, err := c.Get(ctx, id)
	for err == nil {
		now := c.now()
		switch v.Phase {
		case Requested, Placed:
			_, err = c.end(ctx, v, EndRequest{At: now, Code: StartFailed, Reason: reason}, now, nil)
		case Booting, Running:
			// MONEY: billing ends at the stop request (now). No checkpoint: its ref is gone, so a CAS could not land.
			// The stop's code stays in the EndCode set (Stopped); the delete reason is in the log line below.
			_, err = c.stop(ctx, v, now, now.UnixMilli(), Stopped, false)
			if err == nil {
				c.log("vm_stopped_for_delete", map[string]any{"vm": id, "reason": reason})
			}
		case Stopping, Ended:
			return nil
		default:
			return ErrPhase
		}
		if !errors.Is(err, ErrCondition) {
			return err
		}
		current, readErr := c.Get(ctx, id)
		if readErr != nil {
			return readErr
		}
		if current.Phase == v.Phase && current.LeaseDeadline == v.LeaseDeadline {
			return err
		}
		v, err = current, nil
	}
	return err
}
