package aws

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	ddbtypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"

	"github.com/qaml-ai/camelrun-next/camelfsd/internal/apperr"
	"github.com/qaml-ai/camelrun-next/camelfsd/internal/store"
)

// DDBAPI abstracts the DynamoDB operations used by the 2-table AWS store.
type DDBAPI interface {
	GetItem(ctx context.Context, params *dynamodb.GetItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error)
	PutItem(ctx context.Context, params *dynamodb.PutItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.PutItemOutput, error)
	UpdateItem(ctx context.Context, params *dynamodb.UpdateItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error)
	DeleteItem(ctx context.Context, params *dynamodb.DeleteItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.DeleteItemOutput, error)
	Query(ctx context.Context, params *dynamodb.QueryInput, optFns ...func(*dynamodb.Options)) (*dynamodb.QueryOutput, error)
	Scan(ctx context.Context, params *dynamodb.ScanInput, optFns ...func(*dynamodb.Options)) (*dynamodb.ScanOutput, error)
	TransactWriteItems(ctx context.Context, params *dynamodb.TransactWriteItemsInput, optFns ...func(*dynamodb.Options)) (*dynamodb.TransactWriteItemsOutput, error)
}

// S3API abstracts the S3 operations used for immutable content-addressed objects.
type S3API interface {
	PutObject(ctx context.Context, params *s3.PutObjectInput, optFns ...func(*s3.Options)) (*s3.PutObjectOutput, error)
	GetObject(ctx context.Context, params *s3.GetObjectInput, optFns ...func(*s3.Options)) (*s3.GetObjectOutput, error)
	HeadObject(ctx context.Context, params *s3.HeadObjectInput, optFns ...func(*s3.Options)) (*s3.HeadObjectOutput, error)
}

type Config struct {
	Region     string
	Bucket     string
	ReposTable string
	VMsTable   string
	DDB        DDBAPI
	S3         S3API
}

// AWSStore implements store.Store on top of 2 DynamoDB tables:
//   - ReposTable ("camelfs-repos"): PK="LIN#<lineage>", SK="META" | "REF#<refName>"
//   - VMsTable   ("camelfs-vms"):   PK="VM#<vmId>", SK="META" | "EXEC#<execId>"
//     PK="ACTIVEVM#<lineage>", SK="REF#<refName>"
//     PK="HOSTS", SK="HOST#<hostId>"
//
// and 1 S3 bucket storing compressed immutable objects under "objects/<prefix>/<sha256>".
type AWSStore struct {
	bucket     string
	reposTable string
	vmsTable   string
	ddb        DDBAPI
	s3c        S3API
}

func Open(ctx context.Context, cfg Config) (*AWSStore, error) {
	if cfg.Bucket == "" {
		return nil, fmt.Errorf("aws store requires non-empty S3 bucket")
	}
	if cfg.ReposTable == "" {
		cfg.ReposTable = "camelfs-repos"
	}
	if cfg.VMsTable == "" {
		cfg.VMsTable = "camelfs-vms"
	}
	ddbClient := cfg.DDB
	s3Client := cfg.S3
	if ddbClient == nil || s3Client == nil {
		var opts []func(*awsconfig.LoadOptions) error
		if cfg.Region != "" {
			opts = append(opts, awsconfig.WithRegion(cfg.Region))
		}
		awsCfg, err := awsconfig.LoadDefaultConfig(ctx, opts...)
		if err != nil {
			return nil, fmt.Errorf("load aws config: %w", err)
		}
		if ddbClient == nil {
			ddbClient = dynamodb.NewFromConfig(awsCfg)
		}
		if s3Client == nil {
			s3Client = s3.NewFromConfig(awsCfg)
		}
	}
	return &AWSStore{
		bucket:     cfg.Bucket,
		reposTable: cfg.ReposTable,
		vmsTable:   cfg.VMsTable,
		ddb:        ddbClient,
		s3c:        s3Client,
	}, nil
}

func (s *AWSStore) Close() error { return nil }

func strVal(s string) *ddbtypes.AttributeValueMemberS {
	return &ddbtypes.AttributeValueMemberS{Value: s}
}

func numVal(n int64) *ddbtypes.AttributeValueMemberN {
	return &ddbtypes.AttributeValueMemberN{Value: strconv.FormatInt(n, 10)}
}

func getStr(item map[string]ddbtypes.AttributeValue, key string) string {
	if v, ok := item[key].(*ddbtypes.AttributeValueMemberS); ok {
		return v.Value
	}
	return ""
}

func getInt64(item map[string]ddbtypes.AttributeValue, key string) int64 {
	if v, ok := item[key].(*ddbtypes.AttributeValueMemberN); ok {
		n, _ := strconv.ParseInt(v.Value, 10, 64)
		return n
	}
	return 0
}

func isConditionalCheckFailed(err error) bool {
	var ccfe *ddbtypes.ConditionalCheckFailedException
	if errors.As(err, &ccfe) {
		return true
	}
	var tce *ddbtypes.TransactionCanceledException
	if errors.As(err, &tce) {
		for _, r := range tce.CancellationReasons {
			if r.Code != nil && *r.Code == "ConditionalCheckFailed" {
				return true
			}
		}
	}
	return false
}

