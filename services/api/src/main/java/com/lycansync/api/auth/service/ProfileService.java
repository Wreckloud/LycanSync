package com.lycansync.api.auth.service;

import com.lycansync.api.auth.dto.ProfileUpdateRequest;
import com.lycansync.api.auth.exception.AuthException;
import com.lycansync.api.auth.mapper.AuthMapper;
import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.auth.model.AuthUser;
import com.lycansync.api.common.error.ApiErrorCode;
import com.lycansync.api.common.image.AvatarImageProcessor;
import com.lycansync.api.group.mapper.GroupMapper;
import com.lycansync.api.group.event.GroupChangedEvent;
import org.springframework.context.ApplicationEventPublisher;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.UUID;


/**
 * 用户自定义昵称、头像与个性签名。
 *
 * @author Wreckloud
 * @since 2026-09-06
 */
@Service
@RequiredArgsConstructor
public class ProfileService {

    private final AuthMapper mapper;
    private final GroupMapper groupMapper;
    private final ApplicationEventPublisher events;

    public AuthUser findProfile(AuthenticatedUser user) {
        AuthUser profile = mapper.findUserProfile(user.id());
        if (profile == null) {
            throw new AuthException(HttpStatus.NOT_FOUND, ApiErrorCode.ACCOUNT_NOT_FOUND, "账号不存在");
        }
        return profile;
    }

    @Transactional
    public AuthUser update(AuthenticatedUser user, ProfileUpdateRequest request) {
        String nickname = request.nickname().strip();
        if (nickname.isBlank() || nickname.codePoints().anyMatch(Character::isISOControl)) {
            throw invalid("昵称不能为空或包含控制字符");
        }
        // 旧昵称不截断；仅更新头像或签名时仍允许原值通过。
        if (nickname.codePoints().map(value -> value <= 0x7f ? 1 : 2).sum() > 16
                && !nickname.equals(findProfile(user).nickname())) {
            throw invalid("昵称太长，请缩短一些（最多 8 个汉字或 16 个英文、数字）。");
        }
        String signature = request.signature() == null ? null : request.signature().strip();
        if (signature != null && (signature.length() > 40
                || signature.codePoints().anyMatch(value -> Character.isISOControl(value)
                && value != '\n' && value != '\r'))) {
            throw invalid("个性签名不能超过 40 个字符或包含非法控制字符");
        }
        String avatar = request.avatar();
        // 只处理客户端裁剪的图片，不抓取用户网址；随包默认头像仍原样保留。
        try {
            if (!avatar.isEmpty() && !avatar.equals(DefaultAvatar.value())) {
                avatar = AvatarImageProcessor.normalize(avatar);
            }
        } catch (AvatarImageProcessor.InvalidAvatarException exception) {
            throw invalid(exception.getMessage());
        }
        if (mapper.updateProfile(user.id(), nickname, avatar, signature) != 1) {
            throw new AuthException(HttpStatus.NOT_FOUND, ApiErrorCode.ACCOUNT_NOT_FOUND, "账号不存在");
        }
        groupMapper.findGroupIdsByMember(user.id()).stream().map(UUID::fromString)
                .forEach(groupId -> events.publishEvent(new GroupChangedEvent(groupId, false)));
        return findProfile(user);
    }

    private AuthException invalid(String message) {
        return new AuthException(HttpStatus.BAD_REQUEST, ApiErrorCode.INVALID_REQUEST, message);
    }
}
