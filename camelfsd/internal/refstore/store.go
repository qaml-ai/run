// Package refstore stores lineage-scoped refs and fences in DynamoDB.
package refstore

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/qaml-ai/run/camelfsd/internal/ddb"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

type Client interface {
	GetItem(context.Context, *dynamodb.GetItemInput, ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error)
	UpdateItem(context.Context, *dynamodb.UpdateItemInput, ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error)
	Query(context.Context, *dynamodb.QueryInput, ...func(*dynamodb.Options)) (*dynamodb.QueryOutput, error)
}

type Commits interface {
	Parents(ctx context.Context, lineage, id string) (parents []string, found bool, err error)
}

type Store struct {
	client  Client
	table   *string
	now     func() time.Time
	commits Commits
	guard   *string
}

func New(client Client, table string, now func() time.Time, commits Commits) *Store {
	if now == nil {
		now = time.Now
	}
	return &Store{client: client, table: aws.String(table), now: now, commits: commits}
}

// GuardLineages guards ref creation and identifies the lineage table for stamp recovery.
func (s *Store) GuardLineages(table string) {
	s.guard = aws.String(table)
}

type transactionClient interface {
	TransactWriteItems(context.Context, *dynamodb.TransactWriteItemsInput, ...func(*dynamodb.Options)) (*dynamodb.TransactWriteItemsOutput, error)
}

type Target struct {
	Version, Tree, Root string
}

type Ref struct {
	Lineage, Name, CreatedBy string
	Target
	Owner, Holder                    *string
	ExpiresAt, LeaseDeadline         *int64
	LeaseEpoch, CreatedAt, UpdatedAt int64
	Watchers                         []string
}

func (r Ref) held(now int64) bool {
	return r.Holder != nil && r.LeaseDeadline != nil && *r.LeaseDeadline > now
}

func (r Ref) live(now int64) bool {
	return r.Version != "" && (r.ExpiresAt == nil || *r.ExpiresAt > now || r.held(now))
}

type Error struct {
	Code    string
	Status  int
	Details map[string]any
}

func (e *Error) Error() string { return e.Code }

func failure(code string, status int) *Error {
	return &Error{Code: code, Status: status}
}

func fenced(r Ref, now int64) *Error {
	var holder, epoch any
	if r.held(now) {
		holder, epoch = *r.Holder, r.LeaseEpoch
	}
	return &Error{Code: "fenced", Status: 409, Details: map[string]any{"holder": holder, "epoch": epoch}}
}

func stale(r Ref, now int64) *Error {
	var version any
	if r.live(now) {
		version = r.Version
	}
	return &Error{Code: "stale", Status: 412, Details: map[string]any{"current": version}}
}

func current(r Ref, now int64) *string {
	if r.live(now) {
		return &r.Version
	}
	return nil
}

var namePattern = regexp.MustCompile(`^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$`)
var ownerPattern = regexp.MustCompile(`^(agent|workflow|job|user|api|cache):[A-Za-z0-9._:-]{1,200}$`)

// ValidName mirrors the RepoDO ref-name rules.
func ValidName(name string) bool {
	if len(name) > 200 || !namePattern.MatchString(name) {
		return false
	}
	for _, segment := range strings.Split(name, "/") {
		if segment == "." || segment == ".." || strings.HasSuffix(segment, ".lock") {
			return false
		}
	}
	return true
}

func ValidOwner(owner string) bool { return ownerPattern.MatchString(owner) }

func validate(lineage, name string) error {
	if !store.Lineage(lineage) || !ValidName(name) {
		return failure("invalid", 400)
	}
	return nil
}

func validateTarget(version, tree, rootID string, owner *string) error {
	if !root.Hex(version, 40) || !root.Hex(tree, 40) || (rootID != "" && !root.Hex(rootID, 64)) ||
		(owner != nil && !ownerPattern.MatchString(*owner)) {
		return failure("invalid", 400)
	}
	return nil
}

type attributes = map[string]types.AttributeValue

func str(s string) types.AttributeValue { return &types.AttributeValueMemberS{Value: s} }
func num(n int64) types.AttributeValue {
	return &types.AttributeValueMemberN{Value: strconv.FormatInt(n, 10)}
}

func key(lineage, name string) attributes {
	return attributes{"lineage": str(lineage), "name": str(name)}
}