func isS3NotFound(err error) bool {
	var nsk *s3types.NoSuchKey
	if errors.As(err, &nsk) {
		return true
	}
	var nf *s3types.NotFound
	if errors.As(err, &nf) {
		return true
	}
	var ae smithy.APIError
	if errors.As(err, &ae) {
		code := ae.ErrorCode()
		return code == "NoSuchKey" || code == "NotFound" || code == "404"
	}
	return false
}

func s3Key(hash string) string {
	prefix := "00"
	if len(hash) >= 2 {
		prefix = hash[:2]
	}
	return "objects/" + prefix + "/" + hash
}

func (s *AWSStore) PutObject(ctx context.Context, _ string, kind store.ObjectKind, data []byte) (string, error) {
	hash := store.HashObject(kind, data)
	exists, err := s.HasObject(ctx, hash)
	if err != nil {
		return "", err
	}
	if exists {
		return hash, nil
	}
	packed, err := store.PackObject(kind, data)
	if err != nil {
		return "", apperr.Internal("pack object", err)
	}
	key := s3Key(hash)
	_, err = s.s3c.PutObject(ctx, &s3.PutObjectInput{
		Bucket: &s.bucket,
		Key:    &key,
		Body:   bytes.NewReader(packed),
	})
	if err != nil {
		return "", apperr.Internal("s3 put object", err)
	}
	return hash, nil
}

func (s *AWSStore) GetObject(ctx context.Context, hash string) (store.ObjectKind, []byte, error) {
	if len(hash) < 4 {
		return "", nil, apperr.NotFoundf("object %q not found", hash)
	}
	key := s3Key(hash)
	out, err := s.s3c.GetObject(ctx, &s3.GetObjectInput{
		Bucket: &s.bucket,
		Key:    &key,
	})
	if err != nil {
		if isS3NotFound(err) {
			return "", nil, apperr.NotFoundf("object %q not found", hash)
		}
		return "", nil, apperr.Internal("s3 get object", err)
	}
	defer out.Body.Close()
	raw, err := io.ReadAll(out.Body)
	if err != nil {
		return "", nil, apperr.Internal("read s3 object", err)
	}
	kind, data, err := store.UnpackObject(raw)
	if err != nil {
		return "", nil, apperr.Internal("unpack s3 object", err)
	}
	return kind, data, nil
}

func (s *AWSStore) HasObject(ctx context.Context, hash string) (bool, error) {
	if len(hash) < 4 {
		return false, nil
	}
	key := s3Key(hash)
	_, err := s.s3c.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: &s.bucket,
		Key:    &key,
	})
	if err == nil {
		return true, nil
	}
	if isS3NotFound(err) {
		return false, nil
	}
	return false, apperr.Internal("s3 head object", err)
}

func (s *AWSStore) LinkObjects(_ context.Context, _ string, _ []string) error {
	// Objects in S3 are globally immutable content-addressed blobs shared safely across lineages.
	return nil
}

func linPK(lineage string) string { return "LIN#" + lineage }
func refSK(ref string) string     { return "REF#" + ref }

func (s *AWSStore) CreateLineageIfAbsent(
	ctx context.Context,
	lin store.LineageRecord,
	initRef store.RefRecord,
) (store.LineageRecord, store.RefRecord, bool, error) {
	existing, err := s.GetLineage(ctx, lin.Lineage)
	if err == nil && existing != nil {
		r, err := s.GetRef(ctx, existing.Lineage, existing.DefaultRef, initRef.UpdatedAt)
		if err != nil {
			return store.LineageRecord{}, store.RefRecord{}, false, err
		}
		return *existing, *r, false, nil
	}
	if err != nil && !apperr.IsCode(err, apperr.CodeNotFound) {
		return store.LineageRecord{}, store.RefRecord{}, false, err
	}

	cond := "attribute_not_exists(PK)"
	_, err = s.ddb.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
		TransactItems: []ddbtypes.TransactWriteItem{
			{
				Put: &ddbtypes.Put{
					TableName:           &s.reposTable,
					ConditionExpression: &cond,
					Item: map[string]ddbtypes.AttributeValue{
						"PK":         strVal(linPK(lin.Lineage)),
						"SK":         strVal("META"),
						"lineage":    strVal(lin.Lineage),
						"tenantId":   strVal(lin.TenantID),
						"defaultRef": strVal(lin.DefaultRef),
						"createdAt":  numVal(lin.CreatedAt),
					},
				},
			},
			{
				Put: &ddbtypes.Put{
					TableName: &s.reposTable,
					Item: map[string]ddbtypes.AttributeValue{
						"PK":             strVal(linPK(lin.Lineage)),
						"SK":             strVal(refSK(initRef.Name)),
						"name":           strVal(initRef.Name),
						"commit":         strVal(initRef.Commit),
						"tree":           strVal(initRef.Tree),
						"updatedAt":      numVal(initRef.UpdatedAt),
						"leaseHolder":    strVal(""),
						"leaseEpoch":     numVal(0),
						"leaseExpiresAt": numVal(0),
					},
				},
			},
		},
	})
	if err != nil {
		if isConditionalCheckFailed(err) {
			ex, err2 := s.GetLineage(ctx, lin.Lineage)
			if err2 != nil {
				return store.LineageRecord{}, store.RefRecord{}, false, err2
			}
			r, err2 := s.GetRef(ctx, ex.Lineage, ex.DefaultRef, initRef.UpdatedAt)
			if err2 != nil {
				return store.LineageRecord{}, store.RefRecord{}, false, err2
			}
			return *ex, *r, false, nil
		}
		return store.LineageRecord{}, store.RefRecord{}, false, apperr.Internal("ddb create lineage", err)
	}
	initRef.Lineage = lin.Lineage
	return lin, initRef, true, nil
}

