package com.lycansync.api.rtc.service;

import com.lycansync.api.auth.exception.AuthException;
import org.springframework.http.HttpStatus;

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
        // 群组管理尚未实现，只开放明确存在的调试房间，禁止任意创建 RTC 房间。
        if (!"pack".equals(groupId)) {
            throw new AuthException(
                    HttpStatus.NOT_FOUND, "ROOM_NOT_FOUND", "房间不存在");
        }
        return ROOM_PREFIX + groupId;
    }
}
