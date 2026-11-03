package com.lycansync.api.auth.service;

import com.lycansync.api.auth.dto.LoginResponse;
import com.lycansync.api.auth.exception.AuthException;
import com.lycansync.api.auth.mapper.AccessLinkMapper;
import com.lycansync.api.auth.mapper.AccountLifecycleMapper;
import com.lycansync.api.auth.mapper.AuthMapper;
import com.lycansync.api.auth.model.AuthUser;
import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.common.error.ApiErrorCode;
import com.lycansync.api.group.event.GroupChangedEvent;
import com.lycansync.api.group.mapper.GroupMapper;
import com.lycansync.api.group.model.GroupRole;
import com.lycansync.api.rtc.service.GroupRtcAccessService;
import lombok.RequiredArgsConstructor;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.http.HttpStatus;
import org.springframework.security.crypto.password.Pbkdf2PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.Semaphore;

/**
 * 服主独立恢复、双方确认交接及保留历史的账号注销。
 *
 * @author Wreckloud
 * @since 2026-11-03
 */
@Service
@RequiredArgsConstructor
public class AccountLifecycleService {
    private final AccountLifecycleMapper accounts;
    private final AccessLinkMapper links;
    private final AuthMapper users;
    private final AuthService sessions;
    private final GroupMapper groups;
    private final GroupRtcAccessService rtc;
    private final ApplicationEventPublisher events;
    private final TransactionTemplate transactions;
    private final Clock systemClock;
    private final Semaphore recovering = new Semaphore(2);
    private final Pbkdf2PasswordEncoder passwords = new Pbkdf2PasswordEncoder("", 16, 600_000,
            Pbkdf2PasswordEncoder.SecretKeyFactoryAlgorithm.PBKDF2WithHmacSHA256);

    public record OwnedGroup(UUID id, String name) { }
    public record TransferOffer(String ownerNickname, Instant expiresAt) { }
    public record Status(boolean administrator, boolean recoveryConfigured, List<OwnedGroup> ownedGroups,
                         List<AccountLifecycleMapper.Candidate> candidates, TransferOffer incomingTransfer,
                         UUID transferTargetId) { }

    public AccountLifecycleMapper.State state() {
        var state = accounts.state();
        if (state == null || state.initialized() != (state.ownerId() != null)) {
            throw new IllegalStateException("服务器服主与初始化状态不一致");
        }
        return state;
    }

    public Status status(AuthenticatedUser user) {
        var current = active(user);
        var state = state();
        var owned = groups.findGroups(user.id()).stream().filter(group -> group.role() == GroupRole.OWNER)
                .map(group -> new OwnedGroup(group.id(), group.name())).toList();
        boolean pending = state.transferExpiresAt() != null && state.transferExpiresAt().isAfter(now());
        TransferOffer incoming = pending && user.id().equals(state.transferTargetId())
                ? new TransferOffer(users.findUserProfile(state.ownerId()).nickname(), state.transferExpiresAt()) : null;
        return new Status(current.administrator(), configured(state), owned,
                current.administrator() ? accounts.candidates() : List.of(), incoming,
                current.administrator() && pending ? state.transferTargetId() : null);
    }

    public void initializeRecovery(UUID userId, String password) {
        // 调用方已持有初始化行锁，与首次服主创建和激活链接消耗一起提交。
        accounts.saveRecovery(userId, encode(password));
    }

    public void saveRecovery(AuthenticatedUser user, String previousPassword, String password) {
        requireOwner(user);
        String hash = encode(password);
        transactions.executeWithoutResult(transaction -> {
            lockState();
            requireOwner(user);
            var state = state();
            if (configured(state) && !matches(previousPassword, state.recoveryHash())) throw invalid("原恢复密码不正确");
            accounts.saveRecovery(user.id(), hash);
            accounts.clearTransfer();
        });
    }

    public LoginResponse recover(String password, String recoveryKey) {
        if (!recovering.tryAcquire()) throw new AuthException(HttpStatus.TOO_MANY_REQUESTS,
                ApiErrorCode.AUTH_RATE_LIMITED, "恢复请求较多，请稍后再试");
        try {
            var snapshot = state();
            if (!configured(snapshot) || !matches(password, snapshot.recoveryHash())) {
                throw new AuthException(HttpStatus.UNAUTHORIZED, ApiErrorCode.INVALID_SESSION, "恢复密码不正确或尚未设置");
            }
            if (recoveryKey == null || !recoveryKey.matches("[A-Za-z0-9_-]{43}")) throw invalid("恢复请求无效，请重新打开恢复界面");
            return transactions.execute(transaction -> {
                lockState();
                var current = state();
                if (!Objects.equals(snapshot.ownerId(), current.ownerId())
                        || !Objects.equals(snapshot.recoveryHash(), current.recoveryHash())) throw invalid("服主身份或恢复密码已变化，请重新恢复");
                AuthUser owner = users.findUserProfile(current.ownerId());
                String token = Base64.getUrlEncoder().withoutPadding().encodeToString(HexFormat.of().parseHex(
                        AuthSecrets.hash(current.ownerId() + ":" + current.recoveryHash() + ":" + recoveryKey)));
                accounts.clearTransfer();
                return new LoginResponse(sessions.issueSession(owner, token), owner);
            });
        } finally {
            recovering.release();
        }
    }