func (s *AWSStore) GetLineage(ctx context.Context, lineage string) (*store.LineageRecord, error) {
	out, err := s.ddb.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: &s.reposTable,
		Key: map[string]ddbtypes.AttributeValue{
			"PK": strVal(linPK(lineage)),
			"SK": strVal("META"),
		},
	})
	if err != nil {
		return nil, apperr.Internal("ddb get lineage", err)
	}
	if len(out.Item) == 0 {
		return nil, apperr.NotFoundf("lineage %q not found", lineage)
	}
	return &store.LineageRecord{
		Lineage:    getStr(out.Item, "lineage"),
		TenantID:   getStr(out.Item, "tenantId"),
		DefaultRef: getStr(out.Item, "defaultRef"),
		CreatedAt:  getInt64(out.Item, "createdAt"),
	}, nil
}

func (s *AWSStore) DeleteLineage(ctx context.Context, lineage string) error {
	if _, err := s.GetLineage(ctx, lineage); err != nil {
		return err
	}
	pk := linPK(lineage)
	qExpr := "PK = :pk"
	out, err := s.ddb.Query(ctx, &dynamodb.QueryInput{
		TableName:              &s.reposTable,
		KeyConditionExpression: &qExpr,
		ExpressionAttributeValues: map[string]ddbtypes.AttributeValue{
			":pk": strVal(pk),
		},
	})
	if err != nil {
		return apperr.Internal("ddb query lineage items", err)
	}
	for _, item := range out.Items {
		_, err := s.ddb.DeleteItem(ctx, &dynamodb.DeleteItemInput{
			TableName: &s.reposTable,
			Key: map[string]ddbtypes.AttributeValue{
				"PK": strVal(pk),
				"SK": strVal(getStr(item, "SK")),
			},
		})
		if err != nil {
			return apperr.Internal("ddb delete lineage item", err)
		}
	}
	return nil
}

func itemToRef(lineage string, item map[string]ddbtypes.AttributeValue, nowMs int64) store.RefRecord {
	holder := getStr(item, "leaseHolder")
	epoch := getInt64(item, "leaseEpoch")
	expiresAt := getInt64(item, "leaseExpiresAt")
	rec := store.RefRecord{
		Lineage:   lineage,
		Name:      getStr(item, "name"),
		Commit:    getStr(item, "commit"),
		Tree:      getStr(item, "tree"),
		UpdatedAt: getInt64(item, "updatedAt"),
	}
	if holder != "" && expiresAt > nowMs {
		rec.Lease = &store.Lease{
			Holder:    holder,
			Epoch:     epoch,
			ExpiresAt: expiresAt,
		}
	}
	return rec
}

func (s *AWSStore) GetRef(ctx context.Context, lineage, ref string, nowMs int64) (*store.RefRecord, error) {
	out, err := s.ddb.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: &s.reposTable,
		Key: map[string]ddbtypes.AttributeValue{
			"PK": strVal(linPK(lineage)),
			"SK": strVal(refSK(ref)),
		},
	})
	if err != nil {
		return nil, apperr.Internal("ddb get ref", err)
	}
	if len(out.Item) == 0 {
		return nil, apperr.NotFoundf("ref %q not found in lineage %q", ref, lineage)
	}
	rec := itemToRef(lineage, out.Item, nowMs)
	return &rec, nil
}

func (s *AWSStore) ListRefs(ctx context.Context, lineage, prefix string, nowMs int64) ([]store.RefRecord, error) {
	if _, err := s.GetLineage(ctx, lineage); err != nil {
		return nil, err
	}
	qExpr := "PK = :pk AND begins_with(SK, :skPrefix)"
	out, err := s.ddb.Query(ctx, &dynamodb.QueryInput{
		TableName:              &s.reposTable,
		KeyConditionExpression: &qExpr,
		ExpressionAttributeValues: map[string]ddbtypes.AttributeValue{
			":pk":       strVal(linPK(lineage)),
			":skPrefix": strVal(refSK(prefix)),
		},
	})
	if err != nil {
		return nil, apperr.Internal("ddb list refs", err)
	}
	refs := make([]store.RefRecord, 0, len(out.Items))
	for _, item := range out.Items {
		refs = append(refs, itemToRef(lineage, item, nowMs))
	}
	sort.Slice(refs, func(i, j int) bool { return refs[i].Name < refs[j].Name })
	return refs, nil
}

