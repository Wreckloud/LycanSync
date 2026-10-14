package com.lycansync.api.rtc.service;

import com.auth0.jwt.JWT;
import com.auth0.jwt.JWTVerifier;
import com.auth0.jwt.algorithms.Algorithm;
import com.auth0.jwt.exceptions.JWTVerificationException;
import com.auth0.jwt.interfaces.DecodedJWT;
import com.lycansync.api.auth.exception.AuthException;
import com.lycansync.api.common.error.ApiErrorCode;
import com.lycansync.api.group.mapper.GroupMapper;
import com.lycansync.api.rtc.config.LiveKitProperties;
import io.livekit.server.WebhookReceiver;
import livekit.LivekitWebhook;
import org.springframework.context.annotation.Profile;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * 信令连接入口重新核验签名与当前成员资格，不信任仍有效的旧入房凭证。
 *
 * @author Wreckloud
 * @since 2026-10-13
 */
@Service
@Profile({"rtc-local", "rtc-server"})
public class GroupRtcAdmissionService {

    private static final Pattern UUID_TEXT = Pattern.compile(
            "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}");

    private final GroupMapper groups;
    private final JWTVerifier verifier;
    private final WebhookReceiver webhooks;
    private final GroupRtcAccessService rtcAccess;

    public GroupRtcAdmissionService(GroupMapper groups, LiveKitProperties properties, GroupRtcAccessService rtcAccess) {
        this.groups = groups;
        this.rtcAccess = rtcAccess;
        this.verifier = JWT.require(Algorithm.HMAC256(properties.getApiSecret()))
                .withIssuer(properties.getApiKey()).withClaimPresence("exp").build();
        this.webhooks = new WebhookReceiver(properties.getApiKey(), properties.getApiSecret());
    }

    @Transactional
    public void checkJoinedParticipant(String body, String authorization) {
        LivekitWebhook.WebhookEvent event;
        try {
            event = webhooks.receive(body, authorization);
        } catch (JWTVerificationException | IllegalArgumentException exception) {
            throw invalidToken();
        }
        if (!"participant_joined".equals(event.getEvent())
                || !event.getRoom().getName().startsWith(GroupRtcRooms.ROOM_PREFIX)) return;
        UUID roomKey = identifier(event.getRoom().getName(), GroupRtcRooms.ROOM_PREFIX);
        UUID userId = identifier(event.getParticipant().getIdentity(), "user-");
        String groupId = groups.lockRtcGroup(roomKey);
        // 入房是外部异步操作：复核网关放行后、真正入房前发生的撤权，不轮询或重建房间。
        if (groupId == null || !groups.memberExists(UUID.fromString(groupId), userId)) {
            rtcAccess.removeParticipant(roomKey, userId);
        }
    }

    @Transactional
    public void requireMember(String authorization, String queryToken) {
        String token = queryToken;
        // 与 LiveKit 一致：Authorization 优先，不能通过第二份查询凭据绕过无效的认证头。
        if (authorization != null && !authorization.isBlank()) {
            if (!authorization.startsWith("Bearer ")) throw invalidToken();
            token = authorization.substring(7);
        }
        if (token == null || token.isBlank() || token.length() > 8192) throw invalidToken();
        UUID roomKey;
        UUID userId;
        try {
            DecodedJWT claims = verifier.verify(token);
            Map<String, Object> video = claims.getClaim("video").asMap();
            if (video == null || !Boolean.TRUE.equals(video.get("roomJoin"))) throw invalidToken();
            roomKey = identifier((String) video.get("room"), GroupRtcRooms.ROOM_PREFIX);
            userId = identifier(claims.getSubject(), "user-");
        } catch (JWTVerificationException | IllegalArgumentException | ClassCastException exception) {
            // 不向客户端或日志回显凭据、签名及解析异常。
            throw invalidToken();
        }
        String groupId = groups.lockRtcGroup(roomKey);
        if (groupId == null || !groups.memberExists(UUID.fromString(groupId), userId)) {
            throw new AuthException(HttpStatus.FORBIDDEN, ApiErrorCode.ACCESS_DENIED,
                    "你已不在此群，无法连接语音");
        }
    }

    private UUID identifier(String value, String prefix) {
        if (value == null || !value.startsWith(prefix)) throw invalidToken();
        String id = value.substring(prefix.length());
        if (!UUID_TEXT.matcher(id).matches()) throw invalidToken();
        return UUID.fromString(id);
    }

    private AuthException invalidToken() {
        return new AuthException(HttpStatus.UNAUTHORIZED, ApiErrorCode.INVALID_AUTHORIZATION,
                "语音凭证无效或已过期，请重新加入");
    }
}
