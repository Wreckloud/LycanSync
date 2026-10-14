package com.lycansync.api.group.event;

import java.util.UUID;

/**
 * 群组资料或成员事务提交后的刷新通知。
 * @author Wreckloud
 * @since 2026-10-12
 */
public record GroupChangedEvent(UUID groupId, boolean deleted) { }
