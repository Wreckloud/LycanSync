package com.lycansync.api.system.service;

import com.lycansync.api.system.dto.SystemInitializationStatusResponse;
import com.lycansync.api.system.exception.SystemStateNotFoundException;
import com.lycansync.api.system.mapper.SystemStateMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

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

    public SystemInitializationStatusResponse getInitializationStatus() {
        // 状态行由迁移创建，缺行属于数据异常，不能当作尚未初始化。
        boolean initialized = systemStateMapper.findInitialized()
                .orElseThrow(SystemStateNotFoundException::new);
        return new SystemInitializationStatusResponse(initialized);
    }
}