func decode(item attributes) (Ref, error) {
	var err error
	stringPtr := func(field string) *string {
		if v, ok := item[field].(*types.AttributeValueMemberS); ok {
			return &v.Value
		}
		return nil
	}
	numberPtr := func(field string) *int64 {
		v, ok := item[field].(*types.AttributeValueMemberN)
		if !ok {
			return nil
		}
		n, parseErr := strconv.ParseInt(v.Value, 10, 64)
		if parseErr != nil {
			err = fmt.Errorf("invalid ref %s: %w", field, parseErr)
		}
		return &n
	}
	r := Ref{
		Lineage: aws.ToString(stringPtr("lineage")), Name: aws.ToString(stringPtr("name")), CreatedBy: aws.ToString(stringPtr("createdBy")),
		Target: Target{Version: aws.ToString(stringPtr("version")), Tree: aws.ToString(stringPtr("tree")), Root: aws.ToString(stringPtr("root"))},
		Owner:  stringPtr("owner"), Holder: stringPtr("holder"),
		ExpiresAt: numberPtr("expiresAt"), LeaseDeadline: numberPtr("leaseDeadline"),
		LeaseEpoch: aws.ToInt64(numberPtr("leaseEpoch")), CreatedAt: aws.ToInt64(numberPtr("createdAt")),
		UpdatedAt: aws.ToInt64(numberPtr("updatedAt")),
	}
	if v, ok := item["watchers"].(*types.AttributeValueMemberSS); ok {
		r.Watchers = v.Value
	}
	return r, err
}

func (s *Store) readItem(ctx context.Context, lineage, name string) (attributes, error) {
	out, err := s.client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: s.table, Key: key(lineage, name), ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return nil, err
	}
	return out.Item, nil
}

func (s *Store) read(ctx context.Context, lineage, name string) (Ref, error) {
	item, err := s.readItem(ctx, lineage, name)
	if err != nil {
		return Ref{}, err
	}
	return decode(item)
}

func (s *Store) Get(ctx context.Context, lineage, name string) (Ref, error) {
	if err := validate(lineage, name); err != nil {
		return Ref{}, err
	}
	r, err := s.read(ctx, lineage, name)
	if err == nil && !r.live(s.now().UnixMilli()) {
		return Ref{}, failure("no_ref", 404)
	}
	return r, err
}

const unheld = "(attribute_not_exists(#holder) OR attribute_not_exists(#leaseDeadline) OR #leaseDeadline <= :now)"
const expired = "(#expiresAt <= :now AND " + unheld + ")"
const live = "(attribute_exists(#version) AND (attribute_not_exists(#expiresAt) OR #expiresAt > :now OR NOT " + unheld + "))"
const absent = "(attribute_not_exists(#version) OR " + expired + ")"
const heldBy = "(#holder = :holder AND #leaseEpoch = :epoch AND #leaseDeadline > :now)"

var attributeAlias = regexp.MustCompile(`#[a-zA-Z]+`)

type writeClass uint8

const (
	existingRef writeClass = iota
	createRef
)

func (s *Store) update(ctx context.Context, class writeClass, lineage, name, condition, update string, values attributes, returns types.ReturnValue) (*dynamodb.UpdateItemOutput, error) {
	return s.updateTimed(ctx, class, lineage, name, condition, update, values, returns, nil)
}

func (s *Store) updateTimed(ctx context.Context, class writeClass, lineage, name, condition, update string, values attributes, returns types.ReturnValue, observe func(time.Duration)) (*dynamodb.UpdateItemOutput, error) {
	if class == existingRef {
		condition = "(" + condition + ") AND attribute_not_exists(#deleting)"
	}
	names := map[string]string{}
	for _, alias := range attributeAlias.FindAllString(condition+" "+update, -1) {
		names[alias] = alias[1:]
	}
	if class == createRef && s.guard != nil {
		input := &dynamodb.TransactWriteItemsInput{
			TransactItems: []types.TransactWriteItem{
				{ConditionCheck: &types.ConditionCheck{
					TableName: s.guard, Key: attributes{"lineage": str(lineage)},
					ConditionExpression:      aws.String(activeLineage),
					ExpressionAttributeNames: map[string]string{"#lineage": "lineage", "#deletion": "deletion", "#deletedAt": "deletedAt"},
				}},
				{Update: &types.Update{
					TableName: s.table, Key: key(lineage, name), ConditionExpression: aws.String(condition),
					UpdateExpression: aws.String(update), ExpressionAttributeNames: names, ExpressionAttributeValues: values,
				}},
			},
		}
		start := time.Now()
		_, err := s.client.(transactionClient).TransactWriteItems(ctx, input)
		if observe != nil {
			observe(time.Since(start))
		}
		var canceled *types.TransactionCanceledException
		if errors.As(err, &canceled) && len(canceled.CancellationReasons) > 0 &&
			aws.ToString(canceled.CancellationReasons[0].Code) == "ConditionalCheckFailed" {
			return nil, failure("lineage_blocked", 409)
		}
		return &dynamodb.UpdateItemOutput{}, err
	}
	input := &dynamodb.UpdateItemInput{
		TableName: s.table, Key: key(lineage, name), ConditionExpression: aws.String(condition),
		UpdateExpression: aws.String(update), ExpressionAttributeNames: names, ExpressionAttributeValues: values,
		ReturnValues: returns,
	}
	if class == existingRef {
		input.ReturnValuesOnConditionCheckFailure = types.ReturnValuesOnConditionCheckFailureAllOld
	}
	for attempt := 0; ; attempt++ {
		start := time.Now()
		out, err := s.client.UpdateItem(ctx, input)
		if observe != nil {
			observe(time.Since(start))
		}
		var failed *types.ConditionalCheckFailedException
		if class != existingRef || !errors.As(err, &failed) {
			return out, err
		}
		item, readErr := s.readItem(ctx, lineage, name)
		if readErr != nil {
			return nil, readErr
		}
		stamp, stamped := item["deleting"].(*types.AttributeValueMemberS)
		if !stamped {
			// The failed write's own image says whether a stamp blocked it. A stamp gone by the reread was removed by a
			// rollback racing this write (the renew-vs-rollback window): retry once against the original condition.
			// An image DynamoDB did not return is treated the same, so a missing ALL_OLD can never surface a stamp as
			// the caller's own condition failure (for Renew, that would read as fenced).
			// An absent item (empty reread) was never stamped: its failure is the caller's own (no_ref, fenced, …).
			blockedByStamp := len(item) > 0 && (len(failed.Item) == 0 || failed.Item["deleting"] != nil)
			if blockedByStamp && attempt == 0 {
				continue
			}
			if blockedByStamp {
				return nil, failure("lineage_blocked", 409)
			}
			return out, err
		}
		if attempt != 0 || s.guard == nil {
			return nil, failure("lineage_blocked", 409)
		}
		line, err := s.client.GetItem(ctx, &dynamodb.GetItemInput{
			TableName: s.guard, Key: attributes{"lineage": str(lineage)}, ConsistentRead: aws.Bool(true),
		})
		if err != nil {
			return nil, err
		}
		deletion, _ := line.Item["deletion"].(*types.AttributeValueMemberS)
		if line.Item["deletedAt"] != nil || (deletion != nil && deletion.Value == stamp.Value) {
			return nil, failure("lineage_blocked", 409)
		}
		// A competing heal or a newer stamp may win the conditional removal.
		// Retry once against the original write condition in either case.
		if err := s.removeStamp(ctx, lineage, name, stamp.Value); err != nil {
			return nil, err
		}
	}
}