func (s *AWSStore) SetRef(ctx context.Context, p store.SetRefParams) (*store.RefRecord, error) {
	if _, err := s.GetLineage(ctx, p.Lineage); err != nil {
		return nil, err
	}

	curOut, err := s.ddb.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: &s.reposTable,
		Key: map[string]ddbtypes.AttributeValue{
			"PK": strVal(linPK(p.Lineage)),
			"SK": strVal(refSK(p.Ref)),
		},
	})
	if err != nil {
		return nil, apperr.Internal("ddb read ref", err)
	}
	exists := len(curOut.Item) > 0
	var curHolder string
	var curEpoch, curExpiry int64
	if exists {
		curHolder = getStr(curOut.Item, "leaseHolder")
		curEpoch = getInt64(curOut.Item, "leaseEpoch")
		curExpiry = getInt64(curOut.Item, "leaseExpiresAt")
		curCommit := getStr(curOut.Item, "commit")

		if curHolder != "" && curExpiry > p.NowMs {
			if p.Holder != curHolder {
				return nil, apperr.RefLeasedf("ref %q is leased by %q", p.Ref, curHolder)
			}
			if p.ExpectedEpoch > 0 && curEpoch != p.ExpectedEpoch {
				return nil, apperr.RefLeasedf("stale lease epoch %d on ref %q", p.ExpectedEpoch, p.Ref)
			}
		}
		if p.ExpectedCommit != "" && curCommit != p.ExpectedCommit {
			return nil, apperr.CASConflictf("expected commit %q on ref %q, got %q", p.ExpectedCommit, p.Ref, curCommit)
		}
	} else {
		if p.ExpectedCommit != "" {
			return nil, apperr.CASConflictf("expected commit %q on missing ref %q", p.ExpectedCommit, p.Ref)
		}
		if p.Delete {
			return nil, apperr.NotFoundf("ref %q not found", p.Ref)
		}
	}

	if p.Delete {
		_, err := s.ddb.DeleteItem(ctx, &dynamodb.DeleteItemInput{
			TableName: &s.reposTable,
			Key: map[string]ddbtypes.AttributeValue{
				"PK": strVal(linPK(p.Lineage)),
				"SK": strVal(refSK(p.Ref)),
			},
		})
		if err != nil {
			return nil, apperr.Internal("ddb delete ref", err)
		}
		return &store.RefRecord{Lineage: p.Lineage, Name: p.Ref, UpdatedAt: p.NowMs}, nil
	}

	if !exists {
		cond := "attribute_not_exists(PK)"
		_, err := s.ddb.PutItem(ctx, &dynamodb.PutItemInput{
			TableName:           &s.reposTable,
			ConditionExpression: &cond,
			Item: map[string]ddbtypes.AttributeValue{
				"PK":             strVal(linPK(p.Lineage)),
				"SK":             strVal(refSK(p.Ref)),
				"name":           strVal(p.Ref),
				"commit":         strVal(p.Commit),
				"tree":           strVal(p.Tree),
				"updatedAt":      numVal(p.NowMs),
				"leaseHolder":    strVal(""),
				"leaseEpoch":     numVal(0),
				"leaseExpiresAt": numVal(0),
			},
		})
		if err != nil {
			if isConditionalCheckFailed(err) {
				return nil, apperr.CASConflictf("concurrent ref creation on %q", p.Ref)
			}
			return nil, apperr.Internal("ddb put ref", err)
		}
		return &store.RefRecord{
			Lineage:   p.Lineage,
			Name:      p.Ref,
			Commit:    p.Commit,
			Tree:      p.Tree,
			UpdatedAt: p.NowMs,
		}, nil
	}

	var condParts []string
	exprNames := map[string]string{
		"#c": "commit",
		"#t": "tree",
	}
	exprVals := map[string]ddbtypes.AttributeValue{
		":c":      strVal(p.Commit),
		":t":      strVal(p.Tree),
		":u":      numVal(p.NowMs),
		":now":    numVal(p.NowMs),
		":empty":  strVal(""),
		":holder": strVal(p.Holder),
	}
	condParts = append(condParts, "(leaseHolder = :empty OR leaseExpiresAt <= :now OR leaseHolder = :holder)")
	if p.ExpectedCommit != "" {
		condParts = append(condParts, "#c = :expCommit")
		exprVals[":expCommit"] = strVal(p.ExpectedCommit)
	}
	cond := strings.Join(condParts, " AND ")
	upd := "SET #c = :c, #t = :t, updatedAt = :u"
	_, err = s.ddb.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                 &s.reposTable,
		Key:                       map[string]ddbtypes.AttributeValue{"PK": strVal(linPK(p.Lineage)), "SK": strVal(refSK(p.Ref))},
		UpdateExpression:          &upd,
		ConditionExpression:       &cond,
		ExpressionAttributeNames:  exprNames,
		ExpressionAttributeValues: exprVals,
	})
	if err != nil {
		if isConditionalCheckFailed(err) {
			return nil, apperr.CASConflictf("CAS or lease conflict updating ref %q", p.Ref)
		}
		return nil, apperr.Internal("ddb update ref", err)
	}

	rec := &store.RefRecord{
		Lineage:   p.Lineage,
		Name:      p.Ref,
		Commit:    p.Commit,
		Tree:      p.Tree,
		UpdatedAt: p.NowMs,
	}
	if curHolder != "" && curExpiry > p.NowMs {
		rec.Lease = &store.Lease{Holder: curHolder, Epoch: curEpoch, ExpiresAt: curExpiry}
	}
	return rec, nil
}

