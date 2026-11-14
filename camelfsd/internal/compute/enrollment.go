package compute

import (
	"context"
	"errors"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
)

const enrollmentPrefix = "~enroll#"
const enrollmentRetention = 15 * time.Minute

// RecordEnrollment consumes a signed STS request across all nodes of the tier.
func (c *Controller) RecordEnrollment(ctx context.Context, pool, signature string) error {
	row := hostKey(pool, enrollmentPrefix+signature)
	row["kind"] = s("enrollment")
	row["expiresAt"] = n(c.now().Add(enrollmentRetention).UnixMilli())
	return c.transact(ctx, put(c.Tables.Hosts, row, "attribute_not_exists(#host)"))
}

func (c *Controller) expireEnrollments(ctx context.Context, pool string, now time.Time) error {
	const key = "#pool = :pool AND begins_with(#host, :prefix)"
	const expiry = "#expiresAt <= :now"
	pages := dynamodb.NewQueryPaginator(c.DB, &dynamodb.QueryInput{
		TableName: aws.String(c.Tables.Hosts), KeyConditionExpression: aws.String(key),
		FilterExpression: aws.String(expiry), ProjectionExpression: aws.String("#host"),
		ExpressionAttributeNames:  aliases(key, expiry),
		ExpressionAttributeValues: attrs{":pool": s(pool), ":prefix": s(enrollmentPrefix), ":now": n(now.UnixMilli())},
	})
	var result error
	for pages.HasMorePages() {
		page, err := pages.NextPage(ctx)
		if err != nil {
			return errors.Join(result, err)
		}
		for _, row := range page.Items {
			_, err := c.DB.DeleteItem(ctx, &dynamodb.DeleteItemInput{
				TableName: aws.String(c.Tables.Hosts), Key: hostKey(pool, item(row).text("host")),
				ConditionExpression: aws.String(expiry), ExpressionAttributeNames: aliases(expiry),
				ExpressionAttributeValues: attrs{":now": n(now.UnixMilli())},
			})
			if err = c.wrote(err); !errors.Is(err, ErrCondition) {
				result = errors.Join(result, err)
			}
		}
	}
	return result
}
