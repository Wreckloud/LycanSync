package com.lycansync.api.chat.dto;

import io.swagger.v3.oas.annotations.media.Schema;
import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.UUID;

/**
 * 群聊图片或普通文件的元数据，不内联二进制内容。
 *
 * @author Wreckloud
 * @since 2026-09-14
 */
@Schema(description = "消息图片或文件附件元数据")
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ChatAttachmentResponse(
        @Schema(description = "附件 ID") UUID id,
        @Schema(description = "图片实际 MIME 类型；普通文件统一使用 application/octet-stream", example = "image/jpeg") String contentType,
        @Schema(description = "图片宽度") Integer width,
        @Schema(description = "图片高度") Integer height,
        @Schema(description = "附件字节大小", example = "3145728") Long byteSize,
        @Schema(description = "普通文件原始文件名") String fileName) {
}
