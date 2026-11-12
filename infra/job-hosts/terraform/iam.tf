# The job-host instance roles, one per pool (camelrun-job-hosts-build-prod, camelrun-job-hosts-test-prod):
# JOB_HOST_ROLE_ARNS on the runtime, as pool=arn pairs (output job_host_role_arns). The runtime takes a host's pool
# from the role it attests with, never from what the host says, so a test host cannot pass itself off as a build host.
#
# TRUST-POLICY INVARIANT (docs/design/job-hosts-plan.md, "Required trust policy"). The runtime takes the host id from
# the role session name of a signed sts:GetCallerIdentity, and whoever assumes the role chooses that name. EC2 sets
# it to the instance id; any other principal able to assume this role could name a running instance and take its
# jobs and their secrets. So each role trusts ONLY the service principal ec2.amazonaws.com: no user, role, account or
# the role itself, and no statement anywhere grants sts:AssumeRole on it. Do not give anyone sts:AssumeRole on them.
# Guards fail the plan if that changes: the precondition and postcondition on aws_iam_role.host, the checks
# "host_role_trust_build" / "host_role_trust_test" against the live roles, and tests/job-hosts.tftest.hcl.
#
# Who can still become a host: anyone allowed iam:PassRole on one of these roles together with ec2:RunInstances (or
# ec2:AssociateIamInstanceProfile) can start a real instance with it, which then enrolls as a real host of that pool.
# Grant iam:PassRole on them to nobody but the operator who applies this module (Auto Scaling passes it through its
# service-linked role).

locals {
  host_pools      = toset(keys(local.pools))
  host_role_names = { for pool in local.host_pools : pool => "${var.name}-${pool}-${var.env}" }

  host_trust_policy = {
    Version = "2012-10-17"
    Statement = [{
      Sid       = "EC2Only"
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  }

  # True only for a trust policy whose every statement is an Allow of sts:AssumeRole to ec2.amazonaws.com alone,
  # with no other principal, action or NotPrincipal.
  trusts_only_ec2 = length(local.host_trust_policy.Statement) > 0 && alltrue([for statement in local.host_trust_policy.Statement :
    statement.Effect == "Allow"
    && try(statement.Action, null) == "sts:AssumeRole"
    && try(statement.NotPrincipal, null) == null
    && try(statement.NotAction, null) == null
    && keys(statement.Principal) == ["Service"]
    && try(tolist(statement.Principal.Service), [statement.Principal.Service]) == ["ec2.amazonaws.com"]
  ])

  ssm_parameter_prefix = "/camelrun/job-hosts/${var.env}"
  # The only parameters a host may read (ssm.tf), by exact name: anything else put under the prefix later (a token,
  # say) stays out of reach. Built from names, so the policy does not depend on the parameters.
  host_parameter_arns = [for leaf in ["runtime-url", "enrollment-audience"] : "arn:aws:ssm:${var.region}:${var.account_id}:parameter${local.ssm_parameter_prefix}/${leaf}"]

  # Everything the host role may do besides AmazonSSMManagedInstanceCore. No secrets, no database, no STS.
  host_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadImagesAndSnapshots"
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = ["${aws_s3_bucket.images.arn}/images/*", "${aws_s3_bucket.images.arn}/snapshots/*"]
      },
      {
        Sid      = "ListImagesAndSnapshots"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = [aws_s3_bucket.images.arn]
        Condition = {
          StringLike = { "s3:prefix" = ["images/*", "snapshots/*"] }
        }
      },
      {
        Sid      = "DecryptImagesThroughS3"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = [aws_kms_key.images.arn]
        Condition = {
          StringEquals = { "kms:ViaService" = "s3.${var.region}.amazonaws.com" }
        }
      },
      {
        Sid      = "ReadOwnParameters"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter", "ssm:GetParameters"]
        Resource = local.host_parameter_arns
      },
      # A draining host ends its own termination lifecycle hook (pools.tf) instead of waiting out the timeout. No
      # condition key names the instance, so a host could also end another pool host's wait: at worst it is
      # terminated sooner, which a host can't otherwise cause.
      {
        Sid      = "CompleteOwnDrain"
        Effect   = "Allow"
        Action   = ["autoscaling:CompleteLifecycleAction", "autoscaling:RecordLifecycleActionHeartbeat"]
        Resource = ["arn:aws:autoscaling:${var.region}:${var.account_id}:autoScalingGroup:*:autoScalingGroupName/${var.name}-*"]
      },
      # AmazonSSMManagedInstanceCore allows ssm:GetParameter(s) on every parameter in the account; a host reads
      # only its two.
      {
        Sid         = "NoOtherParameters"
        Effect      = "Deny"
        Action      = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
        NotResource = local.host_parameter_arns
      },
      # Belt and braces: the role can never assume another role, whatever is attached to it later.
      {
        Sid      = "NoAssumeRole"
        Effect   = "Deny"
        Action   = ["sts:AssumeRole", "sts:AssumeRoleWithWebIdentity", "sts:AssumeRoleWithSAML"]
        Resource = "*"
      },
    ]
  }

  # Allow statements that mention STS: must stay empty.
  host_policy_sts_allows = [for statement in local.host_policy.Statement : statement.Sid
  if statement.Effect == "Allow" && anytrue([for action in flatten([statement.Action]) : startswith(lower(action), "sts:")])]

  host_managed_policies = ["arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"]
}