func targetUpdate(t Target, owner *string, expiresAt *int64, now int64, create bool) (string, attributes) {
	values := attributes{":version": str(t.Version), ":tree": str(t.Tree), ":now": num(now)}
	set := []string{"#version = :version", "#tree = :tree", "#updatedAt = :now"}
	var remove []string
	if create {
		values[":zero"] = num(0)
		set = append(set, "#createdAt = :now", "#leaseEpoch = if_not_exists(#leaseEpoch, :zero)")
		remove = append(remove, "#holder", "#leaseDeadline", "#watchers")
	}
	if t.Root != "" {
		values[":root"] = str(t.Root)
		set = append(set, "#root = :root")
	} else {
		remove = append(remove, "#root")
	}
	if owner != nil {
		values[":owner"] = str(*owner)
		set = append(set, "#owner = :owner")
	} else if create {
		remove = append(remove, "#owner")
	}
	if expiresAt != nil {
		values[":expires"] = num(*expiresAt)
		set = append(set, "#expiresAt = :expires")
	} else if create {
		remove = append(remove, "#expiresAt")
	}
	expression := "SET " + strings.Join(set, ", ")
	if len(remove) > 0 {
		expression += " REMOVE " + strings.Join(remove, ", ")
	}
	return expression, values
}

func (s *Store) Create(ctx context.Context, lineage, name string, t Target, owner *string, expiresAt *int64) error {
	_, err := s.CreateBy(ctx, lineage, name, t, owner, expiresAt, "")
	return err
}

func (s *Store) CreateBy(ctx context.Context, lineage, name string, t Target, owner *string, expiresAt *int64, subject string) (Ref, error) {
	if err := validate(lineage, name); err != nil {
		return Ref{}, err
	}
	if err := validateTarget(t.Version, t.Tree, t.Root, owner); err != nil {
		return Ref{}, err
	}
	for {
		r, err := s.read(ctx, lineage, name)
		if err != nil {
			return Ref{}, err
		}
		now := s.now().UnixMilli()
		if r.live(now) {
			return Ref{}, failure("exists", 409)
		}
		update, values := targetUpdate(t, owner, expiresAt, now, true)
		values[":subject"], values[":epoch"] = str(subject), num(r.LeaseEpoch)
		update = strings.Replace(update, "SET ", "SET #createdBy = :subject, ", 1)
		_, err = s.update(ctx, createRef, lineage, name, absent+" AND (#leaseEpoch = :epoch OR attribute_not_exists(#leaseEpoch))", update, values, types.ReturnValueNone)
		if ddb.IsConditionFailed(err) {
			continue
		}
		return Ref{Lineage: lineage, Name: name, Target: t, Owner: owner, ExpiresAt: expiresAt,
			LeaseEpoch: r.LeaseEpoch, CreatedAt: now, UpdatedAt: now, CreatedBy: subject}, err
	}
}
