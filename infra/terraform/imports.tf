# Adopts the resources infra/provision.sh created (IDs discovered with read-only
# describe/list calls on 2026-09-23). Once `terraform apply` has recorded them in
# state these blocks are no-ops; they can be deleted after that apply.
# Terraform 1.5 has no for_each on import blocks, so each instance is listed.

import {
  to = aws_ecr_repository.runtime
  id = "camelai-agent-runtime"
}

import {
  to = aws_ecr_lifecycle_policy.runtime
  id = "camelai-agent-runtime"
}

import {
  to = aws_iam_role.runtime
  id = "camelai-agent-runtime"
}

import {
  to = aws_iam_role_policy_attachment.runtime_ssm
  id = "camelai-agent-runtime/arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

import {
  to = aws_iam_role_policy.runtime
  id = "camelai-agent-runtime:agent-runtime"
}

import {
  to = aws_iam_instance_profile.runtime
  id = "camelai-agent-runtime"
}

import {
  to = aws_security_group.runtime
  id = "sg-03e6b6d1efd4c523f"
}

import {
  to = aws_vpc_security_group_ingress_rule.runtime_https_ipv4
  id = "sgr-0e28ec55089412c9a"
}

import {
  to = aws_vpc_security_group_ingress_rule.runtime_https_ipv6
  id = "sgr-0f3771373192470aa"
}

import {
  to = aws_vpc_security_group_egress_rule.runtime_all_ipv4
  id = "sgr-0ae1ffde34c085584"
}

import {
  to = aws_vpc_security_group_egress_rule.runtime_all_ipv6
  id = "sgr-07eb0b6d3ce0619d1"
}

import {
  to = aws_instance.runtime
  id = "i-0f27dc58911079f90"
}

import {
  to = aws_eip.runtime
  id = "eipalloc-0fd99bf6de99130f1"
}

import {
  to = aws_eip_association.runtime
  id = "eipassoc-079bc00748f1d9916"
}

import {
  to = aws_dlm_lifecycle_policy.runtime
  id = "policy-033b69db7fa746fc2"
}

import {
  to = aws_cloudwatch_metric_alarm.system_check
  id = "camelai-agent-runtime-system-check"
}

import {
  to = aws_cloudwatch_metric_alarm.instance_check
  id = "camelai-agent-runtime-instance-check"
}

# Secret containers (never their values).

import {
  to = aws_secretsmanager_secret.runtime["session-secret"]
  id = "arn:aws:secretsmanager:us-west-2:904534089871:secret:camelai/agent-runtime/session-secret-7Ib4SE"
}

import {
  to = aws_secretsmanager_secret.runtime["secrets-key"]
  id = "arn:aws:secretsmanager:us-west-2:904534089871:secret:camelai/agent-runtime/secrets-key-okGGv7"
}

import {
  to = aws_secretsmanager_secret.runtime["tenants"]
  id = "arn:aws:secretsmanager:us-west-2:904534089871:secret:camelai/agent-runtime/tenants-10YCpM"
}

import {
  to = aws_secretsmanager_secret.runtime["github-oauth"]
  id = "arn:aws:secretsmanager:us-west-2:904534089871:secret:camelai/agent-runtime/github-oauth-pieO1z"
}

import {
  to = aws_secretsmanager_secret.operator_token["miguel"]
  id = "arn:aws:secretsmanager:us-west-2:904534089871:secret:camelai/agent-runtime/operator-token/miguel-ysEF59"
}

# us-east-1 alerting.

import {
  provider = aws.us_east_1
  to       = aws_sns_topic.alerts
  id       = "arn:aws:sns:us-east-1:904534089871:camelai-agent-runtime-alerts"
}

import {
  to = aws_route53_health_check.healthz
  id = "e52dad23-a155-4afb-9d5c-ef50579413b4"
}

import {
  provider = aws.us_east_1
  to       = aws_cloudwatch_metric_alarm.healthz
  id       = "camelai-agent-runtime-healthz"
}

# Cloudflare: <zone id>/<record id>.

import {
  to = cloudflare_dns_record.runtime
  id = "3180d911f20372a279a4ea408aebc765/4adc08eaa900f08d07b60114f9fd7c8a"
}
