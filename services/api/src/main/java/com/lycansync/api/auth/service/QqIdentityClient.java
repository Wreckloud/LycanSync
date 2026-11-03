package com.lycansync.api.auth.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.lycansync.api.auth.config.QqLoginProperties;
import com.lycansync.api.auth.exception.AuthException;
import com.lycansync.api.common.error.ApiErrorCode;
import com.lycansync.api.common.image.AvatarImageProcessor;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Locale;

/**
 * 仅访问 QQ 官方身份接口，授权令牌不落库、不进入日志或客户端。
 *
 * @author Wreckloud
 * @since 2026-11-03
 */
@Service
public class QqIdentityClient {
    private final QqLoginProperties settings;
    private final ObjectMapper json;

    public QqIdentityClient(QqLoginProperties settings, ObjectMapper json) {
        this.settings = settings;
        this.json = json;
    }

    public record Identity(String openId, String nickname, String avatar) { }

    public Identity exchange(String code) {
        JsonNode token = read("https://graph.qq.com/oauth2.0/token?grant_type=authorization_code&fmt=json&client_id="
                + encode(settings.getAppId()) + "&client_secret=" + encode(settings.getAppKey())
                + "&redirect_uri=" + encode(settings.getCallbackUrl()) + "&code=" + encode(code));
        String accessToken = token.path("access_token").asText();
        if (!accessToken.matches("[A-Za-z0-9_-]{16,512}")) throw unavailable();
        JsonNode identity = read("https://graph.qq.com/oauth2.0/me?fmt=json&access_token=" + encode(accessToken));
        String openId = identity.path("openid").asText();
        if (!settings.getAppId().equals(identity.path("client_id").asText()) || !openId.matches("[A-Fa-f0-9]{32}")) {
            throw unavailable();
        }
        JsonNode profile = read("https://graph.qq.com/user/get_user_info?access_token=" + encode(accessToken)
                + "&oauth_consumer_key=" + encode(settings.getAppId()) + "&openid=" + encode(openId));
        String nickname = profile.path("nickname").asText().strip();
        if (!profile.has("ret") || profile.path("ret").asInt(-1) != 0 || nickname.isBlank()
                || nickname.length() > 100 || nickname.codePoints().anyMatch(Character::isISOControl)) throw unavailable();
        String avatar = profile.path("figureurl_qq_2").asText();
        if (avatar.isBlank()) avatar = profile.path("figureurl_qq_1").asText();
        return new Identity(openId.toUpperCase(Locale.ROOT), nickname, avatar(avatar));
    }

    private JsonNode read(String url) {
        try {
            JsonNode result = json.readTree(fetch(URI.create(url), 64 * 1024));
            if (result == null || !result.isObject()) throw unavailable();
            return result;
        } catch (IOException | IllegalArgumentException exception) {
            throw unavailable();
        }
    }

    private byte[] fetch(URI uri, int limit) throws IOException {
        var connection = (HttpURLConnection) uri.toURL().openConnection();
        connection.setConnectTimeout(5000);
        connection.setReadTimeout(8000);
        connection.setInstanceFollowRedirects(false);
        try {
            if (connection.getResponseCode() != 200) throw new IOException("Unexpected status");
            try (var body = connection.getInputStream()) {
                byte[] bytes = body.readNBytes(limit + 1);
                if (bytes.length > limit) throw new IOException("Response too large");
                return bytes;
            }
        } finally { connection.disconnect(); }
    }

    private String avatar(String url) {
        // 头像导入失败不否定已经验证的 QQ 身份；不抓取任意网址或跟随跳转。
        try {
            URI uri = URI.create(url);
            String host = uri.getHost();
            if (!"https".equals(uri.getScheme()) || host == null || !host.endsWith(".qlogo.cn")
                    || uri.getPort() != -1 || uri.getUserInfo() != null) return DefaultAvatar.value();
            byte[] bytes = fetch(uri, 512 * 1024);
            String type = bytes.length > 3 && bytes[0] == (byte) 0x89 && bytes[1] == 'P' ? "png" : "jpeg";
            return AvatarImageProcessor.normalize("data:image/" + type + ";base64," + Base64.getEncoder().encodeToString(bytes));
        } catch (IOException | IllegalArgumentException | AvatarImageProcessor.InvalidAvatarException exception) {
            return DefaultAvatar.value();
        }
    }

    static String encode(String value) { return URLEncoder.encode(value, StandardCharsets.UTF_8); }
    private AuthException unavailable() {
        return new AuthException(HttpStatus.BAD_GATEWAY, ApiErrorCode.AUTH_SERVICE_UNAVAILABLE, "无法完成 QQ 身份验证，请重新授权");
    }
}
