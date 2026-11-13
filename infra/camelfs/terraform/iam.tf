# Two principals, least privilege (camel-fs.md §1.10: "hosts hold an instance role scoped to the bucket prefixes
# and tables, as the job-hosts plan's role is scoped"; the api tier is the authorization boundary):
#
#   api        the Fargate task role of camelfsd api: every table and the bucket (no delete; results/ for VM
#              results that outgrow an item), and the hosts' Private CA as registration authority (issue and fetch
#              end-entity certificates, nothing else on the CA). The only principal that touches refs, lineages,
#              deliveries, hosts and vms. The token verification keys reach the task as an injected environment
#              variable, so the task role reads no secret; the execution role reads that one secret for the
#              injection.
#   host       camelfsd --role host on the VM hosts: the bucket (no delete) and the objects table (trees and
#              commits a checkpoint publishes), nothing else: a host moves no ref (it asks the tier, which checks
#              its fence), reads no lineage registry, touches no control table and writes no VM result (the tier
#              does, from the host's "ended" call); no secret at all: its identity is the certificate the tier
#              issues it at enrollment (§9.12). Delivered as a customer-managed
#              policy (host_policy_arn), attachable to the job-hosts pool roles (infra/job-hosts/terraform/iam.tf,
#              host_managed_policies) and to the proto host's role, and as a role + instance profile of its own
#              for hosts outside those pools. The role trusts ec2.amazonaws.com only, with the job-hosts
#              invariant's guards (its session name is an instance id the tier may one day attest; nothing else
#              may ever assume it).
#   publisher  GitHub Actions (OIDC, the repository's production environment) publishing the content-addressed
#              guest image (K1): PutObject under <guest_image_prefix>guest/ (guest/ by default) and nothing else —
#              no read, no list, no delete. The key is the image's sha256 and the publisher puts with `If-None-Match: *`, so an
#              existing object is never overwritten (S3 refuses the put); IAM cannot express that condition, and
#              the bucket's versioning keeps every prior version in any case.
#
# No principal here may delete an object: deletion is the collector's (camel-fs.md §1.9), under a role of its own,
# in a later phase.

# --- api task ---

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:ecs:${var.region}:${var.account_id}:*"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.account_id]
    }
  }
}

# Used by ECS itself: pull the image, write logs, and read the one secret it injects (CAMELFS_JWKS).
resource "aws_iam_role" "api_execution" {
  name               = "${var.name}-${var.env}-api-execution"
  description        = "camelFS api ECS task execution (image pull, logs, the JWKS injection)"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "api_execution" {
  role       = aws_iam_role.api_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "api_execution_jwks" {
  name = "camelfs-key-injection"
  role = aws_iam_role.api_execution.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "InjectKeys"
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = [aws_secretsmanager_secret.token_verify_keys.arn]
    }]
  })
}

locals {
  table_arns = { for table, resource in aws_dynamodb_table.camelfs : table => resource.arn }

  # The bucket, read and write, never delete. CopyObject (a cross-lineage fork, camel-fs-files.md §9) is a GetObject
  # on the source and a PutObject on the destination. s3:GetObject covers HeadObject. PutObjectTagging: the tier
  # tags VM results kind=result for the bucket's 7-day expiry rule (bucket.tf).
  bucket_rw_statements = [
    {
      Sid      = "ObjectsReadWrite"
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject", "s3:GetObjectAttributes", "s3:PutObjectTagging"]
      Resource = ["${aws_s3_bucket.objects.arn}/*"]
    },
    {
      Sid      = "ObjectsList"
      Effect   = "Allow"
      Action   = ["s3:ListBucket"]
      Resource = [aws_s3_bucket.objects.arn]
    },
    {
      Sid      = "ObjectsKeyThroughS3"
      Effect   = "Allow"
      Action   = ["kms:Decrypt", "kms:GenerateDataKey"]
      Resource = [aws_kms_key.objects.arn]
      Condition = {
        StringEquals = { "kms:ViaService" = "s3.${var.region}.amazonaws.com" }
      }
    },
  ]

  dynamodb_item_actions = [
    "dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query",
    "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem",
    "dynamodb:ConditionCheckItem", "dynamodb:TransactGetItems", "dynamodb:TransactWriteItems",
  ]

  api_policy = {
    Version = "2012-10-17"
    Statement = concat(local.bucket_rw_statements, [
      {
        Sid      = "Tables"
        Effect   = "Allow"
        Action   = local.dynamodb_item_actions
        Resource = values(local.table_arns)
      },
      # Registration authority for the hosts' CA (mtls.tf): issue a host's or its own end-entity certificate from a
      # CSR, and fetch it. IssueCertificate is restricted to the two end-entity templates (never a CA template,
      # never passthrough of arbitrary extensions); validity is capped by the CA's short-lived mode (7 days). Which
      # host id a certificate may carry is the tier's enrollment check: IAM cannot constrain a subject.
      {
        Sid      = "IssueHostCertificates"
        Effect   = "Allow"
        Action   = ["acm-pca:IssueCertificate"]
        Resource = [aws_acmpca_certificate_authority.hosts.arn]
        Condition = {
          StringEquals = { "acm-pca:TemplateArn" = [
            "arn:${data.aws_partition.current.partition}:acm-pca:::template/EndEntityCertificate/V1",
            "arn:${data.aws_partition.current.partition}:acm-pca:::template/EndEntityClientAuthCertificate/V1",
          ] }
        }
      },
      {
        Sid      = "FetchIssuedCertificates"
        Effect   = "Allow"
        Action   = ["acm-pca:GetCertificate", "acm-pca:GetCertificateAuthorityCertificate"]
        Resource = [aws_acmpca_certificate_authority.hosts.arn]
      },
      {
        Sid    = "EcsExec"
        Effect = "Allow"
        Action = [
          "ssmmessages:CreateControlChannel",
          "ssmmessages:CreateDataChannel",
          "ssmmessages:OpenControlChannel",
          "ssmmessages:OpenDataChannel",
        ]
        Resource = "*"
      },
    ])
  }
}

