package com.lycansync.api.system.controller;

import com.lycansync.api.system.dto.SystemStatusResponse;
import com.lycansync.api.system.service.SystemStatusService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.tags.Tag;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 系统接口。
 *
 * @author Wreckloud
 * @since 2026-09-01
 */
@RestController
@RequestMapping("/api/v1/system")
@Tag(name = "系统接口", description = "客户端启动和服务状态接口")
public class SystemStatusController {

    private final SystemStatusService systemStatusService;

    public SystemStatusController(SystemStatusService systemStatusService) {
        this.systemStatusService = systemStatusService;
    }

    @GetMapping("/status")
    @Operation(summary = "获取系统状态")
    @ApiResponse(responseCode = "200", description = "获取成功")
    public SystemStatusResponse getSystemStatus() {
        return systemStatusService.getSystemStatus();
    }
}
