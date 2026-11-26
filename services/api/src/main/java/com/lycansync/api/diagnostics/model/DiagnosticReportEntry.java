package com.lycansync.api.diagnostics.model;

import io.swagger.v3.oas.annotations.media.Schema;
import java.time.Instant;
import java.util.UUID;

/**
 * 服主收件列表中的报告摘要。
 *
 * @author Wreckloud
 * @since 2026-11-24
 */
@Schema(description = "成员主动上传的诊断报告")
public record DiagnosticReportEntry(UUID id, UUID userId, String nickname, Instant uploadedAt, long byteSize) {}
