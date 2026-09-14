package com.lycansync.api.chat.service;

import org.springframework.web.multipart.MultipartFile;

import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.util.Iterator;

/**
 * 校验用于群聊的 PNG/JPEG 图片与其实际二进制格式。
 *
 * @author Wreckloud
 * @since 2026-09-14
 */
final class ChatImageValidator {

    static final int MAX_BYTES = 5 * 1024 * 1024;
    private static final long MAX_PIXELS = 8_294_400L;

    private ChatImageValidator() {
    }

    static ValidatedImage validate(MultipartFile image) {
        if (image.isEmpty()) throw new InvalidImageException("图片文件不能为空");
        if (image.getSize() > MAX_BYTES) throw new InvalidImageException("图片不能超过 5 MB");
        String contentType = image.getContentType();
        if (!"image/png".equals(contentType) && !"image/jpeg".equals(contentType)) {
            throw new InvalidImageException("图片仅支持 PNG 或 JPEG");
        }
        byte[] data;
        try {
            data = image.getBytes();
        } catch (IOException exception) {
            throw new InvalidImageException("图片读取失败");
        }
        try (var input = ImageIO.createImageInputStream(new ByteArrayInputStream(data))) {
            Iterator<ImageReader> readers = ImageIO.getImageReaders(input);
            if (!readers.hasNext()) throw new InvalidImageException("图片文件无效");
            ImageReader reader = readers.next();
            try {
                reader.setInput(input);
                boolean expected = "image/png".equals(contentType) ? reader.getFormatName().equalsIgnoreCase("png")
                        : reader.getFormatName().equalsIgnoreCase("jpeg");
                if (!expected) throw new InvalidImageException("图片文件格式与声明不一致");
                int width = reader.getWidth(0);
                int height = reader.getHeight(0);
                if (width <= 0 || height <= 0 || (long) width * height > MAX_PIXELS) {
                    throw new InvalidImageException("图片尺寸不能超过 829 万像素");
                }
                if (reader.read(0) == null) throw new InvalidImageException("图片文件无效");
                return new ValidatedImage(contentType, width, height, data);
            } finally {
                reader.dispose();
            }
        } catch (IOException | IllegalArgumentException exception) {
            throw new InvalidImageException("图片文件无效");
        }
    }

    record ValidatedImage(String contentType, int width, int height, byte[] data) {
    }

    static final class InvalidImageException extends RuntimeException {
        InvalidImageException(String message) {
            super(message);
        }
    }
}
