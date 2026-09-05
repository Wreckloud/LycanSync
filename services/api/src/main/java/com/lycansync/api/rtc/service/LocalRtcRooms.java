package com.lycansync.api.rtc.service;

/**
 * 本地调试群组与 LiveKit Room 的命名规则。
 *
 * @author Wreckloud
 * @since 2026-09-04
 */
final class LocalRtcRooms {

    // TODO: 群组落库后使用持久化群组 ID 映射房间，移除本地测试命名规则。
    private static final String ROOM_PREFIX = "lycan-sync-dev-";

    private LocalRtcRooms() {
    }

    static String roomName(String groupId) {
        return ROOM_PREFIX + groupId;
    }
}
