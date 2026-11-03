package com.lycansync.api.auth.service;

import com.lycansync.api.auth.config.QqLoginProperties;
import com.lycansync.api.auth.dto.QqLoginResponse;
import com.lycansync.api.auth.exception.AuthException;
import com.lycansync.api.auth.mapper.AccessLinkMapper;
import com.lycansync.api.auth.mapper.AuthMapper;
import com.lycansync.api.auth.mapper.QqIdentityMapper;
import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.auth.model.AuthUser;
import com.lycansync.api.common.error.ApiErrorCode;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.security.MessageDigest;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Semaphore;

/**
 * 有界、短期的 QQ 授权任务；回调验证身份，原发起端确认后才登录或绑定。
 *
 * @author Wreckloud
 * @since 2026-11-03
 */
@Service
@RequiredArgsConstructor
public class QqLoginService {
    private final QqLoginProperties settings;
    private final QqIdentityClient client;
    private final QqIdentityMapper identities;
    private final AuthMapper users;
    private final AccessLinkMapper access;
    private final AuthService sessions;
    private final TransactionTemplate transactions;
    private final Clock systemClock;
    private final Map<String, Pending> pending = new HashMap<>();
    private final Semaphore exchanging = new Semaphore(4);

    public record Start(String request, String authorizationUrl) { }
    public record Authorization(String url, String browserProof) { }
    public record Result(boolean ready, boolean desktop, String purpose, String nickname, String avatar, String error) { }
    public record Binding(boolean bound, String nickname) { }

    private static final class Pending {
        final String challenge;
        final boolean desktop;
        final AuthenticatedUser bindingUser;
        final Instant expires;
        String browserHash;
        String status = "PENDING";
        String error = "";
        QqIdentityClient.Identity identity;
        UUID resultUser;
        boolean newAccount;
        Instant completed;

        Pending(String challenge, boolean desktop, AuthenticatedUser bindingUser, Instant expires) {
            this.challenge = challenge;
            this.desktop = desktop;
            this.bindingUser = bindingUser;
            this.expires = expires;
        }
    }

    public synchronized Start start(String challenge, boolean desktop, boolean binding, AuthenticatedUser user) {
        requireEnabled();
        if (challenge == null || !challenge.matches("[a-f0-9]{64}")) throw invalid("登录请求无效");
        if (binding && (user == null || user.sessionHash() == null)) throw invalid("请先登录原账号再绑定 QQ");
        if (!binding && user != null) throw invalid("请先返回账号选择页并清除本机凭据，再登录其他账号");
        pending.entrySet().removeIf(entry -> !entry.getValue().expires.isAfter(now()));
        if (pending.size() >= 128) throw new AuthException(HttpStatus.TOO_MANY_REQUESTS,
                ApiErrorCode.AUTH_RATE_LIMITED, "登录请求较多，请稍后再试");
        String request = AuthSecrets.generate();
        pending.put(AuthSecrets.hash(request), new Pending(challenge, desktop, binding ? user : null, now().plus(Duration.ofMinutes(10))));
        return new Start(request, settings.publicUrl() + "/api/auth/qq/authorize?request=" + request);
    }

    public Authorization authorize(String request, String browserProof) {
        Pending flow = find(request);
        synchronized (flow) {
            if (!"PENDING".equals(flow.status)) throw invalid("此次授权已处理，请重新发起登录");
            if (flow.browserHash == null) {
                browserProof = AuthSecrets.generate();
                flow.browserHash = AuthSecrets.hash(browserProof);
            } else if (!matches(browserProof, flow.browserHash)) throw invalid("请在发起授权的浏览器中继续");
            String url = "https://graph.qq.com/oauth2.0/authorize?response_type=code&scope=get_user_info&client_id="
                    + QqIdentityClient.encode(settings.getAppId()) + "&redirect_uri="
                    + QqIdentityClient.encode(settings.getCallbackUrl()) + "&state=" + request;
            return new Authorization(url, browserProof);
        }
    }

    public void callback(String request, String proof, String code, String error) {
        Pending flow = find(request);
        synchronized (flow) {
            requireBrowser(flow, proof);
            if (!"PENDING".equals(flow.status)) throw invalid("此次授权已处理，请重新发起登录");
            if (error != null || code == null || !code.matches("[A-Za-z0-9_-]{4,1024}")) {
                flow.status = "FAILED";
                flow.error = "QQ 授权已取消或未完成，请重新登录";
                return;
            }
            flow.status = "EXCHANGING";
        }
        if (!exchanging.tryAcquire()) {
            synchronized (flow) { flow.status = "FAILED"; flow.error = "授权服务繁忙，请重新登录"; }
            return;
        }
        try {
            QqIdentityClient.Identity identity = client.exchange(code);
            synchronized (flow) { flow.identity = identity; flow.status = "READY"; }
        } catch (AuthException exception) {
            synchronized (flow) { flow.status = "FAILED"; flow.error = exception.getMessage(); }
        } finally { exchanging.release(); }
    }

    public Result result(String request, String proof) {
        Pending flow = find(request);
        synchronized (flow) {
            requireBrowser(flow, proof);
            return new Result("READY".equals(flow.status), flow.desktop, flow.bindingUser == null ? "LOGIN" : "BIND",
                    flow.identity == null ? "" : flow.identity.nickname(), flow.identity == null ? "" : flow.identity.avatar(), flow.error);
        }
    }