resource "aws_iam_role" "api" {
  name               = "${var.name}-${var.env}-api"
  description        = "camelFS api tier (camelfsd api): the tables and the bucket; no secret"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy" "api" {
  name   = "camelfs-api"
  role   = aws_iam_role.api.name
  policy = jsonencode(local.api_policy)

  lifecycle {
    precondition {
      condition     = !anytrue([for statement in local.api_policy.Statement : contains(flatten([statement.Action]), "s3:DeleteObject") || contains(flatten([statement.Action]), "s3:*") || anytrue([for action in flatten([statement.Action]) : startswith(action, "secretsmanager:") || action == "acm-pca:*" || startswith(action, "acm-pca:Create") || startswith(action, "acm-pca:Delete") || startswith(action, "acm-pca:Update") || startswith(action, "acm-pca:Import")])])
      error_message = "The api role must not delete objects (deletion is the collector's, under its own role), reads no secret (the JWKS is injected by the execution role), and only issues and fetches certificates on the CA."
    }
  }
}

# --- host ---

locals {
  host_trust_policy = {
    Version = "2012-10-17"
    Statement = [{
      Sid       = "EC2Only"
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  }

  # True only for a trust policy whose every statement is an Allow of sts:AssumeRole to ec2.amazonaws.com alone.
  trusts_only_ec2 = length(local.host_trust_policy.Statement) > 0 && alltrue([for statement in local.host_trust_policy.Statement :
    statement.Effect == "Allow"
    && try(statement.Action, null) == "sts:AssumeRole"
    && try(statement.NotPrincipal, null) == null
    && try(statement.NotAction, null) == null
    && keys(statement.Principal) == ["Service"]
    && try(tolist(statement.Principal.Service), [statement.Principal.Service]) == ["ec2.amazonaws.com"]
  ])

  host_policy = {
    Version = "2012-10-17"
    Statement = concat(local.bucket_rw_statements, [
      # Trees and commits a checkpoint publishes (L74). Reads of a tree by id on a cache miss.
      {
        Sid      = "ObjectsTable"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:PutItem", "dynamodb:BatchWriteItem"]
        Resource = [local.table_arns["objects"]]
      },
      # The hosts' CA certificate, to verify the tier's client certificate on --listen-compute (§9.12). The one
      # object of the trust bucket a host may read; the AOP CA next to it is the public listener's business.
      {
        Sid      = "ReadHostsCaCertificate"
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = ["${aws_s3_bucket.trust.arn}/hosts-ca.pem"]
      },
      # VM results are the tier's to write (the host hands the body to the tier in its "ended" call, K4): a host
      # never puts under <lineage>/results/, whatever the shared bucket statement allows.
      {
        Sid      = "NoResults"
        Effect   = "Deny"
        Action   = ["s3:PutObject", "s3:PutObjectTagging"]
        Resource = ["${aws_s3_bucket.objects.arn}/*/results/*"]
      },
      # Belt and braces: whatever else is attached to a pool role later, a host never touches a ref, a lineage or a
      # control table directly (it asks the tier, which checks the fence), and never assumes another role.
      {
        Sid      = "NoControlTables"
        Effect   = "Deny"
        Action   = ["dynamodb:*"]
        Resource = [for table, arn in local.table_arns : arn if table != "objects"]
      },
      {
        Sid      = "NoAssumeRole"
        Effect   = "Deny"
        Action   = ["sts:AssumeRole", "sts:AssumeRoleWithWebIdentity", "sts:AssumeRoleWithSAML"]
        Resource = "*"
      },
    ])
  }

  host_policy_sts_allows = [for statement in local.host_policy.Statement : statement.Sid
  if statement.Effect == "Allow" && anytrue([for action in flatten([statement.Action]) : startswith(lower(action), "sts:")])]
}

resource "aws_iam_policy" "host" {
  name        = "${var.name}-${var.env}-host"
  description = "camelfsd --role host: the camelFS bucket (read, write, no delete) and the objects table. Attach to the job-hosts pool roles."
  policy      = jsonencode(local.host_policy)

  lifecycle {
    precondition {
      condition     = length(local.host_policy_sts_allows) == 0
      error_message = "The host policy must not allow any sts: action."
    }
    precondition {
      condition     = !anytrue([for statement in local.host_policy.Statement : statement.Effect == "Allow" && (contains(flatten([statement.Action]), "s3:DeleteObject") || contains(flatten([statement.Action]), "s3:*"))])
      error_message = "The host policy must not delete objects."
    }
  }
}

resource "aws_iam_role" "host" {
  name                 = "${var.name}-${var.env}-host"
  description          = "camelFS hosts outside the job-hosts pools (camelfsd --role host). Trusts ec2.amazonaws.com only: see infra/camelfs/README.md."
  assume_role_policy   = jsonencode(local.host_trust_policy)
  max_session_duration = 3600

  lifecycle {
    precondition {
      condition     = local.trusts_only_ec2
      error_message = "The camelFS host role must trust only the service principal ec2.amazonaws.com (the job-hosts trust-policy invariant)."
    }
    postcondition {
      condition = alltrue([for statement in jsondecode(self.assume_role_policy).Statement :
        statement.Effect == "Allow"
        && try(statement.Action, null) == "sts:AssumeRole"
        && try(statement.NotPrincipal, null) == null
        && try(statement.NotAction, null) == null
        && keys(statement.Principal) == ["Service"]
        && try(tolist(statement.Principal.Service), [statement.Principal.Service]) == ["ec2.amazonaws.com"]
      ])
      error_message = "The camelFS host role's trust policy in AWS trusts something other than ec2.amazonaws.com. Revert it."
    }
  }
}

resource "aws_iam_role_policy_attachment" "host" {
  role       = aws_iam_role.host.name
  policy_arn = aws_iam_policy.host.arn
}

resource "aws_iam_role_policy_attachment" "host_ssm" {
  role       = aws_iam_role.host.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "host" {
  name = "${var.name}-${var.env}-host"
  role = aws_iam_role.host.name
}

# The live role, read on every plan: warn if its trust policy no longer trusts only EC2, even when the change was
# made outside Terraform and no refresh has run. (On the first plan the role does not exist yet; that warning is
# expected once.)
check "host_role_trust" {
  data "aws_iam_role" "host_live" {
    name = "${var.name}-${var.env}-host"
  }

  assert {
    condition = alltrue([for statement in jsondecode(data.aws_iam_role.host_live.assume_role_policy).Statement :
      statement.Effect == "Allow"
      && try(statement.Action, null) == "sts:AssumeRole"
      && try(statement.NotPrincipal, null) == null
      && try(statement.NotAction, null) == null
      && keys(statement.Principal) == ["Service"]
      && try(tolist(statement.Principal.Service), [statement.Principal.Service]) == ["ec2.amazonaws.com"]
    ])
    error_message = "The live camelFS host role trusts something other than ec2.amazonaws.com."
  }
}

# --- guest-image publisher (CI) ---

data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

locals {
  guest_image_keys = "${aws_s3_bucket.objects.arn}/${var.guest_image_prefix}guest/*"

  publisher_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "PutGuestImages"
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = [local.guest_image_keys]
      },
      {
        Sid      = "EncryptThroughS3"
        Effect   = "Allow"
        Action   = ["kms:GenerateDataKey"]
        Resource = [aws_kms_key.objects.arn]
        Condition = {
          StringEquals = { "kms:ViaService" = "s3.${var.region}.amazonaws.com" }
        }
      },
    ]
  }
}

resource "aws_iam_role" "guest_image_publisher" {
  name        = "${var.name}-${var.env}-guest-image-publisher"
  description = "GitHub Actions (production environment) publishing the content-addressed camelFS guest image: PutObject under ${var.guest_image_prefix}guest/ only."
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = data.aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = [for subject in var.github_subjects : "repo:${subject}:environment:${var.github_environment}"]
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "guest_image_publisher" {
  name   = "publish-guest-image"
  role   = aws_iam_role.guest_image_publisher.name
  policy = jsonencode(local.publisher_policy)

  lifecycle {
    precondition {
      condition     = alltrue([for statement in local.publisher_policy.Statement : alltrue([for action in flatten([statement.Action]) : contains(["s3:PutObject", "kms:GenerateDataKey"], action)])])
      error_message = "The guest-image publisher may only put objects (and obtain a data key for them): no read, list or delete."
    }
  }
}
