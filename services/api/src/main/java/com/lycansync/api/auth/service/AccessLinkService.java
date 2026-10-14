package com.lycansync.api.auth.service;

import com.lycansync.api.auth.config.AccountAccessProperties;
import com.lycansync.api.auth.dto.AccessLinkRequest;
import com.lycansync.api.auth.dto.LoginResponse;
import com.lycansync.api.auth.exception.AuthException;
import com.lycansync.api.auth.mapper.AccessLinkMapper;
import com.lycansync.api.auth.mapper.AuthMapper;
import com.lycansync.api.auth.model.AccessLink;
import com.lycansync.api.auth.model.AuthUser;
import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.common.error.ApiErrorCode;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.DataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;

/**
 * 邀请准入、管理员激活与原账号恢复；链接使用和会话替换一起提交。
 *
 * @author Wreckloud
 * @since 2026-10-10
 */
@Service
@Slf4j
@RequiredArgsConstructor
public class AccessLinkService {
    private final AccessLinkMapper links;
    private final AuthMapper users;
    private final AuthService sessions;
    private final AccountAccessProperties settings;
    private final TransactionTemplate transactions;
    private final Clock systemClock;

    public record GeneratedLink(AccessLink record, String url) { }
    public record LinkPreview(String kind, String status, String serverName) { }

    public GeneratedLink create(AuthenticatedUser administrator, AccessLinkRequest request) {
        requireAdministrator(administrator);
        if (!"INVITE".equals(request.kind()) && !"RECOVERY".equals(request.kind())) throw invalid("请选择邀请或恢复登录");
        if (("RECOVERY".equals(request.kind())) != (request.targetId() != null)) throw invalid("邀请不能指定旧账号，恢复必须指定成员");
        return transactions.execute(status -> {
            requireInitialized();
            if (request.targetId() != null) {
                AuthUser target = users.findUserProfile(request.targetId());
                if (target == null) throw notFound();
                if (target.administrator()) throw invalid("此入口只恢复普通成员登录");
                links.revokeRecovery(request.targetId(), now());
            }
            return generate(request.kind(), administrator.id(), request.targetId(), request.note());
        });
    }

    public GeneratedLink renew(AuthenticatedUser administrator, UUID id) {
        requireAdministrator(administrator);
        return transactions.execute(status -> {
            requireInitialized();
            AccessLink previous = links.lockById(id);
            if (previous == null || "ACTIVATE".equals(previous.kind())) throw notFound();
            if (previous.consumedAt() != null) throw invalid("已使用邀请不能重新生成；请为该成员创建恢复链接");
            if (previous.targetId() != null) links.revokeRecovery(previous.targetId(), now());
            links.revoke(previous.id(), now());
            return generate(previous.kind(), administrator.id(), previous.targetId(), previous.note());
        });
    }

    public void revoke(AuthenticatedUser administrator, UUID id) {
        requireAdministrator(administrator);
        transactions.executeWithoutResult(status -> {
            requireInitialized();
            AccessLink link = links.lockById(id);
            if (link == null || "ACTIVATE".equals(link.kind())) throw notFound();
            if (link.consumedAt() != null) throw invalid("已使用链接不能撤销成员账号");
            links.revoke(id, now());
        });
    }

    public List<AccessLink> list(AuthenticatedUser administrator, int offset) {
        requireAdministrator(administrator);
        if (offset < 0) throw invalid("分页位置无效");
        return links.list(offset);
    }

    public List<AuthUser> members(AuthenticatedUser administrator, int offset) {
        requireAdministrator(administrator);
        if (offset < 0) throw invalid("分页位置无效");
        return links.members(offset);
    }

    public LinkPreview preview(String token) {
        String hash = tokenHash(token);
        return transactions.execute(status -> {
            AccessLink link = links.lockByHash(hash);
            if (link == null) throw notFound();
            return new LinkPreview(link.kind(), linkStatus(link, now()), settings.getServerName());
        });
    }

    public LoginResponse redeem(String token, String redemptionKey, AuthenticatedUser current) {
        String hash = tokenHash(token);
        String keyHash = tokenHash(redemptionKey);
        try {
            String sessionToken = Base64.getUrlEncoder().withoutPadding().encodeToString(
                    HexFormat.of().parseHex(AuthSecrets.hash(token + ":" + redemptionKey)));
            return transactions.execute(status -> redeemInTransaction(hash, keyHash, sessionToken, current));
        } catch (AuthException | DataAccessException exception) {
            // 业务失败在回滚后记录，不把部分账号或会话提交为成功。
            try {
                links.recordFailure(hash, exception instanceof AuthException ? exception.getMessage() : "账号服务暂时不可用，请重试", now());
            } catch (DataAccessException recordingFailure) {
                exception.addSuppressed(recordingFailure);
                log.error("账号链接失败状态未能保存，异常类型：{}", recordingFailure.getClass().getSimpleName());
            }
            throw exception;
        }
    }

