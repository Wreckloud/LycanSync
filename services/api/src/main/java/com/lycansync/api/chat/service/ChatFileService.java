package com.lycansync.api.chat.service;

import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.chat.config.ChatFileProperties;
import com.lycansync.api.chat.dto.ChatAttachmentResponse;
import com.lycansync.api.chat.dto.ChatMessageResponse;
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
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
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
    private final Clock systemClock;
    private final TransactionTemplate transactions;
    private final ChatFileStorageCoordinator coordinator;

    public ChatFileService(ChatMapper mapper, ChatFileQuotaService quotaService, GroupService groupService,
                          ChatFileProperties properties, Clock systemClock, TransactionTemplate transactions,
                          ChatFileStorageCoordinator coordinator) {
        this.mapper = mapper;
        this.quotaService = quotaService;
        this.groupService = groupService;
        this.properties = properties;
        this.systemClock = systemClock;
        this.transactions = transactions;
        this.coordinator = coordinator;
    }

    public ChatMessageResponse upload(UUID groupId, AuthenticatedUser user, UUID uploadId,
                                      String encodedFileName, String content, long expectedSize, InputStream input) {
        groupService.requireGroup(groupId);
        ChatMessageView previousUpload = mapper.findFileMessage(groupId, uploadId, user.id());
        if (previousUpload != null) return toResponse(previousUpload);
        String fileName = decodeFileName(encodedFileName);
        if (expectedSize < 0 || expectedSize > properties.getMaxFileSize()) {
            throw new GroupException(HttpStatus.PAYLOAD_TOO_LARGE, ApiErrorCode.INVALID_REQUEST,
                    "单个文件不能超过 " + properties.getMaxFileSize() + " 字节");
        }

        UUID attachmentId = UUID.randomUUID();
        Path temporaryFile = temporaryPath(uploadId);
        Path storedFile = storedPath(attachmentId);
        Lock uploadLock = coordinator.uploadLock();
        uploadLock.lock();
        try {
            quotaService.reserve(uploadId, groupId, expectedSize, coordinator.processInstanceId());
            boolean completed = false;
            try {
                writeTemporaryFile(input, temporaryFile, expectedSize);
                moveToStorage(temporaryFile, storedFile);
                ChatMessageResponse response = transactions.execute(status -> persistMessageInTransaction(groupId,
                        user, attachmentId, uploadId, fileName, content, expectedSize, uploadId));
                completed = true;
                return response;
            } catch (IncompleteUploadException exception) {
                throw new GroupException(HttpStatus.BAD_REQUEST, ApiErrorCode.INVALID_REQUEST,
                        "文件内容未完整接收或与声明大小不符");
            } catch (IOException exception) {
                log.error("群聊文件存储失败", exception);
                throw new GroupException(HttpStatus.INTERNAL_SERVER_ERROR, ApiErrorCode.CHAT_FILE_STORAGE_FAILED,
                        "服务器文件存储暂时不可用");
            } finally {
                boolean temporaryRemoved = deleteQuietly(temporaryFile);
                if (!completed) {
                    boolean storedRemoved = deleteQuietly(storedFile);
                    if (temporaryRemoved && storedRemoved) {
                        try {
                            quotaService.release(uploadId);
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

    public ChatFileMetadata findMetadata(UUID groupId, UUID attachmentId) {
        groupService.requireGroup(groupId);
        ChatFileMetadata metadata = mapper.findFileMetadata(groupId, attachmentId);
        if (metadata == null) {
            throw new GroupException(HttpStatus.NOT_FOUND, ApiErrorCode.CHAT_ATTACHMENT_NOT_FOUND, "消息文件不存在");
        }
        return metadata;
    }

    public ChatMessageResponse findCompletedUpload(UUID groupId, UUID uploadId, AuthenticatedUser user) {
        groupService.requireGroup(groupId);
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
                                                            long byteSize, UUID reservationId) {
        Long sequenceNumber = mapper.allocateMessageSequence(groupId);
        if (sequenceNumber == null) {
            throw new GroupException(HttpStatus.NOT_FOUND, ApiErrorCode.GROUP_NOT_FOUND, "群组不存在");
        }
        Instant createdAt = Instant.now(systemClock);
        UUID messageId = UUID.randomUUID();
        String normalizedContent = normalizeContent(decodeHeaderText(content));
        mapper.insertMessage(new ChatMessage(messageId, groupId, user.id(), ChatMessageType.FILE, normalizedContent,
                createdAt, sequenceNumber));
        mapper.insertFileAttachment(new ChatFileAttachment(attachmentId, messageId, uploadId, fileName, byteSize));
        quotaService.complete(reservationId, byteSize);
        ChatAttachmentResponse attachment = new ChatAttachmentResponse(attachmentId,
                "application/octet-stream", null, null, byteSize, fileName);
        return new ChatMessageResponse(messageId, user.id(), user.nickname(), ChatMessageType.FILE,
                normalizedContent, createdAt, attachment);
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
                if (total > expectedSize || total > properties.getMaxFileSize()) {
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
                message.attachmentByteSize(), message.attachmentFileName());
        return new ChatMessageResponse(message.id(), message.senderUserId(), message.senderNickname(), message.type(),
                message.content(), message.createdAt(), attachment);
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
