package com.lycansync.api.chat.service;

import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.chat.dto.ChatAttachmentResponse;
import com.lycansync.api.chat.dto.ChatMessagePageResponse;
import com.lycansync.api.chat.dto.ChatMessageResponse;
import com.lycansync.api.chat.event.ChatMessageCreatedEvent;
import com.lycansync.api.chat.mapper.ChatMapper;
import com.lycansync.api.chat.model.ChatAttachment;
import com.lycansync.api.chat.model.ChatAttachmentContent;
import com.lycansync.api.chat.model.ChatMessage;
import com.lycansync.api.chat.model.ChatMessageType;
import com.lycansync.api.chat.model.ChatMessageView;
import com.lycansync.api.common.error.ApiErrorCode;
import com.lycansync.api.group.exception.GroupException;
import com.lycansync.api.group.service.GroupService;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;

import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * 群聊文本与单张图片的发送、查询业务。
 *
 * @author Wreckloud
 * @since 2026-09-14
 */
@Service
public class ChatService {

    private static final int PAGE_SIZE = 30;
    private final ChatMapper mapper;
    private final GroupService groupService;
    private final ChatUploadSettingsService settings;
    private final ChatFileMediaService media;
    private final Clock systemClock;
    private final ApplicationEventPublisher events;

    public ChatService(ChatMapper mapper, GroupService groupService, Clock systemClock, ApplicationEventPublisher events,
                       ChatUploadSettingsService settings, ChatFileMediaService media) {
        this.mapper = mapper;
        this.groupService = groupService;
        this.systemClock = systemClock;
        this.events = events;
        this.settings = settings;
        this.media = media;
    }

    public ChatMessagePageResponse findMessages(
            UUID groupId, AuthenticatedUser user, UUID beforeMessageId, UUID afterMessageId
    ) {
        groupService.requireMember(groupId, user);
        if (beforeMessageId != null && afterMessageId != null) throw invalid("不能同时使用前后消息游标");
        if ((beforeMessageId != null && !mapper.messageExists(groupId, beforeMessageId))
                || (afterMessageId != null && !mapper.messageExists(groupId, afterMessageId))) {
            throw invalid("消息游标无效");
        }
        List<ChatMessageView> messages = mapper.findMessages(groupId, beforeMessageId, afterMessageId, PAGE_SIZE + 1);
        boolean hasMore = afterMessageId == null && messages.size() > PAGE_SIZE;
        if (hasMore) messages = messages.subList(1, messages.size());
        return new ChatMessagePageResponse(messages.stream().map(this::toResponse).toList(), hasMore);
    }

