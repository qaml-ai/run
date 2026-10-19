# Voice turn latency (src/voice/latency.ts): each voice_turn_latency line is one turn, from the end of someone's
# speech to the first audio of the realtime brain's answer, stage by stage (docs/operations/voice-pipeline.md). The alarm is the
# yardstick's regression guard: end-of-speech to first audio out, p95, over enough turns to mean something.

variable "voice_latency_p95_alarm_ms" {
  description = "p95 of VoiceFirstPacketMs (end of speech to the reply's first audio) over 15 minutes that, in 3 of 4 periods with at least 20 spoken turns each, raises the voice latency alarm."
  type        = number
  default     = 2500
}

resource "aws_cloudwatch_metric_alarm" "voice_turn_latency_p95" {
  alarm_name          = "${var.name}-voice-turn-latency-p95"
  alarm_description   = "Voice answers slow: p95 from end of speech to first audio out over ${var.voice_latency_p95_alarm_ms} ms in 3 of 4 15-minute periods, with at least 20 spoken turns (voice_turn_latency; the ${var.name}-voice dashboard says which stage)"
  evaluation_periods  = 4
  datapoints_to_alarm = 3
  threshold           = var.voice_latency_p95_alarm_ms
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_topics
  ok_actions          = local.alarm_topics

  metric_query {
    id          = "slow"
    expression  = "IF(turns >= 20, p95, 0)"
    label       = "End of speech to first audio, p95 (ms)"
    return_data = true
  }
  metric_query {
    id = "p95"
    metric {
      namespace   = "AgentRuntime"
      metric_name = "VoiceFirstPacketMs"
      dimensions  = local.runtime_metric
      stat        = "p95"
      period      = 900
    }
  }
  metric_query {
    id = "turns"
    metric {
      namespace   = "AgentRuntime"
      metric_name = "VoiceFirstPacketMs"
      dimensions  = local.runtime_metric
      stat        = "SampleCount"
      period      = 900
    }
  }
}

locals {
  voice_stages = [
    ["VoiceTurnCommitMs", "turn commit (silence / turn model)"],
    ["VoiceTtsFirstAudioMs", "model's first audio"],
    ["VoiceFirstPacketMs", "first packet out"],
  ]
  voice_parts = [
    ["VoiceRealtimeMs", "realtime model (to first audio)"],
    ["VoicePlayoutMs", "playout (buffer, encode, DAVE)"],
  ]
  # Realtime brains by provider and model (voice_turn_latency's ttsProvider is a property, not a dimension): one path.
  voice_paths = ["realtime"]
}

resource "aws_cloudwatch_dashboard" "voice" {
  dashboard_name = "${var.name}-voice"
  dashboard_body = jsonencode({
    widgets = [
      { type = "text", x = 0, y = 0, width = 24, height = 2, properties = { markdown = "## ${var.name}: voice turn latency\nFrom `voice_turn_latency` lines (src/voice/latency.ts): ms from the end of someone's speech. Stages are marked the first time each happens in a turn; see docs/operations/voice-pipeline.md. Alarm: `${aws_cloudwatch_metric_alarm.voice_turn_latency_p95.alarm_name}`." } },

      { type = "metric", x = 0, y = 2, width = 12, height = 7, properties = { title = "End of speech to first audio out (ms)", region = var.region, view = "timeSeries",
        metrics = [
          [local.ns, "VoiceFirstPacketMs", "ServiceName", local.svc, { stat = "p50", label = "p50" }],
          [local.ns, "VoiceFirstPacketMs", "ServiceName", local.svc, { stat = "p95", label = "p95" }],
          [local.ns, "VoiceFirstPacketMs", "ServiceName", local.svc, { stat = "p99", label = "p99" }],
        ],
      annotations = { horizontal = [{ label = "alarm", value = var.voice_latency_p95_alarm_ms }] }, period = 300 } },
      { type = "metric", x = 12, y = 2, width = 12, height = 7, properties = { title = "Spoken turns by path (5 min)", region = var.region, view = "timeSeries", stacked = true,
        metrics = [
          for path in local.voice_paths : [local.ns, "VoiceFirstPacketMs", "ServiceName", local.svc, "Path", path, { stat = "SampleCount", label = "${path} spoken" }]
      ], period = 300 } },

      { type = "metric", x = 0, y = 9, width = 12, height = 7, properties = { title = "Stage reached, p95 (ms since end of speech)", region = var.region, view = "timeSeries",
      metrics = [for stage in local.voice_stages : [local.ns, stage[0], "ServiceName", local.svc, { stat = "p95", label = stage[1] }]], period = 300 } },
      { type = "metric", x = 12, y = 9, width = 12, height = 7, properties = { title = "Where the time goes, p50 (ms, spoken turns)", region = var.region, view = "timeSeries", stacked = true,
        metrics = concat(
          [[local.ns, "VoiceTurnCommitMs", "ServiceName", local.svc, { stat = "p50", label = "turn commit" }]],
          [for part in local.voice_parts : [local.ns, part[0], "ServiceName", local.svc, { stat = "p50", label = part[1] }]],
      ), period = 300 } },

      { type = "metric", x = 0, y = 16, width = 24, height = 6, properties = { title = "End of speech to first audio by path, p95 (ms)", region = var.region, view = "timeSeries",
        metrics = [
          for path in local.voice_paths : [local.ns, "VoiceFirstPacketMs", "ServiceName", local.svc, "Path", path, { stat = "p95", label = path }]
      ], period = 300 } },
    ]
  })
}
