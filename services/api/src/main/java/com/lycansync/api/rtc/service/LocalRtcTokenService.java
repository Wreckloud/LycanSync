package com.lycansync.api.rtc.service;

import com.lycansync.api.rtc.config.LiveKitProperties;
import com.lycansync.api.rtc.dto.RtcTokenResponse;
import io.livekit.server.AccessToken;
import io.livekit.server.CanPublish;
import io.livekit.server.CanPublishData;
import io.livekit.server.CanPublishSources;
import io.livekit.server.CanSubscribe;
import io.livekit.server.CanUpdateOwnMetadata;
import io.livekit.server.RoomJoin;
import io.livekit.server.RoomName;
import lombok.RequiredArgsConstructor;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Date;
import java.util.List;
import java.util.UUID;

/**
 * 本地 RTC 入房凭证签发服务。
 *
 * @author Wreckloud
 * @since 2026-09-03
 */
@Service
@Profile("rtc-local")
@RequiredArgsConstructor
public class LocalRtcTokenService {

    private static final Duration TOKEN_TTL = Duration.ofMinutes(10);

    private final LiveKitProperties liveKitProperties;
    private final Clock systemClock;

    public RtcTokenResponse issueToken(String groupId, String displayName) {
        // TODO: 接入 QQ 白名单登录后校验群组成员权限，并从登录身份获取用户标识和昵称。
        // 1. 生成临时身份：昵称允许重复，身份独立，避免同名连接互相挤掉。
        // TODO: 正式账号接入时明确多端入房规则，替换每次请求生成的临时身份。
        String participantIdentity = "dev-" + UUID.randomUUID();

        // 2. 确定首次入房的有效期：统一为秒精度，不作为通话时长限制。
        Instant issuedAt = Instant.now(systemClock).truncatedTo(ChronoUnit.SECONDS);
        Instant expiresAt = issuedAt.plus(TOKEN_TTL);

        // 3. 填写参与者信息和允许的操作，将权限限定在目标本地测试群组。
        String roomName = LocalRtcRooms.roomName(groupId);
        AccessToken accessToken = new AccessToken(
                liveKitProperties.getApiKey(), liveKitProperties.getApiSecret());
        accessToken.setIdentity(participantIdentity);
        accessToken.setName(displayName.strip());
        accessToken.setNotBefore(Date.from(issuedAt));
        accessToken.setExpiration(Date.from(expiresAt));
        // 允许更新自己的收听状态；仍不授予摄像头、房间管理和数据发送权限。
        // TODO: 正式权限设计中限制可写属性；客户端自报信息不能作为身份或权限依据。
        accessToken.addGrants(
                new RoomJoin(true),
                new RoomName(roomName),
                new CanPublish(true),
                new CanSubscribe(true),
                new CanPublishSources(List.of("microphone", "screen_share")),
                new CanPublishData(false),
                new CanUpdateOwnMetadata(true)
        );

        // 4. 生成签名凭证并返回连接信息；实际入房由客户端发起。
        return new RtcTokenResponse(
                liveKitProperties.getServerUrl(), roomName, participantIdentity,
                accessToken.toJwt(), expiresAt);
    }
}
