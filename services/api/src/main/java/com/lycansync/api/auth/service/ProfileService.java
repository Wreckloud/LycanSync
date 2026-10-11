package com.lycansync.api.auth.service;

import com.lycansync.api.auth.dto.ProfileUpdateRequest;
import com.lycansync.api.auth.exception.AuthException;
import com.lycansync.api.auth.mapper.AuthMapper;
import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.auth.model.AuthUser;
import com.lycansync.api.common.error.ApiErrorCode;
import com.lycansync.api.common.image.AvatarImageProcessor;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;


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
        String signature = request.signature() == null ? null : request.signature().strip();
        if (signature != null && (signature.length() > 120
                || signature.codePoints().anyMatch(value -> Character.isISOControl(value)
                && value != '\n' && value != '\r'))) {
            throw invalid("个性签名不能超过 120 个字符或包含非法控制字符");
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
        return findProfile(user);
    }

    private AuthException invalid(String message) {
        return new AuthException(HttpStatus.BAD_REQUEST, ApiErrorCode.INVALID_REQUEST, message);
    }
}
