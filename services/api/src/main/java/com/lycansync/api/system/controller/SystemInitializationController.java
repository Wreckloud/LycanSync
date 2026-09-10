package com.lycansync.api.system.controller;

import com.lycansync.api.system.dto.SystemInitializationStatusResponse;
import com.lycansync.api.system.service.SystemInitializationService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.responses.ApiResponses;
import io.swagger.v3.oas.annotations.security.SecurityRequirements;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 系统初始化接口。
 *
 * @author Wreckloud
 * @since 2026-09-02
 */
@RestController
@RequiredArgsConstructor
@RequestMapping("/api/system")
@Tag(name = "系统接口", description = "客户端启动信息接口")
public class SystemInitializationController {

    private final SystemInitializationService systemInitializationService;

    @GetMapping("/initialization")
    @Operation(summary = "获取系统初始化信息")
    @SecurityRequirements
    @ApiResponses({
            @ApiResponse(responseCode = "200", description = "获取成功"),
            @ApiResponse(responseCode = "500", description = "系统状态记录异常"),
            @ApiResponse(responseCode = "503", description = "数据库暂时不可用")
    })
    public ResponseEntity<SystemInitializationStatusResponse> getInitializationStatus() {
        // 初始化完成后必须读取新状态，不能复用缓存的未初始化结果。
        return ResponseEntity.ok()
                .cacheControl(CacheControl.noStore())
                .body(systemInitializationService.getInitializationStatus());
    }
}
