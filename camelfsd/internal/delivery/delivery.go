// Package delivery stages webhook deliveries in callers' DynamoDB transactions
// and sends them at least once. Receivers should deduplicate by delivery ID.
package delivery

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"hash/fnv"
	"strconv"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

const Shards = 16

const maxBody = 300 * 1024

type Delivery struct {
	ID, URL string
	Body    []byte
}

func Shard(id string) string {
	hash := fnv.New32a()
	hash.Write([]byte(id))
	return strconv.FormatUint(uint64(hash.Sum32()%Shards), 10)
}

// Stage returns a put for the transaction that first creates the event.
// Staging the same ID while its row exists fails the entire transaction.
// Callers must stage only on the transition that creates the event, including
// after a sender has deleted the row.
func Stage(table string, d Delivery, now time.Time) (types.TransactWriteItem, error) {
	if len(d.Body) > maxBody {
		return types.TransactWriteItem{}, fmt.Errorf("delivery body exceeds %d bytes", maxBody)
	}
	item := key(Shard(d.ID), d.ID)
	item["url"] = str(d.URL)
	item["body"] = &types.AttributeValueMemberB{Value: bytes.Clone(d.Body)}
	item["createdAt"] = number(now.UnixMilli())
	item["attempts"] = number(0)
	item["nextAt"] = number(now.UnixMilli())
	item["claimedUntil"] = number(0)
	item["claimer"] = str("")
	item["lastError"] = str("")
	return types.TransactWriteItem{Put: &types.Put{
		TableName: aws.String(table), Item: item, ConditionExpression: aws.String("attribute_not_exists(id)"),
	}}, nil
}

type Signer interface {
	Sign(t time.Time, body []byte) (header string)
}

type hmacSigner []byte

func HMAC(key []byte) Signer {
	return hmacSigner(bytes.Clone(key))
}

func (key hmacSigner) Sign(t time.Time, body []byte) string {
	ts := strconv.FormatInt(t.Unix(), 10)
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(ts + "."))
	mac.Write(body)
	return "t=" + ts + ",v1=" + hex.EncodeToString(mac.Sum(nil))
}

func key(shard, id string) map[string]types.AttributeValue {
	return map[string]types.AttributeValue{"shard": str(shard), "id": str(id)}
}

func str(value string) *types.AttributeValueMemberS {
	return &types.AttributeValueMemberS{Value: value}
}

func number(value int64) *types.AttributeValueMemberN {
	return &types.AttributeValueMemberN{Value: strconv.FormatInt(value, 10)}
}
