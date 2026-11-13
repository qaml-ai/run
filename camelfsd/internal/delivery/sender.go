package delivery

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/qaml-ai/run/camelfsd/internal/ddb"
)

type Sender struct {
	DB     *dynamodb.Client
	Table  string
	HTTP   *http.Client
	Signer Signer
	Node   string // claimer ID

	Now    func() time.Time
	Lease  time.Duration // defaults to 30 seconds
	MaxAge time.Duration // defaults to 24 hours
	Batch  int           // defaults to 25 claims per shard
	Log    func(event string, fields map[string]any)
}

func (s *Sender) defaults() {
	if s.Now == nil {
		s.Now = time.Now
	}
	if s.Lease <= 0 {
		s.Lease = 30 * time.Second
	}
	if s.MaxAge <= 0 {
		s.MaxAge = 24 * time.Hour
	}
	if s.Batch <= 0 {
		s.Batch = 25
	}
	client := http.DefaultClient
	if s.HTTP != nil {
		client = s.HTTP
	}
	copy := *client
	copy.Timeout = 10 * time.Second
	copy.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	s.HTTP = &copy
}

func (s *Sender) validate() error {
	if s.DB == nil || s.Table == "" || s.Signer == nil || s.Node == "" {
		return errors.New("delivery sender requires DB, Table, Signer and Node")
	}
	return nil
}

// Pass checks every shard for due deliveries and returns the number of POST
// attempts, including HTTP failures. Expired deliveries are dropped.
func (s Sender) Pass(ctx context.Context) (int, error) {
	if err := s.validate(); err != nil {
		return 0, err
	}
	s.defaults()
	return s.pass(ctx)
}

func (s *Sender) pass(ctx context.Context) (sent int, err error) {
	for shard := 0; shard < Shards; shard++ {
		now := number(s.Now().UnixMilli())
		query := &dynamodb.QueryInput{
			TableName:              aws.String(s.Table),
			KeyConditionExpression: aws.String("shard = :shard"),
			FilterExpression:       aws.String("nextAt <= :now AND (claimedUntil = :zero OR claimedUntil < :now)"),
			ProjectionExpression:   aws.String("shard, id"),
			ExpressionAttributeValues: map[string]types.AttributeValue{
				":shard": str(strconv.Itoa(shard)), ":now": now, ":zero": number(0),
			},
		}
		remaining := s.Batch
		for remaining > 0 {
			query.Limit = aws.Int32(int32(min(remaining, 25)))
			page, err := s.DB.Query(ctx, query)
			if err != nil {
				return sent, fmt.Errorf("query deliveries: %w", err)
			}
			for _, item := range page.Items {
				claim, err := s.claim(ctx, item)
				if err != nil {
					return sent, err
				}
				if claim == nil {
					continue
				}
				remaining--
				posted, err := s.deliver(ctx, claim)
				if posted {
					sent++
				}
				if err != nil {
					return sent, err
				}
			}
			if len(page.LastEvaluatedKey) == 0 {
				break
			}
			query.ExclusiveStartKey = page.LastEvaluatedKey
		}
	}
	return sent, nil
}

type claimedDelivery struct {
	Delivery
	key       map[string]types.AttributeValue
	createdAt time.Time
	attempts  int64
	lastError string
}

func (s *Sender) claim(ctx context.Context, itemKey map[string]types.AttributeValue) (*claimedDelivery, error) {
	now := s.Now()
	result, err := s.DB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: aws.String(s.Table), Key: itemKey,
		ConditionExpression: aws.String("nextAt <= :now AND (claimedUntil = :zero OR claimedUntil < :now)"),
		UpdateExpression:    aws.String("SET claimedUntil = :until, claimer = :node, attempts = attempts + :one"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":now": number(now.UnixMilli()), ":zero": number(0), ":until": number(now.Add(s.Lease).UnixMilli()),
			":node": str(s.Node), ":one": number(1),
		},
		ReturnValues: types.ReturnValueAllNew,
	})
	if ddb.IsConditionFailed(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("claim delivery: %w", err)
	}
	item := result.Attributes
	id, idOK := item["id"].(*types.AttributeValueMemberS)
	target, urlOK := item["url"].(*types.AttributeValueMemberS)
	body, bodyOK := item["body"].(*types.AttributeValueMemberB)
	createdAt, createdOK := item["createdAt"].(*types.AttributeValueMemberN)
	attempts, attemptsOK := item["attempts"].(*types.AttributeValueMemberN)
	lastError, errorOK := item["lastError"].(*types.AttributeValueMemberS)
	if !idOK || !urlOK || !bodyOK || !createdOK || !attemptsOK || !errorOK {
		return nil, errors.New("claimed delivery has invalid attributes")
	}
	createdMs, createdErr := strconv.ParseInt(createdAt.Value, 10, 64)
	count, countErr := strconv.ParseInt(attempts.Value, 10, 64)
	if createdErr != nil || countErr != nil {
		return nil, errors.New("claimed delivery has invalid timestamps or attempts")
	}
	return &claimedDelivery{
		Delivery: Delivery{ID: id.Value, URL: target.Value, Body: body.Value},
		key:      itemKey, createdAt: time.UnixMilli(createdMs), attempts: count, lastError: lastError.Value,
	}, nil
}