    public void offerTransfer(AuthenticatedUser user, UUID targetId, String password) {
        transactions.executeWithoutResult(transaction -> {
            lockState();
            requireOwner(user);
            var current = state();
            if (!configured(current) || !matches(password, current.recoveryHash())) throw invalid("请先设置并输入正确的服主恢复密码");
            AuthUser target = users.findUserProfile(targetId);
            if (target == null || target.deletedAt() != null || target.administrator() || target.id().equals(user.id())) {
                throw invalid("请选择本服务器仍有效的普通成员");
            }
            accounts.offerTransfer(targetId, now().plus(Duration.ofHours(24)));
        });
    }

    public void cancelTransfer(AuthenticatedUser user) {
        transactions.executeWithoutResult(transaction -> {
            lockState();
            var state = state();
            active(user);
            if (!user.id().equals(state.ownerId()) && !user.id().equals(state.transferTargetId())) throw denied();
            accounts.clearTransfer();
        });
    }

    public AuthUser acceptTransfer(AuthenticatedUser user, String password) {
        active(user);
        var pending = state();
        if (!user.id().equals(pending.transferTargetId()) || pending.transferExpiresAt() == null
                || !pending.transferExpiresAt().isAfter(now())) throw invalid("服主转让已取消或过期");
        String hash = encode(password);
        return transactions.execute(transaction -> {
            lockState();
            active(user);
            var state = state();
            if (!user.id().equals(state.transferTargetId()) || state.transferExpiresAt() == null
                    || !state.transferExpiresAt().isAfter(now())) throw invalid("服主转让已取消或过期");
            if (accounts.demoteOwner(state.ownerId()) != 1 || accounts.promoteOwner(user.id()) != 1) {
                throw invalid("服主身份发生变化，请重新发起转让");
            }
            accounts.saveRecovery(user.id(), hash);
            accounts.clearTransfer();
            accounts.revokePendingLinks(now());
            return users.findUserProfile(user.id());
        });
    }

    public void closeAccount(AuthenticatedUser user, String confirmation) {
        if (!"注销账号".equals(confirmation)) throw invalid("请输入“注销账号”确认");
        transactions.executeWithoutResult(transaction -> {
            lockState();
            if (active(user).administrator()) throw invalid("服主需要先完成服主转让，再注销账号");
            var memberships = groups.findGroups(user.id()).stream().sorted((left, right) -> left.id().compareTo(right.id())).toList();
            for (var group : memberships) {
                groups.lockOwner(group.id());
                if (group.role() == GroupRole.OWNER) throw invalid("请先转让或解散自己拥有的群组");
            }
            for (var group : memberships) rtc.removeParticipant(UUID.fromString(groups.findRtcRoomKey(group.id())), user.id());
            if (accounts.closeAccount(user.id(), now()) != 1) throw invalid("账号状态已经变化");
            accounts.revokeSessions(user.id());
            accounts.revokeLinks(user.id(), now());
            if (user.id().equals(state().transferTargetId())) accounts.clearTransfer();
            // 历史资料、消息及成员关系保留；当前成员资格统一排除已注销账号。
            for (var group : memberships) {
                groups.touchGroup(group.id(), now());
                events.publishEvent(new GroupChangedEvent(group.id(), false));
            }
        });
    }

    private void lockState() {
        if (links.lockInitialization() == null) throw new IllegalStateException("服务器初始化记录缺失");
    }
    private AuthUser active(AuthenticatedUser user) {
        AuthUser current = user == null ? null : users.findUserProfile(user.id());
        if (current == null || current.deletedAt() != null) throw denied();
        return current;
    }
    private void requireOwner(AuthenticatedUser user) {
        if (!active(user).administrator() || !user.id().equals(state().ownerId())) throw denied();
    }
    private boolean configured(AccountLifecycleMapper.State state) {
        return state.ownerId() != null && state.ownerId().equals(state.recoveryUserId()) && state.recoveryHash() != null;
    }
    private String encode(String password) {
        if (password == null || password.length() < 15 || password.length() > 128 || password.isBlank()) {
            throw invalid("恢复密码需要 15–128 个字符");
        }
        return passwords.encode(password);
    }
    private boolean matches(String password, String hash) {
        return password != null && password.length() <= 128 && passwords.matches(password, hash);
    }
    private Instant now() { return Instant.now(systemClock); }
    private AuthException invalid(String message) { return new AuthException(HttpStatus.CONFLICT, ApiErrorCode.INVALID_REQUEST, message); }
    private AuthException denied() { return new AuthException(HttpStatus.FORBIDDEN, ApiErrorCode.ACCESS_DENIED, "账号已注销或没有执行此操作的权限"); }
}
