package com.lycansync.api.system.service;

import com.lycansync.api.system.dto.SystemInitializationStatusResponse;
import com.lycansync.api.system.exception.SystemStateNotFoundException;
import com.lycansync.api.system.mapper.SystemStateMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Instant;

/**
 * 系统初始化状态服务。
 *
 * @author Wreckloud
 * @since 2026-09-02
 */
@Service
@RequiredArgsConstructor
public class SystemInitializationService {

    private final SystemStateMapper systemStateMapper;
    private final Clock systemClock;

    public SystemInitializationStatusResponse getInitializationStatus() {
        // 1. 查询首次管理员初始化状态；状态行缺失属于异常，不能当成未初始化。
        boolean initialized = systemStateMapper.findInitialized()
                .orElseThrow(SystemStateNotFoundException::new);

        // 2. 返回状态和本次响应时间；查询不创建管理员，也不修改初始化状态。
        return new SystemInitializationStatusResponse(initialized, Instant.now(systemClock));
    }
}
