package com.lycansync.api.auth.service;

import com.lycansync.api.auth.dto.ProfileUpdateRequest;
import com.lycansync.api.auth.exception.AuthException;
import com.lycansync.api.auth.mapper.AuthMapper;
import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.auth.model.AuthUser;
import com.lycansync.api.common.image.AvatarImageProcessor;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.time.Instant;
import java.util.Base64;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * 个人资料保存与头像资源边界测试。
 *
 * @author Wreckloud
 * @since 2026-09-10
 */
class ProfileServiceTests {

    private static final UUID USER_ID = UUID.fromString("2d983469-4442-44f5-b5a8-f3819f16a611");
    private static final AuthenticatedUser USER = new AuthenticatedUser(USER_ID, "小狼", false);
    private static final Instant CREATED_AT = Instant.parse("2026-09-06T08:00:00Z");

    private AuthMapper mapper;
    private ProfileService profileService;

    @BeforeEach
    void setUp() {
        mapper = mock(AuthMapper.class);
        profileService = new ProfileService(mapper);
    }

    @Test
    void shouldStoreAndReturnNormalizedTransparentPng() throws IOException {
        BufferedImage image = new BufferedImage(2, 2, BufferedImage.TYPE_INT_ARGB);
        image.setRGB(0, 0, 0x00000000);
        image.setRGB(1, 1, 0x80ff0000);
        String avatar = pngDataUrl(image);
        String normalizedAvatar = AvatarImageProcessor.normalize(avatar);
        when(mapper.updateProfile(USER_ID, "透明头像", normalizedAvatar, null)).thenReturn(1);
        when(mapper.findUserProfile(USER_ID)).thenReturn(new AuthUser(USER_ID, "透明头像", normalizedAvatar, false, "", CREATED_AT));

        AuthUser updated = profileService.update(USER, new ProfileUpdateRequest("透明头像", avatar, null));

        assertThat(updated.avatar()).isEqualTo(normalizedAvatar).isNotEqualTo(avatar);
        verify(mapper).updateProfile(USER_ID, "透明头像", normalizedAvatar, null);
    }

    @Test
    void shouldAllowUnchangedBundledAvatarWhileSavingNickname() {
        String avatar = DefaultAvatar.value();
        when(mapper.updateProfile(USER_ID, "行者", avatar, "")).thenReturn(1);
        when(mapper.findUserProfile(USER_ID)).thenReturn(new AuthUser(USER_ID, "行者", avatar, false, "", CREATED_AT));
        assertThat(profileService.update(USER, new ProfileUpdateRequest("行者", avatar, "")).avatar()).isEqualTo(avatar);
    }

    @Test
    void shouldRejectPayloadLargerThanCroppedUploadBudget() {
        String avatar = "data:image/png;base64,"
                + Base64.getEncoder().encodeToString(new byte[2 * 1024 * 1024 + 1]);

        assertThatThrownBy(() -> profileService.update(USER, new ProfileUpdateRequest("小狼", avatar, null)))
                .isInstanceOf(AuthException.class)
                .hasMessage("裁剪后的头像数据过大，请重新裁剪后重试");
        verifyNoInteractions(mapper);
    }

    @Test
    void shouldRejectDamagedImagePayload() {
        assertThatThrownBy(() -> profileService.update(
                USER, new ProfileUpdateRequest("小狼", "data:image/png;base64,YWJj", null)))
                .isInstanceOf(AuthException.class)
                .hasMessage("头像文件无效");
        verifyNoInteractions(mapper);
    }

    @Test
    void shouldRejectImageLargerThanCroppedUploadDimensions() throws IOException {
        String avatar = pngDataUrl(new BufferedImage(1025, 256, BufferedImage.TYPE_INT_ARGB));
        assertThatThrownBy(() -> profileService.update(USER, new ProfileUpdateRequest("小狼", avatar, null)))
                .isInstanceOf(AuthException.class)
                .hasMessage("裁剪后的头像尺寸过大，请重新裁剪后重试");
        verifyNoInteractions(mapper);
    }

    @Test
    void shouldRejectImageWithMismatchedDeclaredFormat() throws IOException {
        String avatar = pngDataUrl(new BufferedImage(2, 2, BufferedImage.TYPE_INT_ARGB))
                .replace("data:image/png;", "data:image/jpeg;");
        assertThatThrownBy(() -> profileService.update(USER, new ProfileUpdateRequest("小狼", avatar, null)))
                .isInstanceOf(AuthException.class)
                .hasMessage("头像文件格式与声明不一致");
        verifyNoInteractions(mapper);
    }

    @Test
    void shouldSaveTrimmedSignatureAndReadStoredRegistrationDate() {
        AuthUser stored = new AuthUser(USER_ID, "小狼", "", false, "一起开黑\n一起看", CREATED_AT);
        when(mapper.updateProfile(USER_ID, "小狼", "", stored.signature())).thenReturn(1);
        when(mapper.findUserProfile(USER_ID)).thenReturn(stored);

        AuthUser updated = profileService.update(USER, new ProfileUpdateRequest(" 小狼 ", "", " 一起开黑\n一起看 "));

        assertThat(updated).isEqualTo(stored);
        assertThat(updated.createdAt()).isEqualTo(CREATED_AT);
    }

    @Test
    void shouldClearSignatureWithEmptyString() {
        when(mapper.updateProfile(USER_ID, "小狼", "", "")).thenReturn(1);
        when(mapper.findUserProfile(USER_ID)).thenReturn(new AuthUser(USER_ID, "小狼", "", false, "", CREATED_AT));

        assertThat(profileService.update(USER, new ProfileUpdateRequest("小狼", "", "  ")).signature()).isEmpty();
        verify(mapper).updateProfile(USER_ID, "小狼", "", "");
    }

    @Test
    void shouldKeepOmittedSignatureUnchanged() {
        when(mapper.updateProfile(USER_ID, "新昵称", "", null)).thenReturn(1);
        when(mapper.findUserProfile(USER_ID)).thenReturn(new AuthUser(USER_ID, "新昵称", "", false, "原签名", CREATED_AT));

        assertThat(profileService.update(USER, new ProfileUpdateRequest("新昵称", "", null)).signature()).isEqualTo("原签名");
        verify(mapper).updateProfile(USER_ID, "新昵称", "", null);
    }

    @Test
    void shouldRejectOversizedSignatureAndInvalidControlCharacters() {
        assertThatThrownBy(() -> profileService.update(USER, new ProfileUpdateRequest("小狼", "", "字".repeat(121))))
                .isInstanceOf(AuthException.class);
        assertThatThrownBy(() -> profileService.update(USER, new ProfileUpdateRequest("小狼", "", "签\u0000名")))
                .isInstanceOf(AuthException.class);
        verifyNoInteractions(mapper);
    }

    private String pngDataUrl(BufferedImage image) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        ImageIO.write(image, "png", output);
        return "data:image/png;base64," + Base64.getEncoder().encodeToString(output.toByteArray());
    }
}