func (s *AWSStore) LeaseRef(ctx context.Context, p store.LeaseRefParams) (*store.LeaseResult, error) {
	curOut, err := s.ddb.GetItem(ctx, &dynamodb.GetItemInput{
		TableName:      &s.reposTable,
		ConsistentRead: aws.Bool(true),
		Key: map[string]ddbtypes.AttributeValue{
			"PK": strVal(linPK(p.Lineage)),
			"SK": strVal(refSK(p.Ref)),
		},
	})
	if err != nil {
		return nil, apperr.Internal("ddb get ref for lease", err)
	}
	if len(curOut.Item) == 0 {
		return nil, apperr.NotFoundf("ref %q not found in lineage %q", p.Ref, p.Lineage)
	}
	commit := getStr(curOut.Item, "commit")
	tree := getStr(curOut.Item, "tree")
	curHolder := getStr(curOut.Item, "leaseHolder")
	curEpoch := getInt64(curOut.Item, "leaseEpoch")
	curExpiry := getInt64(curOut.Item, "leaseExpiresAt")

	if p.Release && p.ExpectedEpoch > 0 && (curHolder != p.Holder || curEpoch != p.ExpectedEpoch) {
		return &store.LeaseResult{Ref: p.Ref, Commit: commit, Tree: tree, Holder: curHolder, Epoch: curEpoch, ExpiresAt: curExpiry}, nil
	}
	if curHolder != "" && curExpiry > p.NowMs && curHolder != p.Holder {
		return nil, apperr.RefLeasedf("ref %q is currently leased by %q", p.Ref, curHolder)
	}

	cond := "attribute_exists(PK) AND (leaseHolder = :empty OR leaseExpiresAt <= :now OR leaseHolder = :holder)"
	if p.Release {
		upd := "SET leaseHolder = :empty, leaseExpiresAt = :zero"
		values := map[string]ddbtypes.AttributeValue{
			":empty":  strVal(""),
			":zero":   numVal(0),
			":holder": strVal(p.Holder),
		}
		if p.ExpectedEpoch > 0 {
			cond = "leaseHolder = :holder AND leaseEpoch = :epoch"
			values[":epoch"] = numVal(p.ExpectedEpoch)
		} else {
			values[":now"] = numVal(p.NowMs)
		}
		_, err := s.ddb.UpdateItem(ctx, &dynamodb.UpdateItemInput{
			TableName:                 &s.reposTable,
			Key:                       map[string]ddbtypes.AttributeValue{"PK": strVal(linPK(p.Lineage)), "SK": strVal(refSK(p.Ref))},
			UpdateExpression:          &upd,
			ConditionExpression:       &cond,
			ExpressionAttributeValues: values,
		})
		if err != nil {
			if isConditionalCheckFailed(err) {
				return nil, apperr.RefLeasedf("ref %q lease owned by another holder", p.Ref)
			}
			return nil, apperr.Internal("ddb release lease", err)
		}
		return &store.LeaseResult{
			Ref:       p.Ref,
			Commit:    commit,
			Tree:      tree,
			Holder:    "",
			Epoch:     curEpoch,
			ExpiresAt: 0,
		}, nil
	}

	newEpoch := curEpoch + 1
	newExpiry := p.NowMs + p.TTLMs
	upd := "SET leaseHolder = :holder, leaseEpoch = :newEpoch, leaseExpiresAt = :exp"
	condWithEpoch := cond + " AND leaseEpoch = :curEpoch"
	_, err = s.ddb.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:           &s.reposTable,
		Key:                 map[string]ddbtypes.AttributeValue{"PK": strVal(linPK(p.Lineage)), "SK": strVal(refSK(p.Ref))},
		UpdateExpression:    &upd,
		ConditionExpression: &condWithEpoch,
		ExpressionAttributeValues: map[string]ddbtypes.AttributeValue{
			":empty":    strVal(""),
			":now":      numVal(p.NowMs),
			":holder":   strVal(p.Holder),
			":curEpoch": numVal(curEpoch),
			":newEpoch": numVal(newEpoch),
			":exp":      numVal(newExpiry),
		},
	})
	if err != nil {
		if isConditionalCheckFailed(err) {
			return nil, apperr.RefLeasedf("concurrent lease contention on ref %q", p.Ref)
		}
		return nil, apperr.Internal("ddb acquire lease", err)
	}
	return &store.LeaseResult{
		Ref:       p.Ref,
		Commit:    commit,
		Tree:      tree,
		Holder:    p.Holder,
		Epoch:     newEpoch,
		ExpiresAt: newExpiry,
	}, nil
}

func vmPK(vmID string) string      { return "VM#" + vmID }
func activeVMPK(lin string) string { return "ACTIVEVM#" + lin }
func execSK(execID string) string  { return "EXEC#" + execID }
func hostSK(hostID string) string  { return "HOST#" + hostID }