    @Transactional
    public ChatMessageResponse sendMessage(UUID groupId, AuthenticatedUser user, String content, MultipartFile image,
                                           UUID requestedId) {
        groupService.requireMember(groupId, user);
        String text = normalizeContent(content);
        ChatImageValidator.ValidatedImage validatedImage = null;
        if (image != null) {
            try {
                validatedImage = ChatImageValidator.validate(image);
            } catch (ChatImageValidator.InvalidImageException exception) {
                throw invalid(exception.getMessage());
            }
        }
        if (text.isEmpty() && validatedImage == null) throw invalid("请输入消息内容或选择一张图片");

        if (requestedId != null) {
            if (mapper.lockGroupForMessageSend(groupId) == null) {
                throw new GroupException(HttpStatus.NOT_FOUND, ApiErrorCode.GROUP_NOT_FOUND, "群组不存在");
            }
            ChatMessageView existing = mapper.findSubmittedMessage(groupId, requestedId, user.id());
            if (existing != null) {
                // 重试虽不写入新消息，也不能绕过锁后的成员资格检查。
                groupService.requireMember(groupId, user);
                if ((image == null) != (existing.type() == ChatMessageType.TEXT) || !text.equals(existing.content())) {
                    throw invalid("消息 ID 已被占用");
                }
                return toResponse(existing);
            }
            if (mapper.messageIdExists(requestedId)) throw invalid("消息 ID 已被占用");
        }

        if (validatedImage != null) settings.checkFileSize(validatedImage.data().length);
        Long sequenceNumber = mapper.allocateMessageSequence(groupId);
        if (sequenceNumber == null) throw new GroupException(HttpStatus.NOT_FOUND, ApiErrorCode.GROUP_NOT_FOUND, "群组不存在");
        // 分配序号已锁定群组行，重新确认资格，避免退群与发送交错后仍写入。
        groupService.requireMember(groupId, user);
        Instant now = Instant.now(systemClock);
        UUID messageId = requestedId == null ? UUID.randomUUID() : requestedId;
        mapper.insertMessage(new ChatMessage(messageId, groupId, user.id(),
                validatedImage == null ? ChatMessageType.TEXT : ChatMessageType.IMAGE, text, now, sequenceNumber));

        ChatAttachmentResponse attachment = null;
        if (validatedImage != null) {
            UUID attachmentId = UUID.randomUUID();
            mapper.insertAttachment(new ChatAttachment(attachmentId, messageId, validatedImage.contentType(),
                    validatedImage.width(), validatedImage.height(), validatedImage.data().length, validatedImage.data()));
            attachment = new ChatAttachmentResponse(attachmentId, validatedImage.contentType(),
                    validatedImage.width(), validatedImage.height(), (long) validatedImage.data().length, null);
        }
        events.publishEvent(new ChatMessageCreatedEvent(groupId));
        return new ChatMessageResponse(messageId, user.id(), user.nickname(),
                validatedImage == null ? ChatMessageType.TEXT : ChatMessageType.IMAGE, text, now, attachment);
    }

    public ChatAttachmentContent findAttachment(UUID groupId, UUID attachmentId, AuthenticatedUser user) {
        groupService.requireMember(groupId, user);
        return requireAttachment(groupId, attachmentId);
    }

    public byte[] findAttachmentThumbnail(UUID groupId, UUID attachmentId, AuthenticatedUser user) {
        groupService.requireMember(groupId, user);
        return media.attachmentThumbnail(groupId, attachmentId, () -> requireAttachment(groupId, attachmentId).data());
    }

    private ChatAttachmentContent requireAttachment(UUID groupId, UUID attachmentId) {
        ChatAttachmentContent attachment = mapper.findAttachment(groupId, attachmentId);
        if (attachment == null) {
            throw new GroupException(HttpStatus.NOT_FOUND, ApiErrorCode.CHAT_ATTACHMENT_NOT_FOUND, "消息图片不存在");
        }
        return attachment;
    }

    private String normalizeContent(String content) {
        if (content == null) return "";
        if (content.codePointCount(0, content.length()) > 2000) throw invalid("消息不能超过 2000 个字符");
        if (content.codePoints().anyMatch(codePoint -> Character.isISOControl(codePoint)
                && codePoint != '\n' && codePoint != '\r' && codePoint != '\t')) {
            throw invalid("消息不能包含控制字符");
        }
        return content.isBlank() ? "" : content;
    }

    private ChatMessageResponse toResponse(ChatMessageView message) {
        ChatAttachmentResponse attachment = message.attachmentId() == null ? null : new ChatAttachmentResponse(
                message.attachmentId(), message.attachmentContentType(), message.attachmentWidth(),
                message.attachmentHeight(), message.attachmentByteSize(), message.attachmentFileName(), message.transferStatus());
        return new ChatMessageResponse(message.id(), message.senderUserId(), message.senderNickname(), message.type(),
                message.content(), message.createdAt(), attachment, message.senderAvatar(), message.senderDeletedAt());
    }

    private GroupException invalid(String message) {
        return new GroupException(HttpStatus.BAD_REQUEST, ApiErrorCode.INVALID_REQUEST, message);
    }
}
