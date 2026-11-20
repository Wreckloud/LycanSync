package com.lycansync.api.chat.service;

import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.chat.config.ChatFileProperties;
import com.lycansync.api.chat.dto.ChatAttachmentResponse;
import com.lycansync.api.chat.dto.ChatMessageResponse;
import com.lycansync.api.chat.event.ChatMessageCreatedEvent;
import com.lycansync.api.chat.mapper.ChatMapper;
import com.lycansync.api.chat.model.ChatFileAttachment;
import com.lycansync.api.chat.model.ChatFileMetadata;
import com.lycansync.api.chat.model.ChatMessage;
import com.lycansync.api.chat.model.ChatMessageType;
import com.lycansync.api.chat.model.ChatMessageView;
import com.lycansync.api.common.error.ApiErrorCode;
import com.lycansync.api.group.exception.GroupException;
import com.lycansync.api.group.service.GroupService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.time.Clock;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.locks.Lock;

/**
 * 群聊普通文件的流式持久化与下载。
 *
 * @author Wreckloud
 * @since 2026-09-29
 */
@Service
@Slf4j
public class ChatFileService {

    private static final int COPY_BUFFER_SIZE = 64 * 1024;
    private final ChatMapper mapper;
    private final ChatFileQuotaService quotaService;
    private final GroupService groupService;
    private final ChatFileProperties properties;
    private final ChatUploadSettingsService settings;
    private final ChatVideoEncoder encoder;
    private final Clock systemClock;
    private final TransactionTemplate transactions;
    private final ChatFileStorageCoordinator coordinator;
    private final ApplicationEventPublisher events;

    public ChatFileService(ChatMapper mapper, ChatFileQuotaService quotaService, GroupService groupService,
                          ChatFileProperties properties, Clock systemClock, TransactionTemplate transactions,
                          ChatFileStorageCoordinator coordinator, ApplicationEventPublisher events, ChatUploadSettingsService settings,
                          ChatVideoEncoder encoder) {
        this.mapper = mapper;
        this.quotaService = quotaService;
        this.groupService = groupService;
        this.properties = properties;
        this.systemClock = systemClock;
        this.transactions = transactions;
        this.coordinator = coordinator;
        this.events = events;
        this.settings = settings;
        this.encoder = encoder;
    }

    public ChatMessageResponse upload(UUID groupId, AuthenticatedUser user, UUID uploadId,
                                      String encodedFileName, String content, long expectedSize, InputStream input) {
        return upload(groupId, user, uploadId, encodedFileName, content, expectedSize, input, null, false);
    }

    public ChatMessageResponse upload(UUID groupId, AuthenticatedUser user, UUID uploadId,
                                      String encodedFileName, String content, long expectedSize, InputStream input,
                                      UUID declaredMessageId, boolean optimizeVideo) {
        groupService.requireMember(groupId, user);
        ChatMessageView previousUpload = mapper.findFileMessage(groupId, uploadId, user.id());
        if (previousUpload != null) {
            if (declaredMessageId != null && !declaredMessageId.equals(previousUpload.id())) throw deliveryConflict();
            return toResponse(previousUpload);
        }
        String fileName = decodeFileName(encodedFileName);
        if (declaredMessageId == null) settings.checkFileSize(expectedSize);
        if (declaredMessageId != null) {
            ChatMessageView declaration = declaration(groupId, declaredMessageId);
            if (!matches(declaration, user, fileName, expectedSize, normalizeContent(decodeHeaderText(content)))
                    || !"PENDING".equals(declaration.transferStatus())
                    || !mapper.isCurrentAttempt(declaredMessageId, uploadId)) throw deliveryConflict();
        }

        UUID attachmentId = UUID.randomUUID();
        Path temporaryFile = temporaryPath(uploadId);
        Path storedFile = storedPath(attachmentId);
        Lock uploadLock = coordinator.uploadLock();
        uploadLock.lock();
        try {
            try {
                quotaService.reserve(uploadId, groupId, expectedSize, coordinator.processInstanceId());
            } catch (DuplicateKeyException exception) {
                // 预留事务已回滚；这里只重查，不清理另一请求持有的文件或额度。
                ChatMessageView completedUpload = mapper.findFileMessage(groupId, uploadId, user.id());
                if (completedUpload != null) return toResponse(completedUpload);
                throw new GroupException(HttpStatus.CONFLICT, ApiErrorCode.INVALID_REQUEST,
                        "这个文件还在上传，请稍后重试。");
            }
            boolean completed = false;
            try {
                // 另一请求可能在等待额度行锁时完成；归还本次预留，不重复接收文件。
                ChatMessageView completedUpload = mapper.findFileMessage(groupId, uploadId, user.id());
                if (completedUpload != null) return toResponse(completedUpload);
                writeTemporaryFile(input, temporaryFile, expectedSize);
                var attachment = storeUpload(temporaryFile, storedFile, attachmentId, fileName, expectedSize, optimizeVideo);
                ChatMessageResponse response = transactions.execute(status -> persistMessageInTransaction(groupId,
                        user, attachmentId, uploadId, attachment.fileName(), content, attachment.byteSize(), declaredMessageId));
                completed = true;
                return response;
            } catch (IncompleteUploadException exception) {
                throw new GroupException(HttpStatus.BAD_REQUEST, ApiErrorCode.INVALID_REQUEST,
                        "文件未能完整上传，或大小不一致，请重新上传。");
            } catch (IOException exception) {
                log.error("群聊文件存储失败", exception);
                throw new GroupException(HttpStatus.INTERNAL_SERVER_ERROR, ApiErrorCode.CHAT_FILE_STORAGE_FAILED,
                        "服务器文件存储暂时不可用");
            } finally {
                // 文件仍占用磁盘时保留额度，避免清理失败后继续接受超出容量的上传。
                boolean temporaryRemoved = deleteQuietly(temporaryFile);
                if (!completed) {
                    boolean storedRemoved = deleteQuietly(storedFile);
                    if (temporaryRemoved && storedRemoved) {
                        try {
                            quotaService.release(uploadId);
                            if (declaredMessageId != null) mapper.stopDelivery(groupId, user.id(), declaredMessageId, uploadId);
                        } catch (RuntimeException exception) {
                            log.error("群聊上传失败后额度预留释放失败，保留记录等待恢复: {}", uploadId, exception);
                            throw exception;
                        }
                    } else {
                        log.warn("群聊上传文件未能完整清理，保留额度预留等待恢复: {}", uploadId);
                    }
                }
            }
        } finally {
            uploadLock.unlock();
        }
    }

