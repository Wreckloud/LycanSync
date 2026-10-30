package com.lycansync.api.audio.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

import java.nio.file.Path;

/**
 * 入场音效解码工具与短期处理目录。
 *
 * @author Wreckloud
 * @since 2026-10-30
 */
@Component
@ConfigurationProperties(prefix = "lycansync.audio")
public class AudioProcessingProperties {

    private String ffmpegExecutable = "ffmpeg";
    private Path processingDirectory = Path.of("./var/audio-processing");

    public String getFfmpegExecutable() {
        return ffmpegExecutable;
    }

    public void setFfmpegExecutable(String ffmpegExecutable) {
        this.ffmpegExecutable = ffmpegExecutable;
    }

    public Path getProcessingDirectory() {
        return processingDirectory;
    }

    public void setProcessingDirectory(Path processingDirectory) {
        this.processingDirectory = processingDirectory;
    }
}
