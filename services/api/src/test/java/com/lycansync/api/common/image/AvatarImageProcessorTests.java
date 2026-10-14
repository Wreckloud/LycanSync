package com.lycansync.api.common.image;

import org.junit.jupiter.api.Test;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.Base64;
import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 头像统一编码、透明度与裁剪载荷边界测试。
 *
 * @author Wreckloud
 * @since 2026-10-11
 */
class AvatarImageProcessorTests {

    @Test
    void shouldResizeAndPreserveTransparentPixels() throws IOException {
        BufferedImage source = new BufferedImage(512, 512, BufferedImage.TYPE_INT_ARGB);
        for (int y = 256; y < 512; y++) {
            for (int x = 256; x < 512; x++) source.setRGB(x, y, 0x80ff0000);
        }
        String normalized = AvatarImageProcessor.normalize(dataUrl(source, "png"));
        BufferedImage stored = ImageIO.read(new ByteArrayInputStream(bytes(normalized)));

        assertThat(normalized).startsWith("data:image/png;base64,");
        assertThat(stored.getWidth()).isEqualTo(256);
        assertThat(stored.getHeight()).isEqualTo(256);
        assertThat(stored.getRGB(32, 32) >>> 24).isZero();
        assertThat(stored.getRGB(200, 200)).isEqualTo(0x80ff0000);
        assertThat(AvatarImageProcessor.normalize(normalized)).isEqualTo(normalized);
    }

    @Test
    void shouldConvertJpegToPng() throws IOException {
        BufferedImage source = new BufferedImage(512, 512, BufferedImage.TYPE_INT_RGB);
        String normalized = AvatarImageProcessor.normalize(dataUrl(source, "jpeg"));
        BufferedImage stored = ImageIO.read(new ByteArrayInputStream(bytes(normalized)));

        assertThat(normalized).startsWith("data:image/png;base64,");
        assertThat(stored.getWidth()).isEqualTo(256);
        assertThat(stored.getRGB(0, 0) >>> 24).isEqualTo(255);
    }

    @Test
    void shouldPreserveCompliantPngWithoutReencoding() throws IOException {
        String original = dataUrl(new BufferedImage(256, 256, BufferedImage.TYPE_INT_ARGB), "png");
        assertThat(AvatarImageProcessor.normalize(original)).isEqualTo(original);
    }

    @Test
    void shouldAcceptComplexCropAboveOldLimitWithoutDroppingResolution() throws IOException {
        BufferedImage source = new BufferedImage(512, 512, BufferedImage.TYPE_INT_ARGB);
        Random random = new Random(11);
        for (int y = 0; y < 512; y++) {
            for (int x = 0; x < 512; x++) source.setRGB(x, y, random.nextInt());
        }
        String original = dataUrl(source, "png");
        assertThat(bytes(original).length).isGreaterThan(96 * 1024);
        String normalized = AvatarImageProcessor.normalize(original);
        BufferedImage stored = ImageIO.read(new ByteArrayInputStream(bytes(normalized)));

        assertThat(stored.getWidth()).isEqualTo(256);
        assertThat(bytes(normalized).length).isLessThan(270 * 1024).isLessThan(bytes(original).length);
    }

    @Test
    void shouldCenterCropNonSquareLegacyImage() throws IOException {
        BufferedImage source = new BufferedImage(400, 300, BufferedImage.TYPE_INT_RGB);
        for (int y = 0; y < 300; y++) {
            for (int x = 50; x < 350; x++) source.setRGB(x, y, 0x00ff0000);
        }
        BufferedImage stored = ImageIO.read(new ByteArrayInputStream(bytes(
                AvatarImageProcessor.normalize(dataUrl(source, "png")))));

        assertThat(stored.getRGB(0, 0)).isEqualTo(0xffff0000);
        assertThat(stored.getRGB(255, 255)).isEqualTo(0xffff0000);
    }

    @Test
    void shouldRejectUnsupportedAndInvalidBase64Payloads() {
        assertThatThrownBy(() -> AvatarImageProcessor.normalize("data:image/gif;base64,YWJj"))
                .isInstanceOf(AvatarImageProcessor.InvalidAvatarException.class).hasMessage("头像仅支持 PNG 或 JPEG");
        assertThatThrownBy(() -> AvatarImageProcessor.normalize("data:image/png;base64,%%%"))
                .isInstanceOf(AvatarImageProcessor.InvalidAvatarException.class).hasMessage("头像文件无效");
    }

    private String dataUrl(BufferedImage image, String format) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        ImageIO.write(image, format, output);
        return "data:image/" + format + ";base64," + Base64.getEncoder().encodeToString(output.toByteArray());
    }

    private byte[] bytes(String avatar) {
        return Base64.getDecoder().decode(avatar.substring(avatar.indexOf(',') + 1));
    }
}
