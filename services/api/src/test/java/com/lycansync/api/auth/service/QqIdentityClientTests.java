package com.lycansync.api.auth.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.lycansync.api.auth.model.QqConfiguration;
import org.junit.jupiter.api.Test;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.spy;

/**
 * 验证 QQ 身份导入时的头像选择和解码结果。
 *
 * @author Wreckloud
 * @since 2026-11-21
 */
class QqIdentityClientTests {
    private static final String LARGE = "https://q.qlogo.cn/large";
    private static final String SMALL = "https://q.qlogo.cn/small";
    private final List<String> downloads = new ArrayList<>();

    private String exchange(String large, String small, String valid) throws Exception {
        var client = spy(new QqIdentityClient(new ObjectMapper()));
        var png = new ByteArrayOutputStream();
        ImageIO.write(new BufferedImage(32, 32, BufferedImage.TYPE_INT_RGB), "png", png);
        doAnswer(call -> {
            URI uri = call.getArgument(0);
            if ("q.qlogo.cn".equals(uri.getHost())) {
                assertEquals(512 * 1024, (int) call.getArgument(1));
                downloads.add(uri.toString());
                return uri.toString().equals(valid) ? png.toByteArray() : new byte[]{1, 2, 3};
            }
            String body = switch (uri.getPath()) {
                case "/oauth2.0/token" -> "{\"access_token\":\"abcdefghijklmnop\"}";
                case "/oauth2.0/me" -> "{\"client_id\":\"12345\",\"openid\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\"}";
                case "/user/get_user_info" -> "{\"ret\":0,\"nickname\":\"test\",\"figureurl_qq_2\":\"" + large
                        + "\",\"figureurl_qq_1\":\"" + small + "\"}";
                default -> throw new AssertionError(uri.getPath());
            };
            return body.getBytes(StandardCharsets.UTF_8);
        }).when(client).fetch(any(URI.class), anyInt());
        return client.exchange("test", new QqConfiguration(true, "12345", "test",
                "https://example.com/api/auth/qq/callback")).avatar();
    }

    @Test
    void importsSmallAvatarAfterInvalidLargeImage() throws Exception {
        assertNotEquals(DefaultAvatar.value(), exchange(LARGE, SMALL, SMALL));
        assertEquals(List.of(LARGE, SMALL), downloads);
    }

    @Test
    void usesValidLargeAvatarImmediately() throws Exception {
        assertNotEquals(DefaultAvatar.value(), exchange(LARGE, SMALL, LARGE));
        assertEquals(List.of(LARGE), downloads);
    }

    @Test
    void usesRegistrationDefaultWhenBothReferencesAreIdenticalAndBroken() throws Exception {
        assertEquals(DefaultAvatar.value(), exchange(LARGE, LARGE, ""));
        assertEquals(List.of(LARGE), downloads);
    }

    @Test
    void importsLegacyHttpAvatarOverHttpsWithTheSamePathAndQuery() throws Exception {
        String httpAvatar = "http://q.qlogo.cn/qqapp/12345/test%2Fid/40?key=test%2Fkey";
        String httpsAvatar = "https://q.qlogo.cn/qqapp/12345/test%2Fid/40?key=test%2Fkey";
        assertNotEquals(DefaultAvatar.value(), exchange("http://q.qlogo.cn/large", httpAvatar, httpsAvatar));
        assertEquals(List.of(LARGE, httpsAvatar), downloads);
    }

    @Test
    void skipsUntrustedHttpAvatarUrls() throws Exception {
        assertEquals(DefaultAvatar.value(), exchange("http://q.qlogo.cn.example.test/large",
                "http://user@q.qlogo.cn/small", ""));
        assertEquals(List.of(), downloads);
    }
}