func vmToItem(vm *store.VMRecord) map[string]ddbtypes.AttributeValue {
	envBytes, _ := json.Marshal(vm.Env)
	return map[string]ddbtypes.AttributeValue{
		"PK":              strVal(vmPK(vm.VMID)),
		"SK":              strVal("META"),
		"vmId":            strVal(vm.VMID),
		"lineage":         strVal(vm.Lineage),
		"ref":             strVal(vm.Ref),
		"holder":          strVal(vm.Holder),
		"leaseEpoch":      numVal(vm.LeaseEpoch),
		"state":           strVal(vm.State),
		"headCommit":      strVal(vm.HeadCommit),
		"vcpus":           numVal(int64(vm.VCPUs)),
		"memoryMiB":       numVal(int64(vm.MemoryMiB)),
		"idleTimeoutS":    numVal(int64(vm.IdleTimeoutS)),
		"envJson":         strVal(string(envBytes)),
		"hostId":          strVal(vm.HostID),
		"createdAt":       numVal(vm.CreatedAt),
		"lastActiveAt":    numVal(vm.LastActiveAt),
		"leaseExpiresAt":  numVal(vm.LeaseExpiresAt),
		"totalDurationMs": numVal(vm.TotalDurationMs),
		"billedMs":        numVal(vm.BilledMs),
	}
}

func itemToVM(item map[string]ddbtypes.AttributeValue) *store.VMRecord {
	vm := &store.VMRecord{
		VMID:            getStr(item, "vmId"),
		Lineage:         getStr(item, "lineage"),
		Ref:             getStr(item, "ref"),
		Holder:          getStr(item, "holder"),
		LeaseEpoch:      getInt64(item, "leaseEpoch"),
		State:           getStr(item, "state"),
		HeadCommit:      getStr(item, "headCommit"),
		VCPUs:           int(getInt64(item, "vcpus")),
		MemoryMiB:       int(getInt64(item, "memoryMiB")),
		IdleTimeoutS:    int(getInt64(item, "idleTimeoutS")),
		HostID:          getStr(item, "hostId"),
		CreatedAt:       getInt64(item, "createdAt"),
		LastActiveAt:    getInt64(item, "lastActiveAt"),
		LeaseExpiresAt:  getInt64(item, "leaseExpiresAt"),
		TotalDurationMs: getInt64(item, "totalDurationMs"),
		BilledMs:        getInt64(item, "billedMs"),
	}
	if envStr := getStr(item, "envJson"); envStr != "" {
		_ = json.Unmarshal([]byte(envStr), &vm.Env)
	}
	if vm.Env == nil {
		vm.Env = map[string]string{}
	}
	return vm
}

func (s *AWSStore) GetRunningVMByRef(ctx context.Context, lineage, ref string) (*store.VMRecord, error) {
	ptrOut, err := s.ddb.GetItem(ctx, &dynamodb.GetItemInput{
		TableName:      &s.vmsTable,
		ConsistentRead: aws.Bool(true),
		Key: map[string]ddbtypes.AttributeValue{
			"PK": strVal(activeVMPK(lineage)),
			"SK": strVal(refSK(ref)),
		},
	})
	if err != nil {
		return nil, apperr.Internal("ddb get active vm pointer", err)
	}
	if len(ptrOut.Item) == 0 {
		return nil, nil
	}
	vmID := getStr(ptrOut.Item, "vmId")
	if vmID == "" {
		return nil, nil
	}
	vm, err := s.GetVM(ctx, vmID)
	if apperr.IsCode(err, apperr.CodeNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if vm.State != "running" {
		return nil, nil
	}
	return vm, nil
}

func (s *AWSStore) ListRunningVMs(ctx context.Context, consistent bool) ([]*store.VMRecord, error) {
	filt := "SK = :meta AND #st = :running"
	pages := dynamodb.NewScanPaginator(s.ddb, &dynamodb.ScanInput{
		TableName:        &s.vmsTable,
		ConsistentRead:   aws.Bool(consistent),
		FilterExpression: &filt,
		ExpressionAttributeNames: map[string]string{
			"#st": "state",
		},
		ExpressionAttributeValues: map[string]ddbtypes.AttributeValue{
			":meta":    strVal("META"),
			":running": strVal("running"),
		},
	})
	var res []*store.VMRecord
	for pages.HasMorePages() {
		out, err := pages.NextPage(ctx)
		if err != nil {
			return nil, apperr.Internal("ddb scan running vms", err)
		}
		for _, it := range out.Items {
			if strings.HasPrefix(getStr(it, "PK"), "VM#") {
				res = append(res, itemToVM(it))
			}
		}
	}
	return res, nil
}

func (s *AWSStore) ListRunningVMsByLineage(ctx context.Context, lineage string) ([]*store.VMRecord, error) {
	qExpr := "PK = :pk"
	out, err := s.ddb.Query(ctx, &dynamodb.QueryInput{
		TableName:              &s.vmsTable,
		KeyConditionExpression: &qExpr,
		ExpressionAttributeValues: map[string]ddbtypes.AttributeValue{
			":pk": strVal(activeVMPK(lineage)),
		},
	})
	if err != nil {
		return nil, apperr.Internal("ddb query lineage vms", err)
	}
	var res []*store.VMRecord
	for _, it := range out.Items {
		vmID := getStr(it, "vmId")
		if vmID == "" {
			continue
		}
		vm, err := s.GetVM(ctx, vmID)
		if err == nil && vm != nil && vm.State == "running" {
			res = append(res, vm)
		}
	}
	return res, nil
}

func (s *AWSStore) CreateRunningVM(ctx context.Context, vm *store.VMRecord) error {
	cond := "attribute_not_exists(PK)"
	_, err := s.ddb.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
		TransactItems: []ddbtypes.TransactWriteItem{
			{
				Put: &ddbtypes.Put{
					TableName:           &s.vmsTable,
					ConditionExpression: &cond,
					Item: map[string]ddbtypes.AttributeValue{
						"PK":     strVal(activeVMPK(vm.Lineage)),
						"SK":     strVal(refSK(vm.Ref)),
						"vmId":   strVal(vm.VMID),
						"holder": strVal(vm.Holder),
					},
				},
			},
			{
				Put: &ddbtypes.Put{
					TableName:           &s.vmsTable,
					ConditionExpression: &cond,
					Item:                vmToItem(vm),
				},
			},
		},
	})
	if err != nil {
		if isConditionalCheckFailed(err) {
			return apperr.RefLeasedf("a running VM already exists on (%s, %s)", vm.Lineage, vm.Ref)
		}
		return apperr.Internal("ddb create running vm", err)
	}
	return nil
}

