package com.lycansync.api.diagnostics.service;

import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.JsonToken;
import com.fasterxml.jackson.core.StreamReadConstraints;
import com.fasterxml.jackson.core.exc.StreamConstraintsException;
import com.lycansync.api.auth.mapper.AccessLinkMapper;
import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.auth.service.OwnerSettingsService;
import com.lycansync.api.common.error.ApiErrorCode;
import com.lycansync.api.diagnostics.mapper.DiagnosticReportMapper;
import com.lycansync.api.diagnostics.model.DiagnosticReportEntry;
import com.lycansync.api.group.exception.GroupException;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Semaphore;
import java.util.zip.GZIPInputStream;

/**
 * 校验成员主动提交的诊断快照，并限制收件箱的写入和读取范围。
 *
 * @author Wreckloud
 * @since 2026-11-24
 */
@Service
@RequiredArgsConstructor
public class DiagnosticReportService {
    private static final int MAX_COMPRESSED_BYTES = 8 * 1024 * 1024;
    private static final int MAX_JSON_BYTES = 40 * 1024 * 1024;
    private static final JsonFactory JSON = JsonFactory.builder().streamReadConstraints(
            StreamReadConstraints.builder().maxDocumentLength(MAX_JSON_BYTES).build()).build();
    private final DiagnosticReportMapper reports;
    private final OwnerSettingsService owners;
    private final AccessLinkMapper access;
    private final TransactionTemplate transactions;
    private final Semaphore uploads = new Semaphore(2);

    public void receive(AuthenticatedUser user, InputStream body) throws IOException {
        if (!uploads.tryAcquire()) throw new GroupException(HttpStatus.TOO_MANY_REQUESTS, ApiErrorCode.INVALID_REQUEST, "其他日志正在上传，请稍后重试。");
        try {
            byte[] gzip = body.readNBytes(MAX_COMPRESSED_BYTES + 1);
            if (gzip.length > MAX_COMPRESSED_BYTES) throw tooLarge();
            long size = validate(gzip);
            // 网络读取和格式校验完成后才占用数据库连接；写入与轮换一起提交。
            transactions.executeWithoutResult(status -> {
                if (!Boolean.TRUE.equals(access.lockInitialization())) throw new GroupException(HttpStatus.CONFLICT,
                        ApiErrorCode.INVALID_REQUEST, "服务器尚未完成首次激活");
                reports.insert(UUID.randomUUID(), user.id(), size, gzip);
                reports.prune(user.id());
                reports.pruneOldest();
            });
        } finally { uploads.release(); }
    }

    private long validate(byte[] gzip) {
        try (var input = new GZIPInputStream(new ByteArrayInputStream(gzip)); var parser = JSON.createParser(input)) {
            if (parser.nextToken() != JsonToken.START_OBJECT) throw invalid();
            boolean kind = false;
            boolean samples = false;
            while (parser.nextToken() == JsonToken.FIELD_NAME) {
                String name = parser.currentName();
                JsonToken value = parser.nextToken();
                if ("kind".equals(name)) kind = value == JsonToken.VALUE_STRING && "lycansync-diagnostics".equals(parser.getText());
                if ("samples".equals(name)) samples = value == JsonToken.START_ARRAY;
                parser.skipChildren();
            }
            if (!kind || !samples || parser.currentToken() != JsonToken.END_OBJECT || parser.nextToken() != null) throw invalid();
            long size = parser.currentLocation().getByteOffset();
            if (size <= 0) throw invalid();
            if (size > MAX_JSON_BYTES) throw tooLarge();
            return size;
        } catch (StreamConstraintsException e) { throw tooLarge(); }
        catch (IOException e) { throw invalid(); }
    }

    public List<DiagnosticReportEntry> list(AuthenticatedUser user) {
        owners.requireOwner(user);
        return reports.list();
    }

    public byte[] download(AuthenticatedUser user, UUID id) {
        owners.requireOwner(user);
        return reports.content(id).orElseThrow(() -> new GroupException(HttpStatus.NOT_FOUND,
                ApiErrorCode.INVALID_REQUEST, "报告已移除，请刷新列表。"));
    }

    private static GroupException invalid() {
        return new GroupException(HttpStatus.BAD_REQUEST, ApiErrorCode.INVALID_REQUEST, "诊断报告格式无效。");
    }
    private static GroupException tooLarge() {
        return new GroupException(HttpStatus.PAYLOAD_TOO_LARGE, ApiErrorCode.INVALID_REQUEST, "报告超过上传上限，可导出文件。");
    }
}
