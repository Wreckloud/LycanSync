package com.lycansync.api.chat.mapper;

import com.lycansync.api.chat.model.ChatAttachment;
import com.lycansync.api.chat.model.ChatAttachmentContent;
import com.lycansync.api.chat.model.ChatFileAttachment;
import com.lycansync.api.chat.model.ChatFileMetadata;
import com.lycansync.api.chat.model.ChatFileUploadReservation;
import com.lycansync.api.chat.model.ChatMessage;
import com.lycansync.api.chat.model.ChatMessageView;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * 群聊消息、图片与普通文件附件及存储额度的数据访问。
 *
 * @author Wreckloud
 * @since 2026-09-14
 */
@Mapper
public interface ChatMapper {
    Long lockGroupForImageSend(@Param("groupId") UUID groupId);
    Long allocateMessageSequence(@Param("groupId") UUID groupId);
    int insertMessage(@Param("message") ChatMessage message);
    int insertAttachment(@Param("attachment") ChatAttachment attachment);
    boolean messageExists(@Param("groupId") UUID groupId, @Param("messageId") UUID messageId);
    boolean messageIdExists(@Param("messageId") UUID messageId);
    ChatMessageView findImageMessage(@Param("groupId") UUID groupId, @Param("messageId") UUID messageId,
                                     @Param("senderUserId") UUID senderUserId);
    List<ChatMessageView> findMessages(@Param("groupId") UUID groupId, @Param("beforeMessageId") UUID beforeMessageId,
                                       @Param("afterMessageId") UUID afterMessageId, @Param("limit") int limit);
    ChatAttachmentContent findAttachment(@Param("groupId") UUID groupId, @Param("attachmentId") UUID attachmentId);

    ChatFileMetadata findFileMetadata(@Param("groupId") UUID groupId, @Param("attachmentId") UUID attachmentId);

    ChatMessageView findFileMessage(@Param("groupId") UUID groupId, @Param("uploadId") UUID uploadId,
                                    @Param("senderUserId") UUID senderUserId);

    int insertFileAttachment(@Param("attachment") ChatFileAttachment attachment);

    int reserveFileStorage(@Param("uploadId") UUID uploadId, @Param("groupId") UUID groupId,
                           @Param("byteSize") long byteSize, @Param("maxStorageSize") long maxStorageSize,
                           @Param("createdAt") Instant createdAt,
                           @Param("processInstanceId") UUID processInstanceId);

    int completeFileStorageReservation(@Param("uploadId") UUID uploadId, @Param("byteSize") long byteSize);

    int releaseFileStorageReservation(@Param("uploadId") UUID uploadId);

    List<ChatFileUploadReservation> findFileStorageReservations();

    boolean fileAttachmentExists(@Param("attachmentId") UUID attachmentId);
}
