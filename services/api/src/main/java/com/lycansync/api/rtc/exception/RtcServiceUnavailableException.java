package com.lycansync.api.rtc.exception;

/**
 * RTC 服务端接口暂时不可用异常。
 *
 * @author Wreckloud
 * @since 2026-09-04
 */
public class RtcServiceUnavailableException extends RuntimeException {

    public RtcServiceUnavailableException(String message) {
        super(message);
    }

    public RtcServiceUnavailableException(String message, Throwable cause) {
        super(message, cause);
    }
}