func (s *AWSStore) GetVM(ctx context.Context, vmID string) (*store.VMRecord, error) {
	out, err := s.ddb.GetItem(ctx, &dynamodb.GetItemInput{
		TableName:      &s.vmsTable,
		ConsistentRead: aws.Bool(true),
		Key: map[string]ddbtypes.AttributeValue{
			"PK": strVal(vmPK(vmID)),
			"SK": strVal("META"),
		},
	})
	if err != nil {
		return nil, apperr.Internal("ddb get vm", err)
	}
	if len(out.Item) == 0 {
		return nil, apperr.NotFoundf("vm %q not found", vmID)
	}
	return itemToVM(out.Item), nil
}

func (s *AWSStore) UpdateVM(ctx context.Context, vm *store.VMRecord) error {
	if vm.State == "running" {
		_, err := s.ddb.PutItem(ctx, &dynamodb.PutItemInput{
			TableName: &s.vmsTable,
			Item:      vmToItem(vm),
		})
		if err != nil {
			return apperr.Internal("ddb update running vm", err)
		}
		return nil
	}

	cond := "attribute_not_exists(PK) OR vmId = :vmId"
	_, err := s.ddb.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
		TransactItems: []ddbtypes.TransactWriteItem{
			{Put: &ddbtypes.Put{TableName: &s.vmsTable, Item: vmToItem(vm)}},
			{Delete: &ddbtypes.Delete{
				TableName:           &s.vmsTable,
				ConditionExpression: &cond,
				Key: map[string]ddbtypes.AttributeValue{
					"PK": strVal(activeVMPK(vm.Lineage)),
					"SK": strVal(refSK(vm.Ref)),
				},
				ExpressionAttributeValues: map[string]ddbtypes.AttributeValue{
					":vmId": strVal(vm.VMID),
				},
			}},
		},
	})
	if err != nil {
		return apperr.Internal("ddb retire vm", err)
	}
	return nil
}

func (s *AWSStore) GetExecReceipt(ctx context.Context, vmID, execID string) (*store.ExecReceipt, error) {
	out, err := s.ddb.GetItem(ctx, &dynamodb.GetItemInput{
		TableName:      &s.vmsTable,
		ConsistentRead: aws.Bool(true),
		Key: map[string]ddbtypes.AttributeValue{
			"PK": strVal(vmPK(vmID)),
			"SK": strVal(execSK(execID)),
		},
	})
	if err != nil {
		return nil, apperr.Internal("ddb get exec receipt", err)
	}
	if len(out.Item) == 0 {
		return nil, nil
	}
	var payload []byte
	if hash := getStr(out.Item, "responseHash"); hash != "" {
		kind, data, err := s.GetObject(ctx, hash)
		if err != nil {
			return nil, apperr.Internal("load exec receipt object", err)
		}
		if kind != store.KindExecReceipt {
			return nil, apperr.Internal("unexpected exec receipt object kind", nil)
		}
		payload = data
	} else if b, ok := out.Item["responseJson"].(*ddbtypes.AttributeValueMemberB); ok {
		payload = b.Value
	} else {
		payload = []byte(getStr(out.Item, "responseJson"))
	}
	return &store.ExecReceipt{
		VMID:         vmID,
		ExecID:       execID,
		ResponseJSON: payload,
		CreatedAt:    getInt64(out.Item, "createdAt"),
	}, nil
}

