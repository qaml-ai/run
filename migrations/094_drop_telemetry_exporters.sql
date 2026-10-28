-- Trace export was removed (#497): nothing reads or writes its settings. Its primary key goes with the table; it had no
-- other indexes, foreign keys, types or functions (049_telemetry.sql, 052_sink_set_by.sql).
drop table if exists telemetry_exporters;
