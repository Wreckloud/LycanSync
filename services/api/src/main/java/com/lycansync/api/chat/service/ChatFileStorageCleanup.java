package com.lycansync.api.chat.service;

import com.lycansync.api.chat.config.ChatFileProperties;
import com.lycansync.api.chat.mapper.ChatMapper;
import com.lycansync.api.chat.model.ChatFileUploadReservation;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * 回收服务异常退出后遗留的临时和孤儿文件。
 *
 * @author Wreckloud
 * @since 2026-09-29
 */
@Slf4j
@Component
public class ChatFileStorageCleanup {

    private static final Duration STALE_AFTER = Duration.ofHours(24);
    private final ChatFileProperties properties;
    private final ChatFileQuotaService quotaService;
    private final ChatMapper mapper;
    private final Clock systemClock;

    public ChatFileStorageCleanup(ChatFileProperties properties, ChatFileQuotaService quotaService,
                                  ChatMapper mapper, Clock systemClock) {
        this.properties = properties;
        this.quotaService = quotaService;
        this.mapper = mapper;
        this.systemClock = systemClock;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void removeOrphanedFiles() {
        Path root = properties.getStorageDirectory().toAbsolutePath().normalize();
        Instant staleBefore = Instant.now(systemClock).minus(STALE_AFTER);
        try {
            Files.createDirectories(root.resolve(".tmp"));
            List<ChatFileUploadReservation> expired = quotaService.findExpiredReservations(staleBefore);
            for (ChatFileUploadReservation reservation : expired) {
                Files.deleteIfExists(root.resolve(".tmp").resolve(reservation.id() + ".part"));
                quotaService.release(reservation.id());
            }
            try (var files = Files.list(root.resolve(".tmp"))) {
                files.filter(Files::isRegularFile).filter(path -> olderThan(path, staleBefore)).forEach(this::delete);
            }
            try (var files = Files.list(root)) {
                files.filter(Files::isRegularFile).filter(path -> path.getFileName().toString().matches(
                        "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\\.bin"))
                        .filter(path -> olderThan(path, staleBefore)).forEach(this::removeOrphan);
            }
        } catch (IOException exception) {
            throw new IllegalStateException("无法清理群聊文件存储", exception);
        }
    }

    private void removeOrphan(Path path) {
        String file = path.getFileName().toString();
        UUID attachmentId = UUID.fromString(file.substring(0, file.length() - 4));
        if (!mapper.fileAttachmentExists(attachmentId)) delete(path);
    }

    private boolean olderThan(Path path, Instant staleBefore) {
        try {
            FileTime modified = Files.getLastModifiedTime(path);
            return modified.toInstant().isBefore(staleBefore);
        } catch (IOException exception) {
            log.warn("无法读取群聊临时文件时间: {}", path.getFileName());
            return false;
        }
    }

    private void delete(Path path) {
        try {
            Files.deleteIfExists(path);
        } catch (IOException exception) {
            log.warn("无法回收群聊孤儿文件: {}", path.getFileName());
        }
    }
}