    public QqLoginResponse exchange(String request, String verifier) {
        Pending flow = verified(request, verifier);
        synchronized (flow) {
            if (flow.bindingUser != null) throw invalid("绑定请求不能用于登录");
            String token = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(
                    java.util.HexFormat.of().parseHex(AuthSecrets.hash(request + ":" + verifier)));
            if (flow.completed != null) {
                AuthenticatedUser active = users.findSessionUser(AuthSecrets.hash(token), now());
                if (flow.completed.plusSeconds(120).isBefore(now()) || active == null || !active.id().equals(flow.resultUser)) {
                    throw invalid("此次登录已经结束，请重新授权");
                }
                return new QqLoginResponse(token, users.findUserProfile(flow.resultUser), flow.newAccount);
            }
            requireReady(flow);
            QqLoginResponse response = transactions.execute(status -> {
                requireInitialized();
                String userId = identities.findUserId(settings.getAppId(), flow.identity.openId());
                AuthUser user;
                if (userId == null) {
                    String nickname = flow.identity.nickname();
                    if (nickname.length() > 32) nickname = nickname.substring(0, Character.isHighSurrogate(nickname.charAt(31)) ? 31 : 32);
                    user = new AuthUser(UUID.randomUUID(), nickname, flow.identity.avatar(), false, "", now());
                    users.insertUser(user, now());
                    if (identities.insert(settings.getAppId(), flow.identity.openId(), user.id(), flow.identity.nickname(), now()) != 1) {
                        throw invalid("QQ 已关联其他账号，请重新登录");
                    }
                } else {
                    user = users.findUserProfile(UUID.fromString(userId));
                    if (user == null) throw invalid("关联账号已不存在，请联系服主");
                }
                return new QqLoginResponse(sessions.issueSession(user, token), user, userId == null);
            });
            flow.resultUser = response.user().id();
            flow.newAccount = response.newAccount();
            flow.completed = now();
            flow.status = "COMPLETED";
            return response;
        }
    }

    public Binding confirmBinding(String request, String verifier, AuthenticatedUser user) {
        Pending flow = verified(request, verifier);
        synchronized (flow) {
            if (user == null || flow.bindingUser == null || !user.id().equals(flow.bindingUser.id())
                    || !java.util.Objects.equals(user.sessionHash(), flow.bindingUser.sessionHash())) {
                throw invalid("原账号会话已改变，请从设置重新绑定");
            }
            if (flow.completed != null) return binding(user);
            requireReady(flow);
            transactions.executeWithoutResult(status -> {
                requireInitialized();
                var current = users.findSessionUser(user.sessionHash(), now());
                if (current == null || !current.id().equals(user.id())) throw invalid("原账号会话已失效，请重新登录");
                String linked = identities.findUserId(settings.getAppId(), flow.identity.openId());
                if (user.id().toString().equals(linked)) return;
                if (linked != null || identities.findNickname(user.id()) != null) throw invalid("QQ 或当前账号已有关联，不能覆盖绑定");
                if (identities.insert(settings.getAppId(), flow.identity.openId(), user.id(), flow.identity.nickname(), now()) != 1) {
                    throw invalid("QQ 或当前账号已有关联，请重新检查");
                }
            });
            flow.completed = now();
            flow.status = "COMPLETED";
            return binding(user);
        }
    }

    public Binding binding(AuthenticatedUser user) {
        String nickname = identities.findNickname(user.id());
        return new Binding(nickname != null, nickname == null ? "" : nickname);
    }

    public String cookieName(String request) {
        if (request == null || !request.matches("[A-Za-z0-9_-]{43}")) throw invalid("登录请求无效");
        return "__Host-lycan-qq-" + AuthSecrets.hash(request).substring(0, 12);
    }

    private synchronized Pending find(String request) {
        requireEnabled();
        cookieName(request);
        Pending flow = pending.get(AuthSecrets.hash(request));
        if (flow == null || !flow.expires.isAfter(now())) throw invalid("登录请求已过期，请重新发起授权");
        return flow;
    }

    private Pending verified(String request, String verifier) {
        Pending flow = find(request);
        if (!matches(verifier, flow.challenge)) throw invalid("请在原来发起登录的应用中确认");
        return flow;
    }

    private void requireBrowser(Pending flow, String proof) {
        if (flow.browserHash == null || !matches(proof, flow.browserHash)) throw invalid("授权浏览器不一致，请重新登录");
    }

    private boolean matches(String value, String hash) {
        return value != null && value.matches("[A-Za-z0-9_-]{43}") && MessageDigest.isEqual(
                AuthSecrets.hash(value).getBytes(StandardCharsets.US_ASCII), hash.getBytes(StandardCharsets.US_ASCII));
    }

    private void requireReady(Pending flow) {
        if (!"READY".equals(flow.status) || flow.identity == null) throw invalid(flow.error.isEmpty() ? "QQ 授权尚未完成" : flow.error);
    }

    private void requireInitialized() {
        if (!Boolean.TRUE.equals(access.lockInitialization())) throw invalid("服务器尚未完成首次激活，请联系服主");
    }

    private void requireEnabled() {
        if (!settings.isEnabled()) throw new AuthException(HttpStatus.SERVICE_UNAVAILABLE,
                ApiErrorCode.AUTH_SERVICE_UNAVAILABLE, "此服务器尚未开启 QQ 登录");
        settings.publicUrl();
    }

    private Instant now() { return Instant.now(systemClock); }
    private AuthException invalid(String message) {
        return new AuthException(HttpStatus.BAD_REQUEST, ApiErrorCode.INVALID_REQUEST, message);
    }
}
