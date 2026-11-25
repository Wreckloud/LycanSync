package com.lycansync.api.diagnostics.controller;

import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.diagnostics.model.DiagnosticReportEntry;
import com.lycansync.api.diagnostics.service.DiagnosticReportService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.servlet.http.HttpServletRequest;
import lombok.RequiredArgsConstructor;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.util.List;
import java.util.UUID;

/**
 * 成员提交运行日志，服主查收报告。
 *
 * @author Wreckloud
 * @since 2026-11-24
 */
@RestController
@RequestMapping("/api/diagnostics/reports")
@RequiredArgsConstructor
@Tag(name = "诊断报告")
public class DiagnosticReportController {
    private final DiagnosticReportService reports;

    @PostMapping(consumes = "application/gzip")
    @Operation(summary = "向服主提交诊断报告")
    public ResponseEntity<Void> upload(@AuthenticationPrincipal AuthenticatedUser user, HttpServletRequest request) throws IOException {
        reports.receive(user, request.getInputStream());
        return ResponseEntity.noContent().build();
    }

    @GetMapping
    @Operation(summary = "服主查看收到的诊断报告")
    public ResponseEntity<List<DiagnosticReportEntry>> list(@AuthenticationPrincipal AuthenticatedUser user) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(reports.list(user));
    }

    @GetMapping(value = "/{id}", produces = "application/json")
    @Operation(summary = "服主接收诊断报告文件")
    public ResponseEntity<byte[]> download(@AuthenticationPrincipal AuthenticatedUser user, @PathVariable UUID id) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).header(HttpHeaders.CONTENT_ENCODING, "gzip")
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"LycanSync-diagnostics-" + id + ".json\"")
                .body(reports.download(user, id));
    }
}