    private LoginResponse redeemInTransaction(String hash, String keyHash, String sessionToken, AuthenticatedUser current) {
        // 所有链接变更先锁同一初始化行，固定顺序避免激活、恢复与撤销交错死锁。
        boolean initialized = initializedForUpdate();
        AccessLink link = links.lockByHash(hash);
        if (link == null) throw notFound();
        Instant now = now();
        if (current != null) throw invalid("已经登录，请先退出当前账号；对应原账号可以直接进入应用");
        if (link.consumedAt() != null && link.expiresAt().isAfter(now)
                && link.consumedAt().plus(Duration.ofMinutes(2)).isAfter(now)
                && keyHash.equals(links.redemptionKeyHash(link.id()))) {
            // 原响应丢失时，只有原客户端的独立重试凭据能取回同一账号。
            AuthUser previous = users.findUserProfile(link.resultUserId());
            if (previous == null) throw notFound();
            AuthenticatedUser session = users.findSessionUser(AuthSecrets.hash(sessionToken), now);
            if (session == null || !session.id().equals(previous.id())) throw invalid("原会话已结束，请联系服主恢复登录");
            return new LoginResponse(sessionToken, previous);
        }
        if (!"PENDING".equals(linkStatus(link, now))) throw invalid("链接已使用、过期或撤销，请联系服主");
        AuthUser user;
        if ("RECOVERY".equals(link.kind())) {
            user = users.findUserProfile(link.targetId());
            if (user == null) throw notFound();
        } else {
            boolean administrator = "ACTIVATE".equals(link.kind());
            if (administrator ? initialized : !initialized) throw invalid("服务器初始化状态不允许此次操作");
            if (administrator && users.markInitialized(now) != 1) throw invalid("服务器已经激活");
            user = new AuthUser(UUID.randomUUID(), "行者" + links.nextGuestNumber(), DefaultAvatar.value(), administrator, "", now);
            users.insertUser(user, now);
        }
        if (links.consume(link.id(), user.id(), keyHash, now) != 1) throw invalid("链接已被使用，请重新检查");
        return new LoginResponse(sessions.issueSession(user, sessionToken), user);
    }

    public GeneratedLink activation() {
        return transactions.execute(status -> {
            if (initializedForUpdate()) return null;
            links.revokeActivation(now());
            return generate("ACTIVATE", null, null, "首次管理员激活");
        });
    }

    private GeneratedLink generate(String kind, UUID creator, UUID target, String note) {
        if (settings.getPublicUrl().isBlank()) throw invalid("服务器尚未配置公开入口地址");
        if (note != null && (note.length() > 100 || note.codePoints().anyMatch(Character::isISOControl))) throw invalid("邀请备注无效");
        Instant now = now();
        Duration lifetime = "INVITE".equals(kind) ? Duration.ofDays(3) : Duration.ofHours(12);
        AccessLink link = new AccessLink(UUID.randomUUID(), kind, creator, target, note == null ? "" : note.strip(), now,
                now.plus(lifetime), null, null, null, null, null);
        String token = AuthSecrets.generate();
        links.insert(link, AuthSecrets.hash(token));
        return new GeneratedLink(link, settings.getPublicUrl() + "/join#token=" + token);
    }

    public static String linkStatus(AccessLink link, Instant now) {
        if (link.consumedAt() != null) return "COMPLETED";
        if (link.revokedAt() != null) return "REVOKED";
        if (!link.expiresAt().isAfter(now)) return "EXPIRED";
        return "PENDING";
    }

    private boolean initializedForUpdate() {
        Boolean initialized = links.lockInitialization();
        if (initialized == null) throw new IllegalStateException("系统初始化记录缺失");
        return initialized;
    }
    private void requireInitialized() { if (!initializedForUpdate()) throw invalid("请先完成管理员激活"); }
    private void requireAdministrator(AuthenticatedUser user) {
        if (user == null || !user.administrator()) throw new AuthException(HttpStatus.FORBIDDEN, ApiErrorCode.ACCESS_DENIED, "只有服主可以管理邀请和成员");
    }
    private String tokenHash(String token) {
        if (token == null || !token.matches("[A-Za-z0-9_-]{43}")) throw invalid("链接凭据无效");
        return AuthSecrets.hash(token);
    }
    private Instant now() { return Instant.now(systemClock); }
    private AuthException invalid(String message) { return new AuthException(HttpStatus.CONFLICT, ApiErrorCode.INVALID_REQUEST, message); }
    private AuthException notFound() { return new AuthException(HttpStatus.NOT_FOUND, ApiErrorCode.ACCOUNT_NOT_FOUND, "链接或成员不存在"); }
}