// The attempt also fences a stale completion when a node ID is reused.
const ownsClaim = "claimer = :node AND attempts = :attempt"

func (s *Sender) deliver(ctx context.Context, claim *claimedDelivery) (bool, error) {
	if s.Now().Sub(claim.createdAt) > s.MaxAge {
		deleted, err := s.delete(ctx, claim)
		if deleted {
			host := ""
			if target, parseErr := url.Parse(claim.URL); parseErr == nil {
				host = target.Hostname()
			}
			s.log("delivery_dropped", map[string]any{
				"id": claim.ID, "url": host, "attempts": claim.attempts, "lastError": claim.lastError,
			})
		}
		return false, err
	}

	posted, lastError := s.post(ctx, claim.Delivery)
	if lastError == "" {
		_, err := s.delete(ctx, claim)
		return posted, err
	}
	_, err := s.DB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: aws.String(s.Table), Key: claim.key,
		ConditionExpression: aws.String(ownsClaim),
		UpdateExpression:    aws.String("SET claimedUntil = :zero, nextAt = :next, lastError = :error"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":node": str(s.Node), ":attempt": number(claim.attempts), ":zero": number(0),
			":next": number(s.Now().Add(backoff(claim.attempts)).UnixMilli()), ":error": str(lastError),
		},
	})
	if err != nil && !ddb.IsConditionFailed(err) {
		return posted, fmt.Errorf("reschedule delivery: %w", err)
	}
	return posted, nil
}

func (s *Sender) delete(ctx context.Context, claim *claimedDelivery) (bool, error) {
	_, err := s.DB.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(s.Table), Key: claim.key,
		ConditionExpression: aws.String(ownsClaim),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":node": str(s.Node), ":attempt": number(claim.attempts),
		},
	})
	if ddb.IsConditionFailed(err) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("delete delivery: %w", err)
	}
	return true, nil
}

func (s *Sender) post(ctx context.Context, d Delivery) (posted bool, lastError string) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, d.URL, bytes.NewReader(d.Body))
	if err != nil {
		return false, "invalid webhook URL"
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Camel-Signature", s.Signer.Sign(s.Now(), d.Body))
	req.Header.Set("Camel-Delivery", d.ID)
	res, err := s.HTTP.Do(req)
	if err != nil {
		// Transport errors can contain the full URL. Store a fixed description.
		return true, "webhook transport error"
	}
	res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return true, fmt.Sprintf("HTTP %d", res.StatusCode)
	}
	return true, ""
}

func backoff(attempts int64) time.Duration {
	const capDelay = 5 * time.Minute
	exponent := min(max(attempts, 1)-1, 9)
	base := min(time.Second<<exponent, capDelay)
	return min(time.Duration(float64(base)*(0.8+0.4*rand.Float64())), capDelay)
}

func (s *Sender) log(event string, fields map[string]any) {
	if s.Log != nil {
		s.Log(event, fields)
		return
	}
	attrs := make([]any, 0, 2*len(fields))
	for key, value := range fields {
		attrs = append(attrs, key, value)
	}
	slog.Warn(event, attrs...)
}

// Run polls until ctx ends. Failed passes are retried after a one-second pause.
func (s Sender) Run(ctx context.Context) error {
	if err := s.validate(); err != nil {
		return err
	}
	s.defaults()
	for ctx.Err() == nil {
		sent, err := s.pass(ctx)
		if ctx.Err() != nil {
			break
		}
		if err != nil {
			// DynamoDB errors carry no delivery body; the error is the only signal of a failing pass.
			s.log("delivery_pass_failed", map[string]any{"error": err.Error()})
		} else if sent > 0 {
			continue
		}
		timer := time.NewTimer(time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
		case <-timer.C:
		}
	}
	return ctx.Err()
}
