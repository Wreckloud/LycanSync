package com.lycansync.api.rtc.service;

import java.util.UUID;

/**
 * 私密群组当前凭证范围与 LiveKit Room 的命名规则。
 *
 * @author Wreckloud
 * @since 2026-09-04
 */
final class GroupRtcRooms {

    static final String ROOM_PREFIX = "lycan-sync-group-";

    private GroupRtcRooms() {
    }

    static String roomName(UUID roomKey) {
        return ROOM_PREFIX + roomKey;
    }
}