resource "aws_iam_role" "host" {
  for_each             = local.host_role_names
  name                 = each.value
  description          = "camelRun ${each.key} job hosts (${var.env}). Trusts ec2.amazonaws.com only: see infra/job-hosts/README.md."
  assume_role_policy   = jsonencode(local.host_trust_policy)
  max_session_duration = 3600

  lifecycle {
    precondition {
      condition     = local.trusts_only_ec2
      error_message = "The job-host roles must trust only the service principal ec2.amazonaws.com (docs/design/job-hosts-plan.md, \"Required trust policy\")."
    }
    # Also checked against what AWS returns (after a refresh, a console edit shows up here).
    postcondition {
      condition = alltrue([for statement in jsondecode(self.assume_role_policy).Statement :
        statement.Effect == "Allow"
        && try(statement.Action, null) == "sts:AssumeRole"
        && try(statement.NotPrincipal, null) == null
        && try(statement.NotAction, null) == null
        && keys(statement.Principal) == ["Service"]
        && try(tolist(statement.Principal.Service), [statement.Principal.Service]) == ["ec2.amazonaws.com"]
      ])
      error_message = "A job-host role's trust policy in AWS trusts something other than ec2.amazonaws.com. Revert it: any other principal could enroll as any host."
    }
  }
}

resource "aws_iam_role_policy" "host" {
  for_each = local.host_role_names
  name     = "job-host"
  role     = aws_iam_role.host[each.key].id
  policy   = jsonencode(local.host_policy)

  lifecycle {
    precondition {
      condition     = length(local.host_policy_sts_allows) == 0
      error_message = "The job-host roles' policy must not allow any sts: action."
    }
  }
}

resource "aws_iam_role_policy_attachment" "host" {
  for_each   = { for pair in setproduct(local.host_pools, local.host_managed_policies) : "${pair[0]} ${pair[1]}" => { pool = pair[0], policy = pair[1] } }
  role       = aws_iam_role.host[each.value.pool].name
  policy_arn = each.value.policy
}

resource "aws_iam_instance_profile" "host" {
  for_each = local.host_role_names
  name     = each.value
  role     = aws_iam_role.host[each.key].name
}

# The live roles, read on every plan: warn if a trust policy no longer trusts only EC2, even when the change was made
# outside Terraform and no refresh has run. (On the first plan the roles do not exist yet; those warnings are
# expected.) One check per pool: a check's data source takes no for_each.
check "host_role_trust_build" {
  data "aws_iam_role" "host_live_build" {
    name = local.host_role_names["build"]
  }

  assert {
    condition = alltrue([for statement in jsondecode(data.aws_iam_role.host_live_build.assume_role_policy).Statement :
      statement.Effect == "Allow"
      && try(statement.Action, null) == "sts:AssumeRole"
      && try(statement.NotPrincipal, null) == null
      && try(statement.NotAction, null) == null
      && keys(statement.Principal) == ["Service"]
      && try(tolist(statement.Principal.Service), [statement.Principal.Service]) == ["ec2.amazonaws.com"]
    ])
    error_message = "The live build job-host role trusts something other than ec2.amazonaws.com."
  }
}

check "host_role_trust_test" {
  data "aws_iam_role" "host_live_test" {
    name = local.host_role_names["test"]
  }

  assert {
    condition = alltrue([for statement in jsondecode(data.aws_iam_role.host_live_test.assume_role_policy).Statement :
      statement.Effect == "Allow"
      && try(statement.Action, null) == "sts:AssumeRole"
      && try(statement.NotPrincipal, null) == null
      && try(statement.NotAction, null) == null
      && keys(statement.Principal) == ["Service"]
      && try(tolist(statement.Principal.Service), [statement.Principal.Service]) == ["ec2.amazonaws.com"]
    ])
    error_message = "The live test job-host role trusts something other than ec2.amazonaws.com."
  }
}
