package com.lycansync.api.audio.service;

import com.lycansync.api.audio.config.AudioProcessingProperties;
import com.lycansync.api.audio.exception.AudioProcessingException;

import java.io.ByteArrayInputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * 在含 FFmpeg 的隔离容器中验证合成音频，不采集或播放设备声音。
 *
 * @author Wreckloud
 * @since 2026-10-30
 */
public final class EntranceSoundFixture {

    private EntranceSoundFixture() {
    }

    public static void main(String[] arguments) throws Exception {
        Path root = Path.of(arguments[0]);
        Files.createDirectories(root);
        AudioProcessingProperties properties = new AudioProcessingProperties();
        properties.setProcessingDirectory(root.resolve("processing"));
        EntranceSoundService service = new EntranceSoundService(properties);
        int checks = 0;
        for (String format : List.of("wav", "mp3", "ogg", "webm")) {
            for (double volume : List.of(0.1, 1.0, 6.0)) {
                Path input = root.resolve("sample." + format);
                List<String> command = new ArrayList<>(List.of("ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
                        "sine=frequency=440:sample_rate=48000:duration=1", "-af", "volume=" + volume));
                if (format.equals("webm")) command.addAll(List.of("-c:a", "libopus"));
                command.add(input.toString());
                if (new ProcessBuilder(command).inheritIO().start().waitFor() != 0) throw new AssertionError("fixture generation failed");
                byte[] result = service.normalize(new ByteArrayInputStream(Files.readAllBytes(input)));
                ByteBuffer wave = ByteBuffer.wrap(result).order(ByteOrder.LITTLE_ENDIAN);
                double square = 0;
                int samples = (result.length - 44) / 2;
                int peak = 0;
                for (int index = 0; index < samples; index++) {
                    int sample = wave.getShort(44 + index * 2);
                    square += (double) sample * sample;
                    peak = Math.max(peak, Math.abs(sample));
                }
                double rms = Math.sqrt(square / samples);
                if (peak > 16423 || samples > 240000 || samples < 47000 || rms < 500 || rms > 2330) {
                    throw new AssertionError("normalized bounds failed: " + format + ", rms=" + rms + ", peak=" + peak);
                }
                checks++;
            }
        }
        for (int seconds : List.of(5, 6)) {
            Path input = root.resolve("duration.wav");
            if (new ProcessBuilder("ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
                    "sine=frequency=440:sample_rate=8000:duration=" + seconds, input.toString()).inheritIO().start().waitFor() != 0) {
                throw new AssertionError("duration fixture failed");
            }
            try {
                byte[] result = service.normalize(new ByteArrayInputStream(Files.readAllBytes(input)));
                if (seconds == 6 || result.length != 480044) throw new AssertionError("duration acceptance failed");
            } catch (AudioProcessingException exception) {
                if (seconds != 6 || !exception.getMessage().contains("5 秒")) throw exception;
            }
            checks++;
        }
        try (var temporary = Files.list(properties.getProcessingDirectory())) {
            if (temporary.findAny().isPresent()) throw new AssertionError("temporary audio remains");
        }
        System.out.println("Audio integration checks passed: " + checks + "; no device, network or playback used.");
    }
}