    @Transactional
    public ChatMessageResponse declare(UUID groupId, AuthenticatedUser user, UUID id, UUID attempt,
                                       String encodedFileName, long byteSize, String content) {
        groupService.requireMember(groupId, user);
        String fileName = decodeFileName(encodedFileName);
        String text = normalizeContent(content);
        if (mapper.lockGroupForMessageSend(groupId) == null) throw deliveryConflict();
        groupService.requireMember(groupId, user);
        ChatMessageView existing = declaration(groupId, id);
        if (existing != null) {
            if (existing.transferStatus() == null && existing.senderUserId().equals(user.id())
                    && existing.content().equals(text) && existing.type() == ChatMessageType.FILE) return toResponse(existing);
            if (!matches(existing, user, fileName, byteSize, text)) throw deliveryConflict();
        }
        settings.checkFileSize(byteSize);
        if (!mapper.hasFileCapacity(byteSize, properties.getMaxStorageSize())) {
            throw new GroupException(HttpStatus.INSUFFICIENT_STORAGE, ApiErrorCode.CHAT_FILE_STORAGE_FULL,
                    "服务器文件存储空间不足");
        }
        if (existing == null) {
            if (mapper.messageIdExists(id)) throw deliveryConflict();
            long sequence = mapper.allocateMessageSequence(groupId);
            mapper.insertMessage(new ChatMessage(id, groupId, user.id(), ChatMessageType.FILE,
                    text, Instant.now(systemClock), sequence));
            mapper.insertDelivery(id, attempt, fileName, byteSize);
        } else if (mapper.retryDelivery(id, attempt) != 1) {
            throw deliveryConflict();
        }
        events.publishEvent(new ChatMessageCreatedEvent(groupId));
        return toResponse(declaration(groupId, id));
    }

    public List<ChatMessageResponse> deliveries(UUID groupId, AuthenticatedUser user, List<UUID> ids) {
        groupService.requireMember(groupId, user);
        return mapper.findDeliveries(groupId, ids).stream().map(this::toResponse).toList();
    }

    public void stop(UUID groupId, AuthenticatedUser user, UUID id, UUID attempt) {
        groupService.requireMember(groupId, user);
        mapper.stopDelivery(groupId, user.id(), id, attempt);
    }

    private ChatMessageView declaration(UUID groupId, UUID id) {
        return mapper.findDeliveries(groupId, List.of(id)).stream().findFirst().orElse(null);
    }

    private boolean matches(ChatMessageView message, AuthenticatedUser user, String name, long size, String content) {
        return message != null && message.senderUserId().equals(user.id()) && name.equals(message.attachmentFileName())
                && message.attachmentByteSize() == size && message.content().equals(content);
    }

