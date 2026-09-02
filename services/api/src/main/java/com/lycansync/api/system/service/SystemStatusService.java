package com.lycansync.api.system.service;

import com.lycansync.api.system.dto.SystemStatusResponse;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Instant;

/**
 * 系统状态服务。
 *
 * @author Wreckloud
 * @since 2026-09-01
 */
@Service
public class SystemStatusService {

    private static final String API_VERSION = "v1";

    private final Clock systemClock;

    public SystemStatusService(Clock systemClock) {
        this.systemClock = systemClock;
    }

    public SystemStatusResponse getSystemStatus() {
        return new SystemStatusResponse(
                API_VERSION,
                Instant.now(systemClock)
        );
    }
}
