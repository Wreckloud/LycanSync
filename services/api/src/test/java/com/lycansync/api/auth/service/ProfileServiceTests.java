package com.lycansync.api.auth.service;

import com.lycansync.api.auth.dto.ProfileUpdateRequest;
import com.lycansync.api.auth.exception.AuthException;
import com.lycansync.api.auth.mapper.AuthMapper;
import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.auth.model.AuthUser;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.Base64;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * 头像格式与资源边界测试。
 *
 * @author Wreckloud
 * @since 2026-09-10
 */
class ProfileServiceTests {

    private static final UUID USER_ID = UUID.fromString("2d983469-4442-44f5-b5a8-f3819f16a611");
    private static final AuthenticatedUser USER = new AuthenticatedUser(USER_ID, "小狼", false);

    private AuthMapper mapper;
    private ProfileService profileService;

    @BeforeEach
    void setUp() {
        mapper = mock(AuthMapper.class);
        profileService = new ProfileService(mapper);
    }

    @Test
    void shouldAcceptProcessedTransparentPng() throws IOException {
        BufferedImage image = new BufferedImage(2, 2, BufferedImage.TYPE_INT_ARGB);
        image.setRGB(0, 0, 0x00000000);
        image.setRGB(1, 1, 0x80ff0000);
        String avatar = pngDataUrl(image);
        when(mapper.updateProfile(USER_ID, "透明头像", avatar)).thenReturn(1);

        AuthUser updated = profileService.update(USER, new ProfileUpdateRequest("透明头像", avatar));

        assertThat(updated.avatar()).isEqualTo(avatar);
        verify(mapper).updateProfile(USER_ID, "透明头像", avatar);
    }

    @Test
    void shouldRejectAvatarLargerThanStoredOutputLimit() {
        String avatar = "data:image/png;base64,"
                + Base64.getEncoder().encodeToString(new byte[512 * 1024 + 1]);

        assertThatThrownBy(() -> profileService.update(USER, new ProfileUpdateRequest("小狼", avatar)))
                .isInstanceOf(AuthException.class)
                .hasMessage("头像不能超过 512 KB");
        verifyNoInteractions(mapper);
    }

    @Test
    void shouldRejectDamagedImagePayload() {
        assertThatThrownBy(() -> profileService.update(
                USER, new ProfileUpdateRequest("小狼", "data:image/png;base64,YWJj")))
                .isInstanceOf(AuthException.class)
                .hasMessage("头像文件无效");
        verifyNoInteractions(mapper);
    }

    private String pngDataUrl(BufferedImage image) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        ImageIO.write(image, "png", output);
        return "data:image/png;base64," + Base64.getEncoder().encodeToString(output.toByteArray());
    }
}
