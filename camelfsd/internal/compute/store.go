package compute

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/qaml-ai/run/camelfsd/internal/ddb"
)

type attrs = map[string]types.AttributeValue

func s(value string) types.AttributeValue { return &types.AttributeValueMemberS{Value: value} }
func n(value int64) types.AttributeValue {
	return &types.AttributeValueMemberN{Value: strconv.FormatInt(value, 10)}
}
func b(value bool) types.AttributeValue        { return &types.AttributeValueMemberBOOL{Value: value} }
func ss(values ...string) types.AttributeValue { return &types.AttributeValueMemberSS{Value: values} }
func m(value attrs) types.AttributeValue       { return &types.AttributeValueMemberM{Value: value} }

type item attrs

func (i item) text(key string) string {
	value, _ := i[key].(*types.AttributeValueMemberS)
	if value != nil {
		return value.Value
	}
	return ""
}

func (i item) timestamp(key string) *int64 {
	value, _ := i[key].(*types.AttributeValueMemberN)
	if value == nil {
		return nil
	}
	number, err := strconv.ParseInt(value.Value, 10, 64)
	if err != nil {
		return nil
	}
	return &number
}

func (i item) number(key string) int64 { return aws.ToInt64(i.timestamp(key)) }
func (i item) flag(key string) bool {
	value, _ := i[key].(*types.AttributeValueMemberBOOL)
	return value != nil && value.Value
}

func (i item) object(key string) item {
	value, _ := i[key].(*types.AttributeValueMemberM)
	if value != nil {
		return value.Value
	}
	return nil
}

func (i item) set(key string) []string {
	value, _ := i[key].(*types.AttributeValueMemberSS)
	if value != nil {
		return value.Value
	}
	return nil
}

func (i item) list(key string) []string {
	value, _ := i[key].(*types.AttributeValueMemberL)
	if value == nil {
		return nil
	}
	result := make([]string, 0, len(value.Value))
	for _, v := range value.Value {
		if str, ok := v.(*types.AttributeValueMemberS); ok {
			result = append(result, str.Value)
		}
	}
	return result
}

func shapeItem(shape Shape) types.AttributeValue {
	return m(attrs{"vcpus": n(int64(shape.VCPUs)), "memoryMiB": n(int64(shape.MemoryMiB)), "diskGiB": n(int64(shape.DiskGiB)), "diskMiB": n(int64(shape.DiskMiB))})
}

func readShape(i item) Shape {
	return Shape{VCPUs: int(i.number("vcpus")), MemoryMiB: int(i.number("memoryMiB")), DiskGiB: int(i.number("diskGiB")), DiskMiB: int(i.number("diskMiB"))}
}

func vmItem(v VM) attrs {
	i := attrs{
		"id": s(v.ID), "phase": s(string(v.Phase)), "lineage": s(v.Lineage), "ref": s(v.Ref), "version": s(v.Version),
		"image": s(v.Image), "shape": shapeItem(v.Shape), "pool": s(v.Pool), "payer": s(v.Payer),
		"createdAt": n(v.CreatedAt), "leaseDeadline": n(v.LeaseDeadline),
		"requestedVersion": s(v.Version), "requestedDeadline": n(v.LeaseDeadline), "internet": b(v.Internet),
	}
	if v.Session != nil {
		i["session"] = m(attrs{"idleStopS": n(v.Session.IdleStopS)})
	}
	return i
}

func readVM(i item) VM {
	deadline := i.number("leaseDeadline")
	req := CreateRequest{
		ID: i.text("id"), Lineage: i.text("lineage"), Ref: i.text("ref"), Version: i.text("version"),
		Image: i.text("image"), Shape: readShape(i.object("shape")), Pool: i.text("pool"),
		Payer: i.text("payer"), Internet: i.flag("internet"), Deadline: time.UnixMilli(deadline).UTC(),
	}
	if session := i.object("session"); session != nil {
		req.Session = &Session{IdleStopS: session.number("idleStopS")}
	}
	return VM{
		CreateRequest: req, Phase: Phase(i.text("phase")), CreatedAt: i.number("createdAt"), LeaseDeadline: deadline,
		Host: i.text("host"), HostEpoch: i.number("hostEpoch"), PlacedAt: i.timestamp("placedAt"),
		BootingAt: i.timestamp("bootingAt"), StartedAt: i.timestamp("startedAt"),
		LastListedAt: i.timestamp("lastListedAt"), LastActivityAt: i.timestamp("lastActivityAt"), StopRequestedAt: i.timestamp("stopRequestedAt"), EndedAt: i.timestamp("endedAt"),
		StopCheckpoint: i.flag("stopCheckpoint"), StopReason: EndCode(i.text("stopReason")), Code: EndCode(i.text("code")),
		ResultRef: i.text("resultRef"), EndVersion: i.text("endVersion"),
		CheckpointError: i.text("checkpointError"), ResultSha256: i.text("resultSha256"), ResultBytes: i.number("resultBytes"),
		FirstExecAt: i.timestamp("firstExecAt"), execs: i.set("execs"), seenExecs: i.set("seenExecs"),
		RequestedVersion: i.text("requestedVersion"), RequestedDeadline: i.number("requestedDeadline"),
		Tree: i.text("tree"), RefLeaseHolder: i.text("refLeaseHolder"), RefLeaseEpoch: i.number("refLeaseEpoch"),
		RefLeaseDeadline: i.number("refLeaseDeadline"), RefLeaseReleased: i.flag("refLeaseReleased"), BilledTo: i.number("billedTo"), UsageSeq: i.number("usageSeq"),
	}
}

