package com.lycansync.api.audio.service;

import com.lycansync.api.audio.config.AudioProcessingProperties;
import com.lycansync.api.audio.exception.AudioProcessingException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 入场音效能量、峰值、输入限制与失败清理回归。
 *
 * @author Wreckloud
 * @since 2026-10-30
 */
class EntranceSoundServiceTests {

    @TempDir Path directory;

    @Test
    void shouldBalanceEnergyWithoutClippingAndKeepCanonicalWav() {
        for (int amplitude : new int[]{100, 1000, 10000, 32767}) {
            ByteBuffer pcm = ByteBuffer.allocate(9600).order(ByteOrder.LITTLE_ENDIAN);
            for (int sample = 0; sample < 4800; sample++) pcm.putShort((short) (sample % 2 == 0 ? amplitude : -amplitude));
            byte[] result = EntranceSoundService.normalizePcm(pcm.array());
            assertThat(new String(result, 0, 4)).isEqualTo("RIFF");
            ByteBuffer wave = ByteBuffer.wrap(result).order(ByteOrder.LITTLE_ENDIAN);
            assertThat(wave.getInt(24)).isEqualTo(48000);
            assertThat(wave.getInt(40)).isEqualTo(9600);
            int output = wave.getShort(44);
            assertThat(output).isLessThanOrEqualTo(16422);
            assertThat(output).isLessThanOrEqualTo(amplitude * 4);
            if (amplitude > 1000) assertThat(output).isBetween(2319, 2321);
        }
        byte[] silence = EntranceSoundService.normalizePcm(new byte[960]);
        assertThat(silence).hasSize(1004);
        assertThat(silence[44]).isZero();
    }

    @Test
    void shouldRejectOversizedOrUnrecognizedUploadBeforeStartingDecoder() {
        EntranceSoundService service = service();
        assertThatThrownBy(() -> service.normalize(new ByteArrayInputStream(new byte[512 * 1024 + 1])))
                .isInstanceOf(AudioProcessingException.class).hasMessageContaining("512 KB");
        assertThatThrownBy(() -> service.normalize(new ByteArrayInputStream("https://example.test/audio".getBytes())))
                .isInstanceOf(AudioProcessingException.class).hasMessageContaining("无法解码");
    }

    @Test
    void shouldReportMissingDecoderAndRemoveItsTemporaryFiles() throws IOException {
        byte[] wave = EntranceSoundService.normalizePcm(new byte[960]);
        assertThatThrownBy(() -> service().normalize(new ByteArrayInputStream(wave)))
                .isInstanceOf(AudioProcessingException.class).hasMessageContaining("暂不可用");
        try (var files = Files.list(directory)) { assertThat(files.toList()).isEmpty(); }
    }

    @Test
    void shouldRejectConcurrentProcessingWithoutAnUnboundedQueue() throws Exception {
        EntranceSoundService service = service();
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        var executor = Executors.newSingleThreadExecutor();
        try {
            var first = executor.submit(() -> {
                try {
                    service.normalize(new ByteArrayInputStream(new byte[1]) {
                        @Override
                        public byte[] readNBytes(int length) {
                            entered.countDown();
                            try { release.await(5, TimeUnit.SECONDS); }
                            catch (InterruptedException exception) { Thread.currentThread().interrupt(); }
                            return new byte[1];
                        }
                    });
                } catch (AudioProcessingException expected) {
                    return;
                }
                throw new AssertionError("invalid audio accepted");
            });
            assertThat(entered.await(2, TimeUnit.SECONDS)).isTrue();
            assertThatThrownBy(() -> service.normalize(new ByteArrayInputStream(new byte[1])))
                    .isInstanceOf(AudioProcessingException.class).hasMessageContaining("另一段音效");
            release.countDown();
            first.get(2, TimeUnit.SECONDS);
        } finally {
            release.countDown();
            executor.shutdownNow();
        }
    }

    private EntranceSoundService service() {
        AudioProcessingProperties properties = new AudioProcessingProperties();
        properties.setProcessingDirectory(directory);
        properties.setFfmpegExecutable(directory.resolve("missing-ffmpeg").toString());
        return new EntranceSoundService(properties);
    }
}
