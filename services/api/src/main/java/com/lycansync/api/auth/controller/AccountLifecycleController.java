package com.lycansync.api.auth.controller;

import com.lycansync.api.auth.dto.LoginResponse;
import com.lycansync.api.auth.model.AuthUser;
import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.auth.service.AccountLifecycleService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.security.SecurityRequirements;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import lombok.RequiredArgsConstructor;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.UUID;

/**
 * 独立于第三方的服主恢复与账号生命周期接口。
 *
 * @author Wreckloud
 * @since 2026-11-03
 */
@RestController
@RequestMapping("/api/auth/account")
@RequiredArgsConstructor
@Tag(name = "账号恢复与注销", description = "服主恢复密码、双方确认转让及保留历史的账号注销")
public class AccountLifecycleController {
    private final AccountLifecycleService accounts;

    public record RecoveryRequest(@Schema(description = "服主恢复密码") @NotNull @Size(max = 128) String password,
                                  @Schema(description = "客户端本次恢复的独立重试凭据")
                                  @NotNull @Pattern(regexp = "[A-Za-z0-9_-]{43}") String recoveryKey) { }
    public record PasswordRequest(@Schema(description = "首次设置时省略，否则提供原恢复密码") @Size(max = 128) String previousPassword,
                                  @Schema(description = "新的恢复密码，6–128 个字符") @NotNull @Size(min = 6, max = 128, message = "恢复密码长度不符合要求") String password) { }
    public record TransferRequest(@Schema(description = "接任成员 ID") @NotNull UUID targetId,
                                  @Schema(description = "当前服主恢复密码") @NotNull @Size(max = 128) String password) { }
    public record CloseRequest(@Schema(description = "固定填写“注销账号”") @NotNull @Pattern(regexp = "注销账号") String confirmation) { }

    @GetMapping
    @Operation(summary = "获取当前账号恢复、交接与注销条件")
    public ResponseEntity<AccountLifecycleService.Status> status(@AuthenticationPrincipal AuthenticatedUser user) {
        return noStore(accounts.status(user));
    }

    @PostMapping("/recover")
    @SecurityRequirements
    @Operation(summary = "用恢复密码恢复原服主账号", description = "保留原账号资料与权限，替换原有登录会话；不依赖 QQ")
    public ResponseEntity<LoginResponse> recover(@Valid @RequestBody RecoveryRequest request) {
        return noStore(accounts.recover(request.password(), request.recoveryKey()));
    }

    @PutMapping("/recovery-password")
    @Operation(summary = "服主设置或修改恢复密码", description = "修改已有密码时必须验证原密码，并取消待确认的转让")
    public ResponseEntity<Void> password(@AuthenticationPrincipal AuthenticatedUser user, @Valid @RequestBody PasswordRequest request) {
        accounts.saveRecovery(user, request.previousPassword(), request.password());
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/transfer")
    @Operation(summary = "服主发起转让", description = "24 小时内由接任者确认并设置自己的恢复密码，完成前原服主保留身份")
    public ResponseEntity<Void> transfer(@AuthenticationPrincipal AuthenticatedUser user, @Valid @RequestBody TransferRequest request) {
        accounts.offerTransfer(user, request.targetId(), request.password());
        return ResponseEntity.noContent().build();
    }

    @DeleteMapping("/transfer")
    @Operation(summary = "服主取消或接任者拒绝转让")
    public ResponseEntity<Void> cancel(@AuthenticationPrincipal AuthenticatedUser user) {
        accounts.cancelTransfer(user);
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/transfer/accept")
    @Operation(summary = "接任者确认转让并设置恢复密码", description = "原服主降为普通成员，原恢复密码与未使用的账号链接失效")
    public ResponseEntity<AuthUser> accept(@AuthenticationPrincipal AuthenticatedUser user, @Valid @RequestBody PasswordRequest request) {
        return noStore(accounts.acceptTransfer(user, request.password()));
    }

    @PostMapping("/close")
    @Operation(summary = "永久停用当前账号并标记已注销", description = "保留昵称、头像、签名、消息与共同语音历史；服主和群主必须先交接，撤销登录及语音资格")
    public ResponseEntity<Void> close(@AuthenticationPrincipal AuthenticatedUser user, @Valid @RequestBody CloseRequest request) {
        accounts.closeAccount(user, request.confirmation());
        return ResponseEntity.noContent().build();
    }

    private <T> ResponseEntity<T> noStore(T body) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(body);
    }
}