func (c *Controller) now() time.Time {
	if c.Now == nil {
		return time.Now()
	}
	return c.Now()
}

func vmKey(id string) attrs           { return attrs{"id": s(id)} }
func hostKey(pool, host string) attrs { return attrs{"pool": s(pool), "host": s(host)} }

var aliasPattern = regexp.MustCompile(`#[a-zA-Z][a-zA-Z0-9]*`)

func aliases(expressions ...string) map[string]string {
	names := map[string]string{}
	for _, expr := range expressions {
		for _, name := range aliasPattern.FindAllString(expr, -1) {
			names[name] = name[1:]
		}
	}
	return names
}

func put(table string, i attrs, cond string) types.TransactWriteItem {
	return types.TransactWriteItem{Put: &types.Put{
		TableName: aws.String(table), Item: i, ConditionExpression: aws.String(cond), ExpressionAttributeNames: aliases(cond),
	}}
}

func change(table string, key attrs, cond, expr string, values attrs) *types.Update {
	return &types.Update{TableName: aws.String(table), Key: key, ConditionExpression: aws.String(cond),
		UpdateExpression: aws.String(expr), ExpressionAttributeNames: aliases(cond, expr), ExpressionAttributeValues: values}
}

func noRetry(o *dynamodb.Options) { o.Retryer = aws.NopRetryer{} }

func (c *Controller) wrote(err error) error {
	if ddb.IsConditionFailed(err) {
		return fmt.Errorf("%w: %w", ErrCondition, err)
	}
	if err == nil && c.afterWrite != nil {
		return c.afterWrite()
	}
	return err
}

// transactIdempotent lets the SDK retry an ambiguous failure under a ClientRequestToken. DynamoDB answers a retry of a
// transaction that already committed with success (within its 10-minute token window) instead of a lost condition, so
// a committed usage event is never reported to the caller as a failure.
func (c *Controller) transactIdempotent(ctx context.Context, token string, writes ...types.TransactWriteItem) error {
	_, err := c.DB.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{TransactItems: writes, ClientRequestToken: aws.String(token)})
	return c.wrote(err)
}

func (c *Controller) transact(ctx context.Context, writes ...types.TransactWriteItem) error {
	_, err := c.DB.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{TransactItems: writes}, noRetry)
	return c.wrote(err)
}

func (c *Controller) update(ctx context.Context, u *types.Update) (item, error) {
	out, err := c.DB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: u.TableName, Key: u.Key, ConditionExpression: u.ConditionExpression, UpdateExpression: u.UpdateExpression,
		ExpressionAttributeNames: u.ExpressionAttributeNames, ExpressionAttributeValues: u.ExpressionAttributeValues,
		ReturnValues: types.ReturnValueAllNew,
	}, noRetry)
	if err := c.wrote(err); err != nil {
		return nil, err
	}
	return out.Attributes, nil
}

func (c *Controller) read(ctx context.Context, table string, key attrs) (item, error) {
	out, err := c.DB.GetItem(ctx, &dynamodb.GetItemInput{TableName: aws.String(table), Key: key, ConsistentRead: aws.Bool(true)})
	if err != nil {
		return nil, err
	}
	if len(out.Item) == 0 {
		return nil, ErrNotFound
	}
	return out.Item, nil
}

func (c *Controller) updateVM(ctx context.Context, id, cond, expr string, values attrs) (VM, error) {
	i, err := c.update(ctx, change(c.Tables.VMs, vmKey(id), cond, expr, values))
	if err != nil {
		return VM{}, err
	}
	return readVM(i), nil
}

func (c *Controller) Get(ctx context.Context, id string) (VM, error) {
	i, err := c.read(ctx, c.Tables.VMs, vmKey(id))
	if err != nil {
		return VM{}, err
	}
	return readVM(i), nil
}
