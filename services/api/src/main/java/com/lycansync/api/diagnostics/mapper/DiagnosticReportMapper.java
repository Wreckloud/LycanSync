package com.lycansync.api.diagnostics.mapper;

import com.lycansync.api.diagnostics.model.DiagnosticReportEntry;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * 管理服主收件箱中的压缩诊断报告。
 *
 * @author Wreckloud
 * @since 2026-11-24
 */
@Mapper
public interface DiagnosticReportMapper {
    void insert(@Param("id") UUID id, @Param("userId") UUID userId, @Param("size") long size, @Param("gzip") byte[] gzip);
    void prune(@Param("userId") UUID userId);
    void pruneOldest();
    List<DiagnosticReportEntry> list();
    Optional<byte[]> content(@Param("id") UUID id);
}
