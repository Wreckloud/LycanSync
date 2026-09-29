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
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.locks.Lock;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 回收服务异常退出后遗留的临时和孤儿文件。
 *
 * @author Wreckloud
 * @since 2026-09-29
 */
@Slf4j
@Component
public class ChatFileStorageCleanup {

    private static final Pattern TEMPORARY_FILE = Pattern.compile(
            "([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\\.part");
    private static final Pattern STORED_FILE = Pattern.compile(
            "([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\\.bin");

    private final ChatFileProperties properties;
    private final ChatFileQuotaService quotaService;
    private final ChatMapper mapper;
    private final ChatFileStorageCoordinator coordinator;

    public ChatFileStorageCleanup(ChatFileProperties properties, ChatFileQuotaService quotaService,
                                  ChatMapper mapper, ChatFileStorageCoordinator coordinator) {
        this.properties = properties;
        this.quotaService = quotaService;
        this.mapper = mapper;
        this.coordinator = coordinator;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void removeOrphanedFiles() {
        Lock cleanupLock = coordinator.cleanupLock();
        cleanupLock.lock();
        try {
            recoverPreviousProcessUploads();
        } catch (IOException | RuntimeException exception) {
            log.error("群聊文件启动恢复未完成，遗留项将在后续启动重试", exception);
            throw new IllegalStateException("无法清理群聊文件存储", exception);
        } finally {
            cleanupLock.unlock();
        }
    }

    private void recoverPreviousProcessUploads() throws IOException {
        Path root = properties.getStorageDirectory().toAbsolutePath().normalize();
        Path temporaryDirectory = root.resolve(".tmp");
        Files.createDirectories(temporaryDirectory);

        List<ChatFileUploadReservation> reservations = quotaService.findReservations();
        Map<UUID, ChatFileUploadReservation> reservationsById = new HashMap<>();
        Set<UUID> currentProcessReservations = new HashSet<>();
        for (ChatFileUploadReservation reservation : reservations) {
            reservationsById.put(reservation.id(), reservation);
            if (coordinator.processInstanceId().equals(reservation.processInstanceId())) {
                currentProcessReservations.add(reservation.id());
            }
        }

        Map<UUID, Boolean> releasableReservations = new HashMap<>();
        for (ChatFileUploadReservation reservation : reservations) {
            if (currentProcessReservations.contains(reservation.id())) continue;
            Path temporaryFile = temporaryDirectory.resolve(reservation.id() + ".part");
            releasableReservations.put(reservation.id(), deleteForRecovery(temporaryFile));
        }

        removeUnreservedTemporaryFiles(temporaryDirectory, reservationsById, currentProcessReservations);
        boolean orphanFilesRemoved = removeOrphanedStoredFiles(root);
        if (!orphanFilesRemoved) {
            log.warn("存在未能删除的群聊孤儿文件；保留上次进程的额度预留以便后续重试");
            return;
        }

        for (ChatFileUploadReservation reservation : reservations) {
            if (currentProcessReservations.contains(reservation.id())) continue;
            if (!Boolean.TRUE.equals(releasableReservations.get(reservation.id()))) {
                log.warn("群聊上传临时文件仍未清理，保留额度预留等待重试: {}", reservation.id());
                continue;
            }
            try {
                quotaService.release(reservation.id());
            } catch (RuntimeException exception) {
                log.error("无法释放群聊上传额度预留，记录保留等待重试: {}", reservation.id(), exception);
            }
        }
    }

    private void removeUnreservedTemporaryFiles(Path directory,
                                                Map<UUID, ChatFileUploadReservation> reservationsById,
                                                Set<UUID> currentProcessReservations) throws IOException {
        try (var paths = Files.list(directory)) {
            for (Path path : paths.filter(Files::isRegularFile).toList()) {
                Matcher matcher = TEMPORARY_FILE.matcher(path.getFileName().toString());
                if (!matcher.matches()) continue;
                UUID uploadId = UUID.fromString(matcher.group(1));
                if (currentProcessReservations.contains(uploadId) || reservationsById.containsKey(uploadId)) continue;
                deleteForRecovery(path);
            }
        }
    }

    private boolean removeOrphanedStoredFiles(Path root) throws IOException {
        boolean allRemoved = true;
        try (var paths = Files.list(root)) {
            for (Path path : paths.filter(Files::isRegularFile).toList()) {
                Matcher matcher = STORED_FILE.matcher(path.getFileName().toString());
                if (!matcher.matches()) continue;
                UUID attachmentId = UUID.fromString(matcher.group(1));
                if (mapper.fileAttachmentExists(attachmentId)) continue;
                if (!deleteForRecovery(path)) allRemoved = false;
            }
        }
        return allRemoved;
    }

    private boolean deleteForRecovery(Path path) {
        try {
            Files.deleteIfExists(path);
            return true;
        } catch (IOException exception) {
            log.warn("无法回收群聊上传文件，保留相关额度以便后续重试: {}", path.getFileName(), exception);
            return false;
        }
    }
}
