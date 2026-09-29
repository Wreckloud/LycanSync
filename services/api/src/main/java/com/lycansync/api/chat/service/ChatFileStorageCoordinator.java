package com.lycansync.api.chat.service;

import org.springframework.stereotype.Component;

import java.util.UUID;
import java.util.concurrent.locks.Lock;
import java.util.concurrent.locks.ReentrantReadWriteLock;

/**
 * 协调群聊文件上传与启动恢复，并标记当前进程创建的额度预留。
 *
 * @author Wreckloud
 * @since 2026-09-29
 */
@Component
public class ChatFileStorageCoordinator {

    private final UUID processInstanceId = UUID.randomUUID();
    private final ReentrantReadWriteLock lock = new ReentrantReadWriteLock(true);

    public UUID processInstanceId() {
        return processInstanceId;
    }

    public Lock uploadLock() {
        return lock.readLock();
    }

    public Lock cleanupLock() {
        return lock.writeLock();
    }
}
