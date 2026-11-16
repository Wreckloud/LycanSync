package com.lycansync.api.group.model;

import java.util.UUID;

/**
 * 当前成员可访问的群组与私密语音房间键，仅供服务内部查询。
 *
 * @author Wreckloud
 * @since 2026-11-16
 */
public record GroupRtcRoom(UUID id, UUID roomKey) {
}
