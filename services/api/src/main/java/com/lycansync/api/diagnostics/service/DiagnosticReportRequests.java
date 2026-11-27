package com.lycansync.api.diagnostics.service;

import com.lycansync.api.auth.mapper.AuthMapper;
import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.auth.service.OwnerSettingsService;
import com.lycansync.api.common.error.ApiErrorCode;
import com.lycansync.api.group.exception.GroupException;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/**
 * 服主按成员请求一次当前诊断，短期内由该成员的一台客户端领取。
 *
 * @author Wreckloud
 * @since 2026-11-27
 */
@Service
@RequiredArgsConstructor
public class DiagnosticReportRequests {
    private final OwnerSettingsService owners;
    private final AuthMapper users;
    private final Clock clock;
    private final Map<UUID, Request> requests = new HashMap<>();

    private record Request(Instant expiresAt, boolean claimed) {}

    public void request(AuthenticatedUser owner, UUID memberId) {
        owners.requireOwner(owner);
        var member = users.findUserProfile(memberId);
        if (member == null || member.deletedAt() != null) throw new GroupException(HttpStatus.NOT_FOUND,
                ApiErrorCode.INVALID_REQUEST, "成员不存在。");
        synchronized (requests) {
            Instant now = clock.instant();
            requests.values().removeIf(request -> !request.expiresAt().isAfter(now));
            if (requests.containsKey(memberId)) throw new GroupException(HttpStatus.TOO_MANY_REQUESTS,
                    ApiErrorCode.INVALID_REQUEST, "刚刚已请求这位成员的日志，请稍后再试。");
            requests.put(memberId, new Request(now.plusSeconds(120), false));
        }
    }

    public boolean claim(UUID memberId) {
        synchronized (requests) {
            Request request = requests.get(memberId);
            if (request == null || request.claimed() || !request.expiresAt().isAfter(clock.instant())) return false;
            // 保留到期时间，多设备心跳及服主重复点击都不会触发第二次上传。
            requests.put(memberId, new Request(request.expiresAt(), true));
            return true;
        }
    }
}