    private GroupException deliveryConflict() {
        return new GroupException(HttpStatus.CONFLICT, ApiErrorCode.INVALID_REQUEST, "文件发送状态已改变，请重试。");
    }

    public ChatFileMetadata findMetadata(UUID groupId, UUID attachmentId, AuthenticatedUser user) {
        groupService.requireMember(groupId, user);
        ChatFileMetadata metadata = mapper.findFileMetadata(groupId, attachmentId);
        if (metadata == null) {
            throw new GroupException(HttpStatus.NOT_FOUND, ApiErrorCode.CHAT_ATTACHMENT_NOT_FOUND, "消息文件不存在");
        }
        return metadata;
    }

    public ChatMessageResponse findCompletedUpload(UUID groupId, UUID uploadId, AuthenticatedUser user) {
        groupService.requireMember(groupId, user);
        ChatMessageView message = mapper.findFileMessage(groupId, uploadId, user.id());
        return message == null ? null : toResponse(message);
    }

    public Resource findFile(UUID attachmentId) {
        Path path = storedPath(attachmentId);
        Resource resource = new FileSystemResource(path);
        if (!resource.exists() || !resource.isReadable()) {
            throw new GroupException(HttpStatus.NOT_FOUND, ApiErrorCode.CHAT_ATTACHMENT_NOT_FOUND, "消息文件不存在");
        }
        return resource;
    }

    private ChatMessageResponse persistMessageInTransaction(UUID groupId, AuthenticatedUser user, UUID attachmentId,
                                                            UUID uploadId, String fileName, String content,
                                                            long byteSize, UUID declaredMessageId) {
        Instant createdAt;
        UUID messageId;
        String normalizedContent = normalizeContent(decodeHeaderText(content));
        if (declaredMessageId != null) {
            if (mapper.lockGroupForMessageSend(groupId) == null) throw deliveryConflict();
            groupService.requireMember(groupId, user);
            if (mapper.finishDelivery(declaredMessageId, uploadId) != 1) throw deliveryConflict();
            createdAt = mapper.findMessageCreatedAt(declaredMessageId);
            messageId = declaredMessageId;
        } else {
            Long sequenceNumber = mapper.allocateMessageSequence(groupId);
            if (sequenceNumber == null) {
                throw new GroupException(HttpStatus.NOT_FOUND, ApiErrorCode.GROUP_NOT_FOUND, "群组不存在");
            }
            groupService.requireMember(groupId, user);
            messageId = UUID.randomUUID();
            createdAt = Instant.now(systemClock);
            mapper.insertMessage(new ChatMessage(messageId, groupId, user.id(), ChatMessageType.FILE,
                    normalizedContent, createdAt, sequenceNumber));
        }
        mapper.insertFileAttachment(new ChatFileAttachment(attachmentId, messageId, uploadId, fileName, byteSize));
        quotaService.complete(uploadId, byteSize);
        events.publishEvent(new ChatMessageCreatedEvent(groupId));
        ChatAttachmentResponse attachment = new ChatAttachmentResponse(attachmentId,
                "application/octet-stream", null, null, byteSize, fileName);
        return new ChatMessageResponse(messageId, user.id(), user.nickname(), ChatMessageType.FILE,
                normalizedContent, createdAt, attachment);
    }

    private ChatFileMetadata storeUpload(Path temporaryFile, Path storedFile, UUID attachmentId, String fileName,
                                         long expectedSize, boolean optimizeVideo) throws IOException {
        String format = optimizeVideo ? ChatFileMediaService.videoFormat(fileName) : null;
        if (format == null) {
            moveToStorage(temporaryFile, storedFile);
            return new ChatFileMetadata(attachmentId, fileName, expectedSize);
        }
        long limit = settings.limits().maxFileBytes();
        try {
            encoder.encode(temporaryFile, format, storedFile, limit, false);
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            throw new GroupException(HttpStatus.SERVICE_UNAVAILABLE, ApiErrorCode.CHAT_FILE_STORAGE_FAILED, "视频处理已中断，请重试。");
        } catch (IOException exception) {
            log.warn("群聊视频优化失败 attachmentId={} reason={}", attachmentId, exception.getClass().getSimpleName());
            throw new GroupException(HttpStatus.UNPROCESSABLE_ENTITY, ApiErrorCode.CHAT_FILE_STORAGE_FAILED,
                    "视频未能处理，可重试或勾选“发送原文件”重新发送。");
        }
        String attachmentName = fileName.substring(0, fileName.lastIndexOf('.')) + ".mp4";
        long attachmentBytes = Files.size(storedFile);
        Files.delete(temporaryFile);
        return new ChatFileMetadata(attachmentId, attachmentName, attachmentBytes);
    }

