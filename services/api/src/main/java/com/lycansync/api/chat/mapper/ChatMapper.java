package com.lycansync.api.chat.mapper;

import com.lycansync.api.chat.model.ChatAttachment;
import com.lycansync.api.chat.model.ChatAttachmentContent;
import com.lycansync.api.chat.model.ChatMessage;
import com.lycansync.api.chat.model.ChatMessageView;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.util.List;
import java.util.UUID;

/**
 * 群聊消息与图片附件的数据访问。
 *
 * @author Wreckloud
 * @since 2026-09-14
 */
@Mapper
public interface ChatMapper {
    int insertMessage(@Param("message") ChatMessage message);
    int insertAttachment(@Param("attachment") ChatAttachment attachment);
    boolean messageExists(@Param("groupId") UUID groupId, @Param("messageId") UUID messageId);
    List<ChatMessageView> findMessages(@Param("groupId") UUID groupId, @Param("beforeMessageId") UUID beforeMessageId,
                                       @Param("afterMessageId") UUID afterMessageId, @Param("limit") int limit);
    ChatAttachmentContent findAttachment(@Param("groupId") UUID groupId, @Param("attachmentId") UUID attachmentId);
}
