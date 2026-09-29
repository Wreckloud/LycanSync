package com.lycansync.api.chat.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

import java.nio.file.Path;

/**
 * 群聊文件上传与本地存储限制。
 *
 * @author Wreckloud
 * @since 2026-09-29
 */
@Component
@ConfigurationProperties(prefix = "lycansync.chat.files")
public class ChatFileProperties {

    private Path storageDirectory = Path.of("./var/chat-files");
    private long maxFileSize = 104_857_600L;
    private long maxStorageSize = 10_737_418_240L;

    public Path getStorageDirectory() {
        return storageDirectory;
    }

    public void setStorageDirectory(Path storageDirectory) {
        this.storageDirectory = storageDirectory;
    }

    public long getMaxFileSize() {
        return maxFileSize;
    }

    public void setMaxFileSize(long maxFileSize) {
        this.maxFileSize = maxFileSize;
    }

    public long getMaxStorageSize() {
        return maxStorageSize;
    }

    public void setMaxStorageSize(long maxStorageSize) {
        this.maxStorageSize = maxStorageSize;
    }
}
