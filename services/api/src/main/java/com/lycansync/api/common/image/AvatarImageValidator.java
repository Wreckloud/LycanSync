package com.lycansync.api.common.image;

import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.util.Base64;
import java.util.Iterator;

/**
 * 校验客户端裁剪后的 PNG/JPEG 头像。
 *
 * @author Wreckloud
 * @since 2026-09-13
 */
public final class AvatarImageValidator {

    private AvatarImageValidator() {
    }

    public static void validate(String avatar) {
        String prefix = avatar.startsWith("data:image/png;base64,") ? "data:image/png;base64,"
                : avatar.startsWith("data:image/jpeg;base64,") ? "data:image/jpeg;base64," : null;
        if (prefix == null) throw new InvalidAvatarException("头像仅支持 PNG 或 JPEG");

        byte[] bytes;
        try {
            bytes = Base64.getDecoder().decode(avatar.substring(prefix.length()));
        } catch (IllegalArgumentException exception) {
            throw new InvalidAvatarException("头像文件无效");
        }
        if (bytes.length > 98304) throw new InvalidAvatarException("头像不能超过 96 KB");

        try (var input = ImageIO.createImageInputStream(new ByteArrayInputStream(bytes))) {
            Iterator<ImageReader> readers = ImageIO.getImageReaders(input);
            if (!readers.hasNext()) throw new InvalidAvatarException("头像文件无效");
            ImageReader reader = readers.next();
            try {
                reader.setInput(input);
                String format = reader.getFormatName();
                if (!(prefix.contains("image/png") ? format.equalsIgnoreCase("png")
                        : format.equalsIgnoreCase("jpeg"))) {
                    throw new InvalidAvatarException("头像文件格式与声明不一致");
                }
                if (reader.getWidth(0) <= 0 || reader.getHeight(0) <= 0
                        || reader.getWidth(0) > 256 || reader.getHeight(0) > 256) {
                    throw new InvalidAvatarException("头像尺寸不能超过 256 × 256");
                }
                if (reader.read(0) == null) throw new InvalidAvatarException("头像文件无效");
            } finally {
                reader.dispose();
            }
        } catch (IOException | IllegalArgumentException exception) {
            throw new InvalidAvatarException("头像文件无效");
        }
    }

    public static final class InvalidAvatarException extends RuntimeException {
        public InvalidAvatarException(String message) {
            super(message);
        }
    }
}
