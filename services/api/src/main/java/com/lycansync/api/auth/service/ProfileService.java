package com.lycansync.api.auth.service;

import com.lycansync.api.auth.dto.ProfileUpdateRequest;
import com.lycansync.api.auth.exception.AuthException;
import com.lycansync.api.auth.mapper.AuthMapper;
import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.auth.model.AuthUser;
import com.lycansync.api.common.error.ApiErrorCode;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.util.Base64;
import java.util.Iterator;

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
        if (!request.avatar().isEmpty()) validateAvatar(request.avatar());
        if (mapper.updateProfile(user.id(), nickname, request.avatar()) != 1) {
            throw new AuthException(HttpStatus.NOT_FOUND, ApiErrorCode.ACCOUNT_NOT_FOUND, "账号不存在");
        }
        return new AuthUser(user.id(), nickname, request.avatar(), user.administrator());
    }

    private void validateAvatar(String avatar) {
        String prefix = avatar.startsWith("data:image/png;base64,") ? "data:image/png;base64,"
                : avatar.startsWith("data:image/jpeg;base64,") ? "data:image/jpeg;base64," : null;
        if (prefix == null) throw invalid("头像仅支持 PNG 或 JPEG");
        try {
            byte[] bytes = Base64.getDecoder().decode(avatar.substring(prefix.length()));
            if (bytes.length > 524288) throw invalid("头像不能超过 512 KB");
            try (var input = ImageIO.createImageInputStream(new ByteArrayInputStream(bytes))) {
                Iterator<ImageReader> readers = ImageIO.getImageReaders(input);
                if (!readers.hasNext()) throw invalid("头像文件无效");
                ImageReader reader = readers.next();
                try {
                    reader.setInput(input);
                    String format = reader.getFormatName();
                    if (!(format.equalsIgnoreCase("png") || format.equalsIgnoreCase("jpeg"))
                            || reader.getWidth(0) > 1024 || reader.getHeight(0) > 1024) {
                        throw invalid("头像尺寸不能超过 1024 × 1024");
                    }
                    reader.read(0);
                } finally { reader.dispose(); }
            }
        } catch (IOException | IllegalArgumentException exception) {
            throw invalid("头像文件无效");
        }
    }

    private AuthException invalid(String message) {
        return new AuthException(HttpStatus.BAD_REQUEST, ApiErrorCode.INVALID_REQUEST, message);
    }
}
