package com.lycansync.api.rtc.service;

import java.util.UUID;

/**
 * 持久化群组与 LiveKit Room 的命名规则。
 *
 * @author Wreckloud
 * @since 2026-09-04
 */
final class GroupRtcRooms {

    private static final String ROOM_PREFIX = "lycan-sync-group-";

    private GroupRtcRooms() {
    }

    static String roomName(UUID groupId) {
        return ROOM_PREFIX + groupId;
    }
}
