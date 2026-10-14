package com.lycansync.api.common.image;

import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import java.awt.AlphaComposite;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.util.Base64;
import java.util.Iterator;

/**
 * 将客户端裁剪的 PNG/JPEG 头像统一为保留透明度的 256 像素 PNG。
 *
 * @author Wreckloud
 * @since 2026-10-11
 */
public final class AvatarImageProcessor {

    private static final int MAX_INPUT_BYTES = 2 * 1024 * 1024;
    private static final int MAX_INPUT_EDGE = 1024;
    private static final int OUTPUT_SIZE = 256;
    private static final String PNG_PREFIX = "data:image/png;base64,";
    private static final String JPEG_PREFIX = "data:image/jpeg;base64,";

    private AvatarImageProcessor() {
    }

    public static String normalize(String avatar) {
        String prefix = avatar.startsWith(PNG_PREFIX) ? PNG_PREFIX
                : avatar.startsWith(JPEG_PREFIX) ? JPEG_PREFIX : null;
        if (prefix == null) throw new InvalidAvatarException("头像仅支持 PNG 或 JPEG");
        // 限制的是裁剪后的接口载荷，不是用户在本机选择的原图大小。
        if (avatar.length() - prefix.length() > (MAX_INPUT_BYTES + 2) / 3 * 4) {
            throw new InvalidAvatarException("裁剪后的头像数据过大，请重新裁剪后重试");
        }
        byte[] bytes;
        try {
            bytes = Base64.getDecoder().decode(avatar.substring(prefix.length()));
        } catch (IllegalArgumentException exception) {
            throw new InvalidAvatarException("头像文件无效");
        }
        if (bytes.length > MAX_INPUT_BYTES) {
            throw new InvalidAvatarException("裁剪后的头像数据过大，请重新裁剪后重试");
        }
        BufferedImage image = readImage(bytes, prefix);
        // 已规范的头像原样保存，避免反复编辑后再次编码；仍先完成格式与像素校验。
        if (prefix.equals(PNG_PREFIX) && image.getWidth() == OUTPUT_SIZE && image.getHeight() == OUTPUT_SIZE) {
            return avatar;
        }
        return encodePng(image);
    }

    private static BufferedImage readImage(byte[] bytes, String prefix) {
        try (var input = ImageIO.createImageInputStream(new ByteArrayInputStream(bytes))) {
            Iterator<ImageReader> readers = ImageIO.getImageReaders(input);
            if (!readers.hasNext()) throw new InvalidAvatarException("头像文件无效");
            ImageReader reader = readers.next();
            try {
                reader.setInput(input);
                String format = reader.getFormatName();
                if (!(prefix.equals(PNG_PREFIX) ? format.equalsIgnoreCase("png")
                        : format.equalsIgnoreCase("jpeg"))) {
                    throw new InvalidAvatarException("头像文件格式与声明不一致");
                }
                int width = reader.getWidth(0);
                int height = reader.getHeight(0);
                // 解码前检查尺寸，防止伪造的小文件申请大块像素内存。
                if (width <= 0 || height <= 0 || width > MAX_INPUT_EDGE || height > MAX_INPUT_EDGE) {
                    throw new InvalidAvatarException("裁剪后的头像尺寸过大，请重新裁剪后重试");
                }
                BufferedImage image = reader.read(0);
                if (image == null) throw new InvalidAvatarException("头像文件无效");
                return image;
            } finally {
                reader.dispose();
            }
        } catch (IOException | IllegalArgumentException exception) {
            throw new InvalidAvatarException("头像文件无效");
        }
    }

    private static String encodePng(BufferedImage source) {
        BufferedImage outputImage = new BufferedImage(OUTPUT_SIZE, OUTPUT_SIZE, BufferedImage.TYPE_INT_ARGB);
        Graphics2D graphics = outputImage.createGraphics();
        try {
            graphics.setComposite(AlphaComposite.Src);
            graphics.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BICUBIC);
            int edge = Math.min(source.getWidth(), source.getHeight());
            int left = (source.getWidth() - edge) / 2;
            int top = (source.getHeight() - edge) / 2;
            graphics.drawImage(source, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE, left, top, left + edge, top + edge, null);
        } finally {
            graphics.dispose();
        }
        // 从新像素图编码，不保留原文件元数据；PNG 无损压缩不按字节预算降低头像清晰度。
        try (var output = new ByteArrayOutputStream()) {
            if (!ImageIO.write(outputImage, "png", output)) {
                throw new IllegalStateException("服务器 PNG 编码器不可用");
            }
            return PNG_PREFIX + Base64.getEncoder().encodeToString(output.toByteArray());
        } catch (IOException exception) {
            throw new UncheckedIOException("头像编码失败", exception);
        }
    }

    public static final class InvalidAvatarException extends RuntimeException {
        public InvalidAvatarException(String message) {
            super(message);
        }
    }
}
