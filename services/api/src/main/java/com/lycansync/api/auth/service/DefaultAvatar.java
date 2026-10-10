package com.lycansync.api.auth.service;

import org.springframework.core.io.ClassPathResource;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.util.Base64;

/**
 * 项目内置头像；不依赖部署电脑上的图片路径。
 * @author Wreckloud
 * @since 2026-10-10
 */
public final class DefaultAvatar {
    private static final String AVATAR = readAvatar();
    private DefaultAvatar() { }
    public static String value() { return AVATAR; }
    private static String readAvatar() {
        try (var input = new ClassPathResource("account/default.png").getInputStream()) {
            return "data:image/png;base64," + Base64.getEncoder().encodeToString(input.readAllBytes());
        } catch (IOException exception) {
            throw new UncheckedIOException("内置默认头像不可用", exception);
        }
    }
}
