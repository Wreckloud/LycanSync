package com.lycansync.api.auth.model;

import java.net.URI;

/**
 * 一次 QQ 授权使用的完整配置快照，密钥不进入日志或响应。
 *
 * @author Wreckloud
 * @since 2026-11-13
 */
public record QqConfiguration(boolean enabled, String appId, String appKey, String callbackUrl) {
    public String publicUrl() {
        URI callback = URI.create(callbackUrl);
        if (!appId.matches("[0-9]{5,20}") || appKey.isBlank() || appKey.length() > 128
                || appKey.codePoints().anyMatch(Character::isWhitespace)
                || appKey.codePoints().anyMatch(Character::isISOControl)
                || !"https".equals(callback.getScheme()) || callback.getHost() == null
                || callback.getUserInfo() != null || callback.getPort() != -1
                || callback.getQuery() != null || callback.getFragment() != null
                || !"/api/auth/qq/callback".equals(callback.getPath())) {
            throw new IllegalArgumentException("请填写有效的 App ID、App Key 和 HTTPS 回调地址，回调路径应为 /api/auth/qq/callback");
        }
        return "https://" + callback.getHost();
    }

    @Override
    public String toString() { return "QqConfiguration[enabled=" + enabled + "]"; }

    public String validationError() {
        try { publicUrl(); }
        catch (IllegalArgumentException exception) {
            return "请检查 App ID、App Key 和回调地址；回调地址需使用 HTTPS，路径为 /api/auth/qq/callback";
        }
        return "";
    }
}
