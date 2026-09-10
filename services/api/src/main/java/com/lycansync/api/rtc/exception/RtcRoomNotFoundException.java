package com.lycansync.api.rtc.exception;

/**
 * 请求的业务房间不存在。
 *
 * @author Wreckloud
 * @since 2026-09-10
 */
public class RtcRoomNotFoundException extends RuntimeException {

    public RtcRoomNotFoundException() {
        super("房间不存在");
    }
}