    private void writeTemporaryFile(InputStream input, Path path, long expectedSize) throws IOException {
        Path directory = properties.getStorageDirectory().toAbsolutePath().normalize();
        Files.createDirectories(directory.resolve(".tmp"));
        long total = 0;
        byte[] buffer = new byte[COPY_BUFFER_SIZE];
        try (FileChannel output = FileChannel.open(path, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
            int read;
            while (true) {
                try {
                    read = input.read(buffer);
                } catch (IOException exception) {
                    throw new IncompleteUploadException(exception);
                }
                if (read == -1) break;
                total += read;
                if (total > expectedSize) {
                    throw new IncompleteUploadException();
                }
                ByteBuffer bytes = ByteBuffer.wrap(buffer, 0, read);
                while (bytes.hasRemaining()) output.write(bytes);
            }
            if (total != expectedSize) throw new IncompleteUploadException();
            output.force(true);
        }
    }

    private static final class IncompleteUploadException extends IOException {
        private static final long serialVersionUID = 1L;

        private IncompleteUploadException() {
        }

        private IncompleteUploadException(IOException cause) {
            super(cause);
        }
    }

    private void moveToStorage(Path temporaryFile, Path storedFile) throws IOException {
        try {
            Files.move(temporaryFile, storedFile, StandardCopyOption.ATOMIC_MOVE);
        } catch (AtomicMoveNotSupportedException exception) {
            Files.move(temporaryFile, storedFile);
        }
    }

    private String decodeFileName(String encodedFileName) {
        try {
            byte[] bytes = Base64.getUrlDecoder().decode(encodedFileName);
            String fileName = StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes)).toString();
            fileName = fileName.replace('\\', '/');
            fileName = fileName.substring(fileName.lastIndexOf('/') + 1);
            if (fileName.isBlank() || fileName.codePointCount(0, fileName.length()) > 255
                    || fileName.codePoints().anyMatch(Character::isISOControl)) {
                throw new IllegalArgumentException("文件名无效");
            }
            return fileName;
        } catch (IllegalArgumentException | CharacterCodingException exception) {
            throw new GroupException(HttpStatus.BAD_REQUEST, ApiErrorCode.INVALID_REQUEST, "文件名无效");
        }
    }

    private String normalizeContent(String content) {
        if (content == null) return "";
        if (content.codePointCount(0, content.length()) > 2000
                || content.codePoints().anyMatch(codePoint -> Character.isISOControl(codePoint)
                && codePoint != '\n' && codePoint != '\r' && codePoint != '\t')) {
            throw new GroupException(HttpStatus.BAD_REQUEST, ApiErrorCode.INVALID_REQUEST, "消息文字无效");
        }
        return content.isBlank() ? "" : content;
    }

    private String decodeHeaderText(String encodedContent) {
        if (encodedContent == null || encodedContent.isEmpty()) return "";
        try {
            byte[] bytes = Base64.getUrlDecoder().decode(encodedContent);
            return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
        } catch (IllegalArgumentException | CharacterCodingException exception) {
            throw new GroupException(HttpStatus.BAD_REQUEST, ApiErrorCode.INVALID_REQUEST, "消息文字无效");
        }
    }

    private ChatMessageResponse toResponse(ChatMessageView message) {
        ChatAttachmentResponse attachment = new ChatAttachmentResponse(message.attachmentId(),
                message.attachmentContentType(), message.attachmentWidth(), message.attachmentHeight(),
                message.attachmentByteSize(), message.attachmentFileName(), message.transferStatus());
        return new ChatMessageResponse(message.id(), message.senderUserId(), message.senderNickname(), message.type(),
                message.content(), message.createdAt(), attachment, message.senderAvatar(), message.senderDeletedAt());
    }

    private Path temporaryPath(UUID uploadId) {
        return properties.getStorageDirectory().toAbsolutePath().normalize().resolve(".tmp")
                .resolve(uploadId + ".part");
    }

    private Path storedPath(UUID attachmentId) {
        return properties.getStorageDirectory().toAbsolutePath().normalize().resolve(attachmentId + ".bin");
    }

    private boolean deleteQuietly(Path path) {
        try {
            Files.deleteIfExists(path);
            return true;
        } catch (IOException exception) {
            log.warn("无法清理群聊上传文件，后续启动时会再次回收: {}", path.getFileName(), exception);
            return false;
        }
    }
}
