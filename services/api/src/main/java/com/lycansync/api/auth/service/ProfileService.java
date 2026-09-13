package com.lycansync.api.auth.service;

import com.lycansync.api.auth.dto.ProfileUpdateRequest;
import com.lycansync.api.auth.exception.AuthException;
import com.lycansync.api.auth.mapper.AuthMapper;
import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.auth.model.AuthUser;
import com.lycansync.api.common.error.ApiErrorCode;
import com.lycansync.api.common.image.AvatarImageValidator;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;


/**
 * 用户自定义昵称与头像。
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

    public AuthUser update(AuthenticatedUser user, ProfileUpdateRequest request) {
        String nickname = request.nickname().strip();
        if (nickname.isBlank() || nickname.codePoints().anyMatch(Character::isISOControl)) {
            throw invalid("昵称不能为空或包含控制字符");
        }
        // 头像只接受本地上传的小尺寸图片，不允许服务器抓取用户指定网址。
        try {
            if (!request.avatar().isEmpty()) AvatarImageValidator.validate(request.avatar());
        } catch (AvatarImageValidator.InvalidAvatarException exception) {
            throw invalid(exception.getMessage());
        }
        if (mapper.updateProfile(user.id(), nickname, request.avatar()) != 1) {
            throw new AuthException(HttpStatus.NOT_FOUND, ApiErrorCode.ACCOUNT_NOT_FOUND, "账号不存在");
        }
        return new AuthUser(user.id(), nickname, request.avatar(), user.administrator());
    }

    private AuthException invalid(String message) {
        return new AuthException(HttpStatus.BAD_REQUEST, ApiErrorCode.INVALID_REQUEST, message);
    }
}