func (s *AWSStore) CompleteExec(ctx context.Context, p store.CompleteExecParams) error {
	vm := p.VM
	receipt := p.Receipt
	item := map[string]ddbtypes.AttributeValue{
		"PK":        strVal(vmPK(vm.VMID)),
		"SK":        strVal(execSK(receipt.ExecID)),
		"createdAt": numVal(receipt.CreatedAt),
	}
	// DynamoDB limits each item to 400 KiB. Leave room for the keys and
	// metadata, and stage larger results as immutable objects.
	if len(receipt.ResponseJSON) > 390*1024 {
		hash, err := s.PutObject(ctx, vm.Lineage, store.KindExecReceipt, receipt.ResponseJSON)
		if err != nil {
			return apperr.Internal("stage exec receipt object", err)
		}
		item["responseHash"] = strVal(hash)
	} else {
		item["responseJson"] = &ddbtypes.AttributeValueMemberB{Value: receipt.ResponseJSON}
	}

	items := []ddbtypes.TransactWriteItem{
		{Put: &ddbtypes.Put{
			TableName:           &s.vmsTable,
			Item:                item,
			ConditionExpression: aws.String("attribute_not_exists(PK)"),
		}},
		{Put: &ddbtypes.Put{
			TableName:                &s.vmsTable,
			Item:                     vmToItem(vm),
			ConditionExpression:      aws.String("#state = :running AND headCommit = :base AND leaseEpoch = :epoch"),
			ExpressionAttributeNames: map[string]string{"#state": "state"},
			ExpressionAttributeValues: map[string]ddbtypes.AttributeValue{
				":running": strVal("running"),
				":base":    strVal(p.BaseCommit),
				":epoch":   numVal(vm.LeaseEpoch),
			},
		}},
	}
	refKey := map[string]ddbtypes.AttributeValue{"PK": strVal(linPK(vm.Lineage)), "SK": strVal(refSK(vm.Ref))}
	refCondition := aws.String("#commit = :base AND leaseHolder = :holder AND leaseEpoch = :epoch")
	refNames := map[string]string{"#commit": "commit"}
	refValues := map[string]ddbtypes.AttributeValue{
		":base": strVal(p.BaseCommit), ":holder": strVal(vm.Holder), ":epoch": numVal(vm.LeaseEpoch),
	}
	if vm.HeadCommit == p.BaseCommit {
		items = append(items, ddbtypes.TransactWriteItem{ConditionCheck: &ddbtypes.ConditionCheck{
			TableName: &s.reposTable, Key: refKey, ConditionExpression: refCondition,
			ExpressionAttributeNames: refNames, ExpressionAttributeValues: refValues,
		}})
	} else {
		refNames["#tree"] = "tree"
		refValues[":head"], refValues[":tree"], refValues[":now"] = strVal(vm.HeadCommit), strVal(p.Tree), numVal(receipt.CreatedAt)
		items = append(items, ddbtypes.TransactWriteItem{Update: &ddbtypes.Update{
			TableName: &s.reposTable, Key: refKey, ConditionExpression: refCondition,
			UpdateExpression:         aws.String("SET #commit = :head, #tree = :tree, updatedAt = :now"),
			ExpressionAttributeNames: refNames, ExpressionAttributeValues: refValues,
		}})
	}
	if _, err := s.ddb.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{TransactItems: items}); err != nil {
		// This is an uncertain exec outcome for the caller even if a
		// condition failed. The command has already reached the guest.
		return apperr.Internal("ddb complete exec", err)
	}
	return nil
}

func (s *AWSStore) UpsertHost(ctx context.Context, h *store.HostRecord) error {
	labelsBytes, _ := json.Marshal(h.Labels)
	_, err := s.ddb.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: &s.vmsTable,
		Item: map[string]ddbtypes.AttributeValue{
			"PK":              strVal("HOSTS"),
			"SK":              strVal(hostSK(h.HostID)),
			"hostId":          strVal(h.HostID),
			"address":         strVal(h.Address),
			"capacityVms":     numVal(int64(h.CapacityVMs)),
			"runningVms":      numVal(int64(h.RunningVMs)),
			"status":          strVal(h.Status),
			"labelsJson":      strVal(string(labelsBytes)),
			"lastHeartbeatAt": numVal(h.LastHeartbeatAt),
		},
	})
	if err != nil {
		return apperr.Internal("ddb upsert host", err)
	}
	return nil
}

func itemToHost(item map[string]ddbtypes.AttributeValue) *store.HostRecord {
	h := &store.HostRecord{
		HostID:          getStr(item, "hostId"),
		Address:         getStr(item, "address"),
		CapacityVMs:     int(getInt64(item, "capacityVms")),
		RunningVMs:      int(getInt64(item, "runningVms")),
		Status:          getStr(item, "status"),
		LastHeartbeatAt: getInt64(item, "lastHeartbeatAt"),
	}
	if lbl := getStr(item, "labelsJson"); lbl != "" {
		_ = json.Unmarshal([]byte(lbl), &h.Labels)
	}
	return h
}

func (s *AWSStore) GetHost(ctx context.Context, hostID string) (*store.HostRecord, error) {
	out, err := s.ddb.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: &s.vmsTable,
		Key: map[string]ddbtypes.AttributeValue{
			"PK": strVal("HOSTS"),
			"SK": strVal(hostSK(hostID)),
		},
	})
	if err != nil {
		return nil, apperr.Internal("ddb get host", err)
	}
	if len(out.Item) == 0 {
		return nil, apperr.NotFoundf("host %q not found", hostID)
	}
	return itemToHost(out.Item), nil
}

func (s *AWSStore) ListHosts(ctx context.Context) ([]*store.HostRecord, error) {
	qExpr := "PK = :pk"
	out, err := s.ddb.Query(ctx, &dynamodb.QueryInput{
		TableName:              &s.vmsTable,
		KeyConditionExpression: &qExpr,
		ExpressionAttributeValues: map[string]ddbtypes.AttributeValue{
			":pk": strVal("HOSTS"),
		},
	})
	if err != nil {
		return nil, apperr.Internal("ddb list hosts", err)
	}
	res := make([]*store.HostRecord, 0, len(out.Items))
	for _, it := range out.Items {
		res = append(res, itemToHost(it))
	}
	return res, nil
}
